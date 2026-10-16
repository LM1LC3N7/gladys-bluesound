// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so
// the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS, SCENE_ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // --- Discovery and device lifecycle --------------------------------------------
  gladys.onScanRequest(() => app.publishDevices());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // --- Commands (transport, volume, mute, source, notification) ------------------
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // --- Scene actions --------------------------------------------------------------
  gladys.onSceneAction(SCENE_ACTIONS.PLAYBACK, (fields) => app.playbackAction(fields));
  gladys.onSceneAction(SCENE_ACTIONS.PLAY_PRESET, (fields) => app.playPreset(fields));
  gladys.onSceneAction(SCENE_ACTIONS.SELECT_SOURCE, async (fields) => {
    const { source, kind } = await app.selectSource(fields);
    return { source, kind };
  });
  gladys.onSceneAction(SCENE_ACTIONS.PLAY_URL, (fields) => app.playUrl(fields));
  gladys.onSceneAction(SCENE_ACTIONS.GROUP_ADD, (fields) => app.groupAdd(fields));
  gladys.onSceneAction(SCENE_ACTIONS.GROUP_REMOVE, (fields) => app.groupRemove(fields));
  gladys.onSceneAction(SCENE_ACTIONS.NOW_PLAYING, (fields) => app.getNowPlaying(fields));

  // --- Configuration screen buttons -----------------------------------------------
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onAction(ACTIONS.SOURCES, (fields) => app.listSources(fields));

  // --- Configuration changed by the user ------------------------------------------
  gladys.onConfigUpdated((config) => {
    logger?.info('Configuration updated: restarting');
    return app.start(config);
  });

  // --- Connection lifecycle: (re)start on every connection, pause while Gladys is away.
  gladys.on('connected', async () => {
    try {
      await app.start(await gladys.getConfig());
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
  gladys.on('disconnected', () => app.stop());
}
