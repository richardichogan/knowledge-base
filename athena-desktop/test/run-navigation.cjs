const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const profile = mkdtempSync(join(tmpdir(), 'athena-navigation-'));
try {
  const result = spawnSync(require('electron'), [join(__dirname, 'navigation.electron.cjs')], {
    stdio: 'inherit',
    env: { ...process.env, ATHENA_NAVIGATION_PROFILE: profile },
    timeout: 45000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
