// -----------------------------------------------------------------------------
// The integration itself: discovery (mDNS through the core + typed
// addresses), one live link per created player (src/player.js), the
// commands, the announcements, the scene triggers and actions, the buttons.
// index.js only wires the SDK handlers to it (src/handlers.js).
//
// No polling clock: each player is followed by its two long polls; the
// presets and inputs are read when the player says they changed (`prid`)
// or every half hour (inputs), never in a loop.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { contentOf, resumePlanOf, watchStep } from './announce.js';
import { BluosClient } from './bluos/client.js';
import { isLanIPv4, mdnsCandidates, playerIdOf } from './bluos/discovery.js';
import { BluosError } from './bluos/errors.js';
import { actionUrl } from './bluos/model.js';
import { normalizeConfig } from './config.js';
import { PACING, PLAYBACK_COMMANDS, SCAN_TIMEOUT_SECONDS } from './constants.js';
import {
  FEATURE,
  buildPlayerDevice,
  featureKey,
  ids,
  parseExternalId,
  playerOfDevice,
  playerStates,
  readingOf,
  sourceOptions,
} from './devices.js';
import { T } from './i18n.js';
import { PlayerLink } from './player.js';
import { findPreset, findSource } from './sources.js';
import { sceneEvents, transition } from './triggers.js';

const defaultTimers = { setTimeout, clearTimeout };

/** Same presets / inputs (what the source list is made of). */
const sameLists = (a, b) =>
  JSON.stringify([a?.presets ?? [], a?.inputs ?? []]) ===
  JSON.stringify([b?.presets ?? [], b?.inputs ?? []]);

const endpointOf = ({ host, port }) => `${String(host).toLowerCase()}:${port}`;

export class BluesoundApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'bluesound' }),
    now = Date.now,
    timers = defaultTimers,
    transport,
    sleep,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.transport = transport;
    this.sleep = sleep;
    this.config = normalizeConfig();
    /** external id -> the runtime state of a created player (see newEntry) */
    this.entries = new Map();
    /** player id -> what the last discovery read (to publish the source lists again) */
    this.discovered = new Map();
    this.generation = 0;
    this.discoveredAt = 0;
    this.discoveryKey = undefined;
    this.lastStatus = undefined;
    this.republishTimer = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    await this.stop();
    const generation = ++this.generation;
    this.config = normalizeConfig(raw);
    if (this.config.invalidHosts.length > 0) {
      this.logger.warn(`Ignored addresses at position ${this.config.invalidHosts.join(', ')}`);
    }
    this.reconcile();
    await this.updateStatus();
    const key = JSON.stringify(this.config.hosts);
    const stale = this.now() - this.discoveredAt >= PACING.DISCOVERY_TTL;
    if (generation === this.generation && (stale || key !== this.discoveryKey)) {
      await this.publishDevices().catch((err) =>
        this.logger.warn(`Discovery failed: ${err.message}`),
      );
    }
  }

  async stop() {
    this.generation += 1;
    this.timers.clearTimeout(this.republishTimer);
    this.republishTimer = undefined;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => this.dropEntry(entry)));
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async updateStatus() {
    const entries = [...this.entries.values()];
    if (this.config.invalidHosts.length > 0) {
      await this.setStatus(true, T.invalidHosts(this.config.invalidHosts));
    } else if (entries.length === 0) {
      await this.setStatus(true, T.noPlayer);
    } else {
      const online = entries.filter((e) => e.link.online !== false).length;
      await this.setStatus(true, T.ok({ total: entries.length, online }));
    }
  }

  // --- Players -----------------------------------------------------------------------

  newClient({ host, port }) {
    return new BluosClient({
      host,
      port,
      now: this.now,
      ...(this.transport ? { transport: this.transport } : {}),
      ...(this.sleep ? { sleep: this.sleep } : {}),
    });
  }

  /** The player devices the user created. */
  createdPlayers() {
    return (this.gladys.devices ?? []).filter((d) => parseExternalId(d.external_id));
  }

  newEntry(player) {
    const client = this.newClient(player);
    const entry = {
      player,
      client,
      memory: undefined,
      quietUntil: 0,
      presets: [],
      presetsPrid: undefined,
      presetsFailedAt: -Infinity,
      inputs: [],
      inputsAt: -Infinity,
      inputsTriedAt: -Infinity,
      refreshing: undefined,
      reading: undefined,
      statusAt: 0,
      announce: undefined,
      announceTimers: [],
      chain: Promise.resolve(),
    };
    entry.link = new PlayerLink({
      player,
      client,
      logger: this.logger,
      timers: this.timers,
      onUpdate: (_link, kind) => this.onUpdate(entry, kind),
      onOnline: (_link, online) => this.onOnline(entry, online),
    });
    return entry;
  }

  dropEntry(entry) {
    this.clearAnnouncement(entry);
    return entry.link.stop();
  }

  current(entry) {
    return this.entries.get(entry.player.externalId) === entry;
  }

  /** One live link per created player, at the address of its params. */
  reconcile() {
    const keep = new Set();
    for (const device of this.createdPlayers()) {
      const player = playerOfDevice(device);
      if (!player.host) {
        continue;
      }
      keep.add(player.externalId);
      const entry = this.entries.get(player.externalId);
      if (entry && endpointOf(entry.player) === endpointOf(player)) {
        entry.player.name = player.name;
        continue;
      }
      if (entry) {
        this.logger.info(`${player.name}: new address ${player.host}:${player.port}`);
        this.dropEntry(entry);
      }
      const fresh = this.newEntry(player);
      this.entries.set(player.externalId, fresh);
      fresh.link.start();
    }
    for (const [id, entry] of this.entries) {
      if (!keep.has(id)) {
        this.entries.delete(id);
        this.dropEntry(entry);
      }
    }
  }

  async deviceCreated(device) {
    if (parseExternalId(device?.external_id)) {
      this.reconcile();
      await this.updateStatus();
    }
  }

  async deviceDeleted() {
    this.reconcile();
    await this.updateStatus();
  }

  /** The entry of the player at `host:port`, by its address or the one it gives itself. */
  entryAt({ host, port }) {
    const key = endpointOf({ host, port });
    return [...this.entries.values()].find(
      (e) =>
        endpointOf(e.player) === key || (e.link.sync?.id && e.link.sync.id.toLowerCase() === key),
    );
  }

  // --- Live updates ----------------------------------------------------------------

  async onUpdate(entry, kind) {
    if (!this.current(entry)) {
      return;
    }
    if (kind === 'status') {
      entry.statusAt = this.now();
      this.refreshLists(entry);
    }
    await this.publishReading(entry);
    if (kind === 'status') {
      this.watchAnnouncement(entry);
    } else {
      // The followers of a group show its name: theirs changes with the leader's.
      for (const other of this.entries.values()) {
        const leader = other.link.sync?.leader;
        if (other !== entry && leader && this.entryAt(leader) === entry) {
          await this.publishReading(other);
        }
      }
    }
  }

  async onOnline(entry, online) {
    if (!this.current(entry)) {
      return;
    }
    await this.gladys
      .publishTransports([
        { external_id: entry.player.externalId, transport: online ? 'local' : 'unreachable' },
      ])
      .catch((err) => this.logger.warn(`Transport of ${entry.player.name} failed: ${err.message}`));
    if (!online) {
      await this.publishReading(entry);
    }
    await this.updateStatus();
  }

  /** "Zone Three + Zone Four", from the group's primary player. */
  groupLabel(entry) {
    const sync = entry.link.sync;
    if (!sync) {
      return '';
    }
    if (sync.followers.length > 0) {
      return sync.group || [sync.name, ...sync.followers.map((f) => f.name || f.host)].join(' + ');
    }
    if (sync.leader) {
      const leader = this.entryAt(sync.leader);
      return (
        leader?.link.sync?.group ||
        `${leader?.link.sync?.name || leader?.player.name || sync.leader.host} + ${sync.name || entry.player.name}`
      );
    }
    return '';
  }

  /** Publish the states and scene events of the last answers (one at a time per player). */
  publishReading(entry) {
    entry.chain = entry.chain.then(() => this.doPublishReading(entry)).catch(() => {});
    return entry.chain;
  }

  async doPublishReading(entry) {
    const { link } = entry;
    if (!this.current(entry) || (link.online && !link.status)) {
      return;
    }
    const id = entry.player.externalId;
    const reading = readingOf({
      online: link.online,
      status: link.status,
      sync: link.sync,
      presets: entry.presets,
      inputs: entry.inputs,
      group: this.groupLabel(entry),
    });
    entry.reading = reading;
    await this.gladys
      .publishChangedStates(playerStates(id, reading, sourceOptions(entry)), {
        heartbeat: 30 * 60_000,
      })
      .catch((err) => this.logger.warn(`States of ${entry.player.name} failed: ${err.message}`));
    const previous = entry.memory;
    const { memory, changes } = transition(previous, reading, {
      quiet: this.now() < entry.quietUntil,
    });
    entry.memory = memory;
    for (const event of sceneEvents({
      deviceId: id,
      name: entry.player.name,
      reading,
      previous,
      changes,
    })) {
      await this.gladys
        .publishSceneEvent(event.key, event.data)
        .catch((err) => this.logger.warn(`Scene event ${event.key} failed: ${err.message}`));
    }
  }

  /**
   * Read the presets when the player says they changed (`prid`), and the
   * inputs every half hour or when an unknown one plays. In the background,
   * one refresh at a time per player.
   */
  refreshLists(entry) {
    const status = entry.link.status;
    const now = this.now();
    // A new prid is read at once; after a failure, a minute later.
    const presetsDue =
      status &&
      status.prid !== entry.presetsPrid &&
      now - entry.presetsFailedAt >= PACING.INPUTS_RETRY;
    const unknownInput =
      status?.inputId && !entry.inputs.some((input) => input.id === status.inputId);
    const inputsDue =
      now - entry.inputsTriedAt >= PACING.INPUTS_RETRY &&
      (now - entry.inputsAt >= PACING.INPUTS_TTL || unknownInput);
    if (entry.refreshing || (!presetsDue && !inputsDue)) {
      return entry.refreshing;
    }
    const before = { presets: entry.presets, inputs: entry.inputs };
    entry.refreshing = (async () => {
      if (presetsDue) {
        try {
          entry.presets = (await entry.client.presets()).presets;
          entry.presetsPrid = status.prid;
          entry.presetsFailedAt = -Infinity;
        } catch (err) {
          entry.presetsFailedAt = now;
          this.logger.debug?.(`${entry.player.name}: presets unavailable (${err.message})`);
        }
      }
      if (inputsDue) {
        entry.inputsTriedAt = now;
        try {
          entry.inputs = await entry.client.inputs();
          entry.inputsAt = this.now();
        } catch (err) {
          this.logger.debug?.(`${entry.player.name}: inputs unavailable (${err.message})`);
        }
      }
      if (this.current(entry) && !sameLists(before, entry)) {
        await this.publishReading(entry);
        this.optionsChanged(entry);
      }
    })()
      .catch((err) => this.logger.warn(`Lists of ${entry.player.name} failed: ${err.message}`))
      .finally(() => {
        entry.refreshing = undefined;
      });
    return entry.refreshing;
  }

  /** New presets or inputs: the source list of the device follows, a little later. */
  optionsChanged(entry) {
    const known = this.discovered.get(parseExternalId(entry.player.externalId)?.id);
    if (!known || sameLists(known, entry)) {
      return;
    }
    known.presets = entry.presets;
    known.inputs = entry.inputs;
    if (this.republishTimer) {
      return;
    }
    this.republishTimer = this.timers.setTimeout(() => {
      this.republishTimer = undefined;
      this.republish().catch((err) => this.logger.warn(`Source lists failed: ${err.message}`));
    }, PACING.OPTIONS_DEBOUNCE);
  }

  /** Publish the last discovery again (Gladys updates the source lists of the created devices). */
  async republish() {
    const devices = [...this.discovered.values()].map((p) => buildPlayerDevice(this.gladys, p));
    await this.gladys.publishDiscoveredDevices(devices);
  }

  // --- Discovery -------------------------------------------------------------------

  async publishDevices() {
    const devices = await this.discover();
    await this.gladys.publishDiscoveredDevices(devices);
    // Gladys updates the params (a new address) of the created players
    // silently: read the devices back so the links follow.
    await this.gladys
      .getDevices()
      .catch((err) => this.logger.warn(`Reading the devices failed: ${err.message}`));
    this.discoveredAt = this.now();
    this.discoveryKey = JSON.stringify(this.config.hosts);
    this.reconcile();
    await this.updateStatus();
    return devices;
  }

  /** The players answering mDNS, the typed addresses and the created players, read once each. */
  async discover() {
    const candidates = new Map();
    const add = (candidate) => {
      const key = endpointOf(candidate);
      if (!candidates.has(key)) {
        candidates.set(key, candidate);
      }
    };
    try {
      const results = await this.gladys.scanNetwork('mdns', {
        timeoutSeconds: SCAN_TIMEOUT_SECONDS,
      });
      mdnsCandidates(results).forEach(add);
    } catch (err) {
      this.logger.warn(`mDNS scan unavailable (${err.message}): only the typed addresses are read`);
    }
    this.config.hosts.forEach(add);
    this.createdPlayers()
      .map(playerOfDevice)
      .filter((p) => p.host)
      .forEach(add);
    const players = await Promise.all(
      [...candidates.values()].map((candidate) =>
        this.probe(candidate).catch((err) => {
          this.logger.info(`No player read at ${candidate.host}:${candidate.port}: ${err.message}`);
          return undefined;
        }),
      ),
    );
    const found = new Map();
    for (const player of players) {
      if (player && !found.has(player.playerId)) {
        found.set(player.playerId, player);
      }
    }
    this.discovered = found;
    this.logger.info(`Discovery: ${found.size} player(s) found`);
    return [...found.values()].map((player) => buildPlayerDevice(this.gladys, player));
  }

  /** Read what a device needs from the player at host:port. */
  async probe({ host, port, name }) {
    const client = this.newClient({ host, port });
    try {
      const sync = await client.readSyncStatus();
      const presets = await client
        .presets()
        .then((answer) => answer.presets)
        .catch(() => []);
      const inputs = await client.inputs().catch(() => []);
      return {
        playerId: playerIdOf({ mac: sync.mac, host, port }),
        host,
        port,
        name: sync.name || name || `BluOS ${host}`,
        brand: sync.brand,
        model: sync.model,
        modelName: sync.modelName,
        version: sync.version,
        presets,
        inputs,
      };
    } finally {
      client.close();
    }
  }

  // --- Commands --------------------------------------------------------------------

  /** A created player by external id -> { entry, client, name }. */
  target(externalId) {
    const entry = this.entries.get(String(externalId ?? ''));
    if (!entry) {
      throw new Error(T.errors.unknownPlayer);
    }
    return { entry, client: entry.client, name: entry.player.name };
  }

  /** Error from the player -> a message for Gladys (never the URL). */
  commandError(name, err) {
    if (err instanceof BluosError) {
      if (err.unreachable) return new Error(T.errors.unreachable(name, err.message));
      return new Error(T.errors.refused(name, err.message));
    }
    return err;
  }

  /**
   * Run a command on a player: the changes it causes fire no scene event
   * (no loop through a scene bound to them).
   */
  async command(t, job) {
    t.entry.quietUntil = Math.max(t.entry.quietUntil, this.now() + PACING.QUIET);
    try {
      return await job();
    } catch (err) {
      throw this.commandError(t.name, err);
    }
  }

  async publishNow(states) {
    await this.gladys
      .publishChangedStates(states)
      .catch((err) => this.logger.warn(`States failed: ${err.message}`));
  }

  async setValue(device, feature, value) {
    const t = this.target(device.external_id);
    const id = t.entry.player.externalId;
    const key = featureKey(feature.external_id);
    const state = (k, v) => ({ device_feature_external_id: ids.feature(id, k), state: v });
    switch (key) {
      case FEATURE.PLAY:
        await this.playback(t, 'play');
        return;
      case FEATURE.PAUSE:
        await this.playback(t, 'pause');
        return;
      case FEATURE.NEXT:
        await this.playback(t, 'next');
        return;
      case FEATURE.PREVIOUS:
        await this.playback(t, 'previous');
        return;
      case FEATURE.VOLUME: {
        const answer = await this.setVolume(t, value);
        await this.publishNow([state(FEATURE.VOLUME, answer.volume ?? Number(value))]);
        return;
      }
      case FEATURE.MUTE: {
        // Gladys renders television / volume-mute as a button: each press toggles.
        const muted = !(t.entry.reading?.muted ?? false);
        const answer = await this.command(t, () => t.client.setMute(muted));
        await this.publishNow([state(FEATURE.MUTE, answer.muted ? 1 : 0)]);
        return;
      }
      case FEATURE.SOURCE: {
        const chosen = await this.selectSource({ player: id, source: String(value) });
        await this.publishNow([
          { device_feature_external_id: ids.feature(id, FEATURE.SOURCE), text: chosen.value },
        ]);
        return;
      }
      case FEATURE.PLAY_NOTIFICATION:
        await this.announce(t, String(value ?? ''), {
          volume: this.config.notificationVolume || undefined,
        });
        return;
      default:
        throw new Error(T.errors.readOnly(key));
    }
  }

  async setVolume(t, value) {
    if (t.entry.reading?.fixedVolume) {
      throw new Error(T.errors.fixedVolume(t.name));
    }
    const level = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    // tell_slaves=0: a device is one room, its volume moves that room only.
    return this.command(t, () => t.client.setVolume(level));
  }

  /** play, pause, toggle, stop, next, previous. */
  async playback(t, command) {
    const status = t.entry.link.status;
    switch (command) {
      case 'play':
        return this.command(t, () => t.client.play());
      case 'pause':
        return this.command(t, () => t.client.pause());
      case 'toggle':
        return this.command(t, () => t.client.pause({ toggle: true }));
      case 'stop':
        return this.command(t, () => t.client.stop());
      case 'next':
      case 'previous': {
        // A stream (radio, input) skips through the action /Status offers, if any.
        const name = command === 'next' ? 'skip' : 'back';
        if (status?.streamUrl !== undefined) {
          const url = actionUrl(status, name);
          if (!url) {
            throw new Error(command === 'next' ? T.errors.noSkip(t.name) : T.errors.noBack(t.name));
          }
          return this.command(t, () => t.client.action(url));
        }
        return this.command(t, () => (command === 'next' ? t.client.skip() : t.client.back()));
      }
      default:
        throw new Error(T.errors.unknownCommand(String(command).slice(0, 40)));
    }
  }

  /** The presets and inputs of a player, read now when none is known yet. */
  async listsOf(t, { fresh = false } = {}) {
    const { entry } = t;
    if (fresh || (entry.presets.length === 0 && entry.inputs.length === 0)) {
      try {
        entry.presets = (await t.client.presets()).presets;
        entry.inputs = await t.client.inputs();
        entry.inputsAt = this.now();
        this.optionsChanged(entry);
      } catch (err) {
        throw this.commandError(t.name, err);
      }
    }
    return { presets: entry.presets, inputs: entry.inputs };
  }

  // --- Announcements -------------------------------------------------------------------

  /**
   * Play `url` now (the TTS of Gladys, a chime...), at `volume` if given, then
   * put back the volume and what played before (src/announce.js).
   */
  async announce(t, url, { volume, resume = true } = {}) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(T.errors.badUrl);
    }
    if (!/^https?:$/.test(parsed.protocol) || url.length > 4000) {
      throw new Error(T.errors.badUrl);
    }
    const { entry } = t;
    const lists = { presets: entry.presets, inputs: entry.inputs };
    const live = entry.link.status;
    const status =
      live ??
      (await t.client.readStatus().catch((err) => {
        throw this.commandError(t.name, err);
      }));
    const elapsedMs = live ? this.now() - entry.statusAt : 0;
    const ongoing = entry.announce;
    const current = entry.link.sync?.volume ?? status?.volume;
    // A fixed-volume player (set in the BluOS app) keeps its level.
    const level =
      Number.isFinite(volume) && !entry.reading?.fixedVolume
        ? Math.max(0, Math.min(100, Math.round(volume)))
        : undefined;
    const announce = {
      before: contentOf(status),
      started: false,
      startedAt: this.now(),
      playing: undefined,
      // A second announcement during the first puts back what played before both.
      plan: ongoing ? ongoing.plan : resume ? resumePlanOf(status, lists, { elapsedMs }) : null,
      volumeBefore: ongoing
        ? ongoing.volumeBefore
        : level !== undefined && current !== undefined && level !== current
          ? current
          : undefined,
    };
    this.clearAnnouncement(entry);
    // Armed before sending: the status of the URL may come back before /Play does.
    entry.announce = announce;
    // No scene event while the announcement plays, nor right after.
    entry.quietUntil = Infinity;
    try {
      if (level !== undefined && level !== current) {
        await t.client.setVolume(level);
      }
      await t.client.playUrl(url);
    } catch (err) {
      this.clearAnnouncement(entry);
      entry.quietUntil = this.now() + PACING.QUIET;
      throw this.commandError(t.name, err);
    }
    // The live /Status drives the watch; these only make sure it ends.
    entry.announceTimers = [PACING.ANNOUNCE_START + 1_000, PACING.ANNOUNCE_MAX + 1_000].map((ms) =>
      this.timers.setTimeout(() => this.watchAnnouncement(entry), ms),
    );
    return { resumable: Boolean(announce.plan) };
  }

  clearAnnouncement(entry) {
    for (const timer of entry.announceTimers ?? []) {
      this.timers.clearTimeout(timer);
    }
    entry.announceTimers = [];
    entry.announce = undefined;
  }

  watchAnnouncement(entry) {
    if (!entry.announce || !this.current(entry)) {
      return;
    }
    const { announce, done } = watchStep(entry.announce, entry.link.status, this.now(), {
      startTimeout: PACING.ANNOUNCE_START,
      maxDuration: PACING.ANNOUNCE_MAX,
    });
    entry.announce = announce;
    if (done) {
      this.finishAnnouncement(entry, done).catch((err) =>
        this.logger.warn(
          `${entry.player.name}: resuming after the announcement failed (${err.message})`,
        ),
      );
    }
  }

  /** ended / not_started: volume and playback put back; replaced: the user took over. */
  async finishAnnouncement(entry, why) {
    const announce = entry.announce;
    this.clearAnnouncement(entry);
    entry.quietUntil = this.now() + PACING.QUIET;
    if (!announce || why === 'replaced') {
      return;
    }
    if (announce.volumeBefore !== undefined) {
      await entry.client.setVolume(announce.volumeBefore);
    }
    const plan = announce.plan;
    if (plan?.kind === 'input') {
      await entry.client.playUrl(plan.url);
    } else if (plan?.kind === 'preset') {
      await entry.client.loadPreset(plan.id);
    } else if (plan?.kind === 'queue') {
      await entry.client.playTrack({ id: plan.id, seek: plan.seek });
    }
    entry.quietUntil = this.now() + PACING.QUIET;
  }

  // --- Scene actions ---------------------------------------------------------------

  async playbackAction(fields = {}) {
    const t = this.target(fields.player);
    const command = String(fields.command ?? '').trim();
    if (!PLAYBACK_COMMANDS.includes(command)) {
      throw new Error(T.errors.unknownCommand(command.slice(0, 40)));
    }
    await this.playback(t, command);
  }

  async playPreset(fields = {}) {
    const t = this.target(fields.player);
    const query = String(fields.preset ?? '').trim();
    if (!query) {
      throw new Error(T.errors.noPreset);
    }
    let { presets } = await this.listsOf(t);
    let preset = findPreset(query, presets);
    if (!preset) {
      ({ presets } = await this.listsOf(t, { fresh: true }));
      preset = findPreset(query, presets);
    }
    if (!preset) {
      throw new Error(
        T.errors.unknownPreset(
          query.slice(0, 60),
          presets.map((p) => `${p.id}. ${p.name}`),
        ),
      );
    }
    await this.command(t, () => t.client.loadPreset(preset.id));
    return { preset: preset.id, preset_name: preset.name };
  }

  /** An input or a preset, by option value, name, number or input word. */
  async selectSource(fields = {}) {
    const t = this.target(fields.player);
    const query = String(fields.source ?? '').trim();
    if (!query) {
      throw new Error(T.errors.noSource);
    }
    let lists = await this.listsOf(t);
    let found = findSource(query, lists);
    if (!found) {
      lists = await this.listsOf(t, { fresh: true });
      found = findSource(query, lists);
    }
    if (!found) {
      throw new Error(
        T.errors.unknownSource(
          query.slice(0, 60),
          sourceOptions(lists).map((o) => o.label),
        ),
      );
    }
    if (found.kind === 'input') {
      await this.command(t, () => t.client.playUrl(found.input.url));
      return { source: found.input.name, kind: 'input', value: `input:${found.input.id}` };
    }
    await this.command(t, () => t.client.loadPreset(found.preset.id));
    return { source: found.preset.name, kind: 'preset', value: `preset:${found.preset.id}` };
  }

  async playUrl(fields = {}) {
    const t = this.target(fields.player);
    const volume =
      fields.volume === undefined || fields.volume === null || fields.volume === ''
        ? undefined
        : Number(fields.volume);
    const answer = await this.announce(t, String(fields.url ?? '').trim(), {
      volume: Number.isFinite(volume) ? volume : undefined,
      resume: fields.resume !== false,
    });
    return { resumable: answer.resumable };
  }

  /** The address a player gives itself (what /AddSlave needs), else the one Gladys knows. */
  async selfEndpoint(t) {
    const sync = t.entry.link.sync ?? (await t.client.readSyncStatus());
    const match = /^(.+):(\d{1,5})$/.exec(sync.id ?? '');
    return match
      ? { host: match[1], port: Number(match[2]) }
      : { host: t.entry.player.host, port: t.entry.player.port };
  }

  async groupAdd(fields = {}) {
    const member = this.target(fields.player);
    const leader = this.target(fields.leader);
    if (member.entry === leader.entry) {
      throw new Error(T.errors.samePlayer);
    }
    const endpoint = await this.selfEndpoint(member).catch((err) => {
      throw this.commandError(member.name, err);
    });
    const followers = await this.command(leader, () => leader.client.addFollower(endpoint));
    member.entry.quietUntil = this.now() + PACING.QUIET;
    if (!followers.some((f) => endpointOf(f) === endpointOf(endpoint))) {
      throw new Error(T.errors.notJoined(member.name));
    }
    return { group_size: followers.length + 1 };
  }

  /**
   * Take a player out of its group: a secondary one through its primary, a
   * primary one by removing itself (its secondaries regroup, API §8.3).
   */
  async groupRemove(fields = {}) {
    const t = this.target(fields.player);
    const sync =
      t.entry.link.sync ??
      (await t.client.readSyncStatus().catch((err) => {
        throw this.commandError(t.name, err);
      }));
    const self = await this.selfEndpoint(t);
    if (sync.leader) {
      const known = this.entryAt(sync.leader);
      if (!known && !isLanIPv4(sync.leader.host)) {
        throw new Error(T.errors.noLeaderAddress(t.name));
      }
      const client = known?.client ?? this.newClient(sync.leader);
      try {
        await this.command(t, () => client.removeFollower(self));
      } finally {
        if (!known) client.close();
      }
      return { was_grouped: true };
    }
    if (sync.followers.length > 0) {
      await this.command(t, () => t.client.removeFollower(self));
      return { was_grouped: true };
    }
    return { was_grouped: false };
  }

  async getNowPlaying(fields = {}) {
    const t = this.target(fields.player);
    const { entry } = t;
    // The live status, else (the link just started) a plain read.
    const status =
      entry.link.status ??
      (entry.link.online === false
        ? undefined
        : await t.client.readStatus().catch(() => undefined));
    const r = readingOf({
      online: entry.link.online !== false && Boolean(status),
      status,
      sync: entry.link.sync,
      presets: entry.presets,
      inputs: entry.inputs,
      group: this.groupLabel(entry),
    });
    return {
      online: Boolean(r.online),
      playing: r.playback === 'playing',
      state: r.playback ?? '',
      title: r.title ?? '',
      artist: r.artist ?? '',
      album: r.album ?? '',
      summary: r.summary ?? '',
      source: r.source?.name ?? '',
      kind: r.source?.kind ?? '',
      volume: r.volume ?? null,
      muted: Boolean(r.muted),
      group: r.group ?? '',
    };
  }

  // --- Configuration screen buttons --------------------------------------------------

  async testConnection() {
    const lines = { en: [], fr: [] };
    for (const entry of this.entries.values()) {
      const where = `${entry.player.name} (${entry.player.host}:${entry.player.port})`;
      try {
        const status = await entry.client.readStatus();
        const sync = await entry.client.readSyncStatus();
        const r = readingOf({
          online: true,
          status,
          sync,
          presets: entry.presets,
          inputs: entry.inputs,
        });
        const state = T.playback[r.playback ?? 'unknown'];
        const detail = [r.source?.name, sync.fixedVolume ? '' : `volume ${sync.volume ?? '?'}`]
          .filter(Boolean)
          .join(', ');
        lines.en.push(`${where}: ${state.en}${detail ? `, ${detail}` : ''}.`);
        lines.fr.push(`${where} : ${state.fr}${detail ? `, ${detail}` : ''}.`);
      } catch (err) {
        lines.en.push(`${where}: no answer (${err.message}).`);
        lines.fr.push(`${where} : pas de réponse (${err.message}).`);
      }
    }
    const created = new Set([...this.entries.values()].map((e) => endpointOf(e.player)));
    for (const host of this.config.hosts.filter((h) => !created.has(endpointOf(h)))) {
      const where = `${host.host}:${host.port}`;
      try {
        const player = await this.probe(host);
        lines.en.push(`${where}: ${player.name} answers; add it from Discovery.`);
        lines.fr.push(`${where} : ${player.name} répond ; ajoutez-le depuis Découverte.`);
      } catch (err) {
        lines.en.push(`${where}: no BluOS player answers (${err.message}).`);
        lines.fr.push(`${where} : aucun lecteur BluOS ne répond (${err.message}).`);
      }
    }
    await this.updateStatus();
    if (lines.en.length === 0) {
      return T.test.none;
    }
    return { en: lines.en.join('\n'), fr: lines.fr.join('\n') };
  }

  async listSources(fields = {}) {
    const t = this.target(fields.player);
    const { presets, inputs } = await this.listsOf(t, { fresh: true });
    const inputLines = inputs.map((i) => `- ${i.name}${i.inputType ? ` (${i.inputType})` : ''}`);
    const presetLines = presets.map((p) => `${p.id}. ${p.name}`);
    const none = { en: '(none)', fr: '(aucun)' };
    const block = (lang) =>
      [
        `${t.name}`,
        lang === 'en' ? 'Sources:' : 'Sources :',
        ...(inputLines.length ? inputLines : [none[lang]]),
        lang === 'en' ? 'Presets:' : 'Préréglages :',
        ...(presetLines.length ? presetLines : [none[lang]]),
      ].join('\n');
    return { en: block('en'), fr: block('fr') };
  }
}
