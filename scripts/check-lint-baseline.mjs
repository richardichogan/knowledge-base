import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';

const cwd = process.cwd();
const { ESLint } = createRequire(resolve(cwd, 'package.json'))('eslint');
const results = await new ESLint({ cwd }).lintFiles(['src/**/*.{ts,tsx}']);
const fingerprints = {};
const locations = new Map();
let violations = 0;
for (const result of results) {
  const source = await readFile(result.filePath, 'utf8');
  const lines = source.split(/\r?\n/);
  for (const message of result.messages) {
    if (message.fatal || message.ruleId === null) {
      console.error(`${relative(cwd, result.filePath)}:${message.line}: ${message.message}`);
      process.exitCode = 1;
      continue;
    }
    const fingerprint = createHash('sha256').update(JSON.stringify([
      relative(cwd, result.filePath).split(sep).join('/'), message.ruleId,
      message.message, lines[message.line - 1]?.trim(),
    ])).digest('hex');
    fingerprints[fingerprint] = (fingerprints[fingerprint] ?? 0) + 1;
    const matches = locations.get(fingerprint) ?? [];
    matches.push(`${relative(cwd, result.filePath)}:${message.line}:${message.column} ${message.message} (${message.ruleId})`);
    locations.set(fingerprint, matches);
    violations++;
  }
}
if (process.exitCode) process.exit(process.exitCode);
const baselinePath = resolve(cwd, '.eslint-baseline.json');
if (process.argv.includes('--update')) {
  await writeFile(baselinePath, `${JSON.stringify({ violations, fingerprints }, null, 2)}\n`);
  console.log(`Recorded ${violations} existing lint violations; review baseline changes before committing.`);
} else {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const added = Object.entries(fingerprints).reduce((n, [key, count]) => n + Math.max(0, count - (baseline.fingerprints[key] ?? 0)), 0);
  if (added > 0) {
    for (const [key, count] of Object.entries(fingerprints)) {
      const extra = count - (baseline.fingerprints[key] ?? 0);
      if (extra > 0) for (const location of locations.get(key).slice(0, extra)) console.error(location);
    }
    console.error(`${added} new or changed lint violations. Run npm run lint for locations; fix rather than refreshing the baseline.`);
    process.exitCode = 1;
  } else {
    console.log(`Lint non-regression passed (${violations} existing violations; baseline ${baseline.violations}).`);
  }
}
