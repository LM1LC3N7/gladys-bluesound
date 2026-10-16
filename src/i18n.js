// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, buttons, errors).
// Errors thrown to Gladys are English (one language per message, like the
// core's); the statuses and button answers are { en, fr }.
// -----------------------------------------------------------------------------

const plural = (n, one, many) => (n === 1 ? one : many);

export const T = {
  ok: ({ total, online }) =>
    online === total
      ? {
          en: `${total} ${plural(total, 'player answers', 'players answer')} on the local network.`,
          fr: `${total} ${plural(total, 'lecteur répond', 'lecteurs répondent')} sur le réseau local.`,
        }
      : {
          en: `${online} of ${total} players answer; the others are unplugged, out of reach or have a new address (open Discovery).`,
          fr: `${online} lecteur(s) sur ${total} répondent ; les autres sont débranchés, injoignables ou ont changé d'adresse (ouvrez Découverte).`,
        },
  noPlayer: {
    en: 'No player yet: open Discovery (players answering mDNS, plus the addresses typed in the configuration) and add yours.',
    fr: 'Aucun lecteur pour l’instant : ouvrez Découverte (lecteurs qui répondent en mDNS, plus les adresses saisies dans la configuration) et ajoutez le vôtre.',
  },
  invalidHosts: (positions) => ({
    en: `Ignored address(es) in the configuration, position ${positions.join(', ')}: type an IP or a host name, with an optional :port.`,
    fr: `Adresse(s) ignorée(s) dans la configuration, position ${positions.join(', ')} : saisissez une IP ou un nom d'hôte, avec un :port facultatif.`,
  }),
  errors: {
    unknownPlayer: 'Unknown player: pick a player device of this integration',
    readOnly: (key) => `${key} is read only`,
    unreachable: (name, message) => `${name} does not answer (${message}): is it plugged in?`,
    refused: (name, message) => `${name} refused the command (${message})`,
    fixedVolume: (name) => `${name} has a fixed volume (set in the BluOS app)`,
    noSkip: (name) => `${name}: the current source cannot skip tracks`,
    noBack: (name) => `${name}: the current source cannot go back`,
    noPreset: 'No preset given',
    unknownPreset: (query, presets) =>
      `No preset "${query}" on this player; presets: ${presets.join(', ') || 'none'}`,
    noSource: 'No source given',
    unknownSource: (query, sources) =>
      `Unknown source "${query}" on this player; sources: ${sources.join(', ') || 'none'}`,
    badUrl: 'The address must be an http:// or https:// URL',
    unknownCommand: (command) => `Unknown command "${command}"`,
    samePlayer: 'A player cannot join itself',
    notJoined: (name) => `${name} did not join the group (is it on the same network?)`,
    noLeaderAddress: (name) =>
      `${name}: the primary player of its group is not on the local network`,
  },
  test: {
    none: {
      en: 'No player to test: create one from Discovery, or type its address in the configuration.',
      fr: 'Aucun lecteur à tester : créez-en un depuis Découverte, ou saisissez son adresse dans la configuration.',
    },
  },
  playback: {
    playing: { en: 'playing', fr: 'en lecture' },
    paused: { en: 'paused', fr: 'en pause' },
    stopped: { en: 'stopped', fr: 'arrêté' },
    unknown: { en: 'waiting', fr: 'en attente' },
  },
};
