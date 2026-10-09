import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['tests/diagram-metadata.test.tsx'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  define: { 'import.meta.env': '{}' },
});
const run = spawnSync(process.execPath, ['-'], {
  input: result.outputFiles[0].text,
  encoding: 'utf8',
  timeout: 30_000,
});
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
