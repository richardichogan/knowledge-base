import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import bridgeModule from '../../athena-desktop/build/src/elgatoBridge.js';
import protocol from '../../athena-desktop/build/src/elgatoProtocol.js';

test('packaged SDK plugin registers, authenticates, routes keys and never replays offline presses', { timeout: 25_000 }, async () => {
  const token = 'a'.repeat(64);
  let state = { protocol: 1, presentation: protocol.initialPresentation(), recording: false, transcribing: false, error: null };
  const commands = [];
  const bridge = new bridgeModule.ElgatoBridge(async request => {
    commands.push(request.command);
    if (request.command === 'speak') state.recording = !state.recording;
    else if (request.command === 'stop-presenting') state.presentation = { ...state.presentation, displayId: null, status: 'disconnected' };
    else state.presentation = protocol.playbackCommand(state.presentation, request.command);
  }, () => state);
  await bridge.start(token, 0);
  const bridgePort = bridge.server.address().port;
  const host = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(host, 'listening');
  const info = {
    application: { font: 'Segoe UI', language: 'en', platform: 'windows', platformVersion: '10', version: '7.4.2.22730' },
    colors: {}, devicePixelRatio: 1,
    devices: [{ id: 'fixture-device', name: 'Fixture', size: { columns: 5, rows: 3 }, type: 0 }],
    plugin: { uuid: 'com.themicrosoftcloudblog.athena', version: '0.1.0.0' },
  };
  const messages = [];
  let socket;
  const event = (type, command, context) => ({
    event: type, action: `com.themicrosoftcloudblog.athena.${command}`, context, device: 'fixture-device',
    payload: { controller: 'Keypad', coordinates: { column: 0, row: 0 }, settings: {}, isInMultiAction: false, state: 0 },
  });
  host.on('connection', client => {
    socket = client;
    client.on('message', data => {
      const message = JSON.parse(data.toString());
      messages.push(message);
      if (message.event === 'getGlobalSettings') {
        client.send(JSON.stringify({ event: 'didReceiveGlobalSettings', id: message.id, payload: { settings: { token } } }));
        client.send(JSON.stringify(event('willAppear', 'faster', 'pace-key')));
        client.send(JSON.stringify(event('willAppear', 'speak', 'voice-key')));
        for (const command of protocol.COMMANDS.filter(command => !['faster', 'speak'].includes(command))) {
          client.send(JSON.stringify(event('willAppear', command, `${command}-key`)));
        }
      }
    });
  });
  const child = fork(fileURLToPath(new URL('./plugin-child.cjs', import.meta.url)), [
    new URL('../com.themicrosoftcloudblog.athena.sdPlugin/bin/plugin.js', import.meta.url).href,
    '-port', String(host.address().port), '-pluginUUID', info.plugin.uuid,
    '-registerEvent', 'registerPlugin', '-info', JSON.stringify(info),
  ], { cwd: fileURLToPath(new URL('../com.themicrosoftcloudblog.athena.sdPlugin', import.meta.url)), silent: true,
    env: { ...process.env, ATHENA_TEST_BRIDGE_PORT: String(bridgePort) } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const waitFor = async predicate => {
    const end = Date.now() + 8000;
    while (!predicate()) {
      if (child.exitCode !== null) assert.fail(`Plugin exited unexpectedly: ${stderr}`);
      if (Date.now() > end) assert.fail(`Plugin did not respond: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const title = (context, text) => messages.some(m => m.event === 'setTitle' && m.context === context && m.payload.title.includes(text));
  try {
    await waitFor(() => title('pace-key', '80 px/s'));
    assert.ok(messages.some(m => m.event === 'registerPlugin'));
    socket.send(JSON.stringify(event('keyDown', 'faster', 'pace-key')));
    await waitFor(() => title('pace-key', '90 px/s'));
    assert.deepEqual(commands, ['faster']);
    state.presentation = { ...state.presentation, sessionId: 'test-session', displayId: 42 };
    socket.send(JSON.stringify(event('keyDown', 'play', 'play-key')));
    await waitFor(() => title('play-key', 'playing'));
    for (const command of protocol.COMMANDS.filter(command => command !== 'speak')) {
      const context = command === 'faster' ? 'pace-key' : `${command}-key`;
      const image = messages.filter(message => message.event === 'setImage' && message.context === context).at(-1);
      assert.ok(image, `Missing image for ${command}`);
      assert.equal(image.payload.image, `imgs/${command}${['play', 'toggle-play', 'stop'].includes(command) ? '-active' : ''}.svg`);
    }
    socket.send(JSON.stringify(event('keyDown', 'pause', 'pause-key')));
    await waitFor(() => title('play-key', 'paused'));
    assert.equal(messages.filter(message => message.event === 'setImage' && message.context === 'play-key').at(-1).payload.image, 'imgs/play.svg');
    socket.send(JSON.stringify(event('keyDown', 'speak', 'voice-key')));
    await waitFor(() => title('voice-key', 'Recording'));
    assert.equal(state.recording, true);
    socket.send(JSON.stringify(event('keyDown', 'stop-presenting', 'stop-presenting-key')));
    await waitFor(() => commands.includes('stop-presenting') && title('play-key', 'disconnected'));
    assert.equal(state.presentation.displayId, null);
    assert.equal(state.recording, true);
    await bridge.stop();
    socket.send(JSON.stringify(event('keyDown', 'faster', 'pace-key')));
    await waitFor(() => messages.some(m => m.event === 'showAlert' && m.context === 'pace-key'));
    const count = commands.length;
    messages.length = 0;
    await bridge.start(token, bridgePort);
    await waitFor(() => title('pace-key', '90 px/s'));
    assert.equal(commands.length, count);
    assert.doesNotMatch(stderr, /Dynamic require/);
  } finally {
    if (child.connected) child.send('shutdown');
    if (child.exitCode === null) await once(child, 'exit');
    for (const client of host.clients) client.close();
    await new Promise(resolve => host.close(resolve));
    await bridge.stop();
  }
});
