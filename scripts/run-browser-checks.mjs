import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';

const web = resolve(import.meta.dirname, '../knowledge-hub-web');
const allowedModes = ['navigation', 'discover', 'today', 'auth-session', 'auth-callback', 'note-history', 'markdown-export', 'diagram-theme'];
const selection = process.argv.find(argument => argument.startsWith('--modes='));
const modes = selection === undefined ? ['navigation', 'discover', 'today'] : selection.slice('--modes='.length).split(',');
if (modes.length === 0 || modes.some(mode => !allowedModes.includes(mode))) throw new Error('Select only supported isolated browser fixture modes.');
const reservation = createServer();
reservation.listen(5197, '127.0.0.1');
await once(reservation, 'listening');
await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
const vite = spawn(process.execPath, [resolve(web, 'node_modules/vite/bin/vite.js'), '--config', 'tests/vite.fixture.config.ts',
  '--host', '127.0.0.1', '--port', '5197', '--strictPort'], { cwd: web, stdio: ['ignore', 'inherit', 'inherit'] });
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
  for (const mode of modes) {
    const child = spawn(process.execPath, [resolve(web, 'tests/run-today-browser.mjs')], {
      cwd: web, stdio: 'inherit',
      env: { ...process.env, ATHENA_BROWSER_CHECKS: mode, TODAY_FIXTURE_URL: `http://127.0.0.1:5197/tests/${mode}.html` },
    });
    const [code] = await once(child, 'exit');
    if (code !== 0) throw new Error(`${mode} browser checks failed (${code})`);
  }
} finally {
  if (vite.exitCode === null) {
    const exited = once(vite, 'exit');
    vite.kill();
    await exited;
  }
}
