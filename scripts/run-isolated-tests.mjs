import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const backend = resolve(import.meta.dirname, '../knowledge-hub-backend');
const frontend = process.argv.includes('--frontend');
const tests = frontend ? [
  '../knowledge-hub-web/tests/todayViewModel.test.ts',
  '../knowledge-hub-web/tests/navigation.test.ts',
  '../knowledge-hub-web/tests/appDialogs.test.ts',
  '../knowledge-hub-web/tests/projectFormValidation.test.ts',
  '../knowledge-hub-web/tests/apiError.test.ts',
  '../knowledge-hub-web/tests/diagramTheme.test.ts',
  '../knowledge-hub-web/tests/note-filename.test.ts',
  '../knowledge-hub-web/tests/planInsights.test.ts',
  '../knowledge-hub-web/tests/syncPolling.test.ts',
  '../knowledge-hub-web/tests/planPreferences.test.ts',
  '../knowledge-hub-web/tests/savedViews.test.ts',
  '../knowledge-hub-web/tests/noteDraftStorage.test.ts',
] : [
  'scripts/note-history.test.ts', 'scripts/build.test.ts', 'scripts/turn-jobs.test.ts',
  'scripts/task-calendar.test.ts', 'scripts/today-activity.test.ts',
  'scripts/note-list.test.ts',
  'scripts/runtime.test.ts',
  'scripts/discover-views.test.ts',
  'scripts/knowledge-health.test.ts',
  'scripts/project-cockpit.test.ts',
  'scripts/review-packets.test.ts',
  'scripts/plan-review.test.ts',
];
// Do not inherit local integration credentials or let dotenv load application settings.
const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'COMSPEC', 'PATHEXT']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
Object.assign(env, {
  NODE_ENV: 'test', DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
  DOTENV_CONFIG_PATH: resolve(backend, '__isolated_tests_no_dotenv__'),
});
const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--test', '--test-force-exit', ...tests],
  { cwd: backend, env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
