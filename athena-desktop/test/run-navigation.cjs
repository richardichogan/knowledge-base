const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

for (const mode of ['workspace', 'chat']) {
  const profile = mkdtempSync(join(tmpdir(), 'athena-navigation-'));
  try {
    const args = [join(__dirname, 'navigation.electron.cjs')];
    if (mode === 'chat') args.push('--chat');
    const result = spawnSync(require('electron'), args, {
      stdio: 'inherit',
      env: { ...process.env, ATHENA_NAVIGATION_PROFILE: profile },
      timeout: 45000,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    if (process.exitCode !== 0) break;
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
