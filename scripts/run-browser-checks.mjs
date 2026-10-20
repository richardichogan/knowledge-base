import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:net';

const web = resolve(import.meta.dirname, '../knowledge-hub-web');
const allowedModes = ['share-email', 'panel-typography', 'navigation', 'chat', 'project-pickers', 'watchlist-projects', 'discover', 'sparks', 'today', 'podcast-prep', 'auth-session', 'auth-callback', 'note-history', 'note-recovery', 'note-popout', 'note-links', 'watchlists', 'markdown-export', 'diagram-theme', 'diagram', 'diagram-properties', 'diagram-drilldown', 'diagram-line-jumps'];
const selection = process.argv.find(argument => argument.startsWith('--modes='));
const modes = selection === undefined ? ['navigation', 'discover', 'today', 'chat'] : selection.slice('--modes='.length).split(',');
if (modes.length === 0 || modes.some(mode => !allowedModes.includes(mode))) throw new Error('Select only supported isolated browser fixture modes.');
// Locally, default to Playwright's headless Chromium shell: it is windowless and never asks for the Keychain.
if (!process.env.TODAY_BROWSER_PATH) {
  const cache = process.platform === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright') : join(homedir(), '.cache/ms-playwright');
  const shells = existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const shell of shells) {
    const dir = join(cache, shell);
    const candidate = readdirSync(dir).map(sub => join(dir, sub, 'chrome-headless-shell')).find(existsSync);
    if (candidate) { process.env.TODAY_BROWSER_PATH = candidate; break; }
  }
}
const reservation = createServer();
reservation.listen(5197, '127.0.0.1');
await once(reservation, 'listening');
await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
const vite = spawn(process.execPath, [resolve(web, 'node_modules/vite/bin/vite.js'), '--config', 'tests/vite.fixture.config.ts',
  '--mode', 'test', '--host', '127.0.0.1', '--port', '5197', '--strictPort'], { cwd: web, stdio: ['ignore', 'inherit', 'inherit'] });
let started = false;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (vite.exitCode !== null) throw new Error('Isolated Vite fixture server exited before readiness');
    try {
      const response = await fetch('http://127.0.0.1:5197/tests/navigation.html');
      if (response.ok) { started = true; break; }
    } catch { /* bounded startup wait */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!started) throw new Error('Fixture server did not become ready');
  const failures = [];
  for (const mode of modes) {
    const diagram = mode === 'diagram' || mode === 'diagram-properties' || mode === 'diagram-drilldown' || mode === 'diagram-line-jumps';
    const child = spawn(process.execPath, [resolve(web, diagram ? 'tests/run-diagram-browser.mjs' : 'tests/run-today-browser.mjs')], {
      cwd: web, stdio: 'inherit',
      env: { ...process.env, ATHENA_BROWSER_CHECKS: mode, TODAY_FIXTURE_URL: `http://127.0.0.1:5197/tests/${mode === 'project-pickers' || mode === 'chat' ? 'navigation' : mode === 'watchlist-projects' ? 'watchlists' : mode}.html${mode === 'chat' ? '?chat-only=1' : ''}`,
        ...(process.env.TODAY_ARTIFACT_DIR ? { TODAY_ARTIFACT_DIR: resolve(process.env.TODAY_ARTIFACT_DIR, mode) } : {}),
        DIAGRAM_FIXTURE_URL: 'http://127.0.0.1:5197/tests/diagram.html' },
    });
    const [code] = await once(child, 'exit');
    if (code !== 0) {
      const failure = `${mode} browser checks failed (${code})`;
      console.error(failure);
      failures.push(failure);
    }
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
} finally {
  if (vite.exitCode === null) {
    const exited = once(vite, 'exit');
    vite.kill();
    await exited;
  }
}
