import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const backend = resolve(import.meta.dirname, '../knowledge-hub-backend');
const web = resolve(import.meta.dirname, '../knowledge-hub-web');
const frontend = process.argv.includes('--frontend');
const tests = frontend ? [
  '../knowledge-hub-web/tests/noteText.test.ts',
  '../knowledge-hub-web/tests/knowledgeHealthModel.test.ts',
  '../knowledge-hub-web/tests/socialLength.test.ts',
  '../knowledge-hub-web/tests/completionNotification.test.ts',
  '../knowledge-hub-web/tests/athenaMotion.test.tsx',
  '../knowledge-hub-web/tests/athenaMarkElement.test.ts',
  '../knowledge-hub-web/tests/athenaRibbonElement.test.ts',
  '../knowledge-hub-web/tests/athenaMood.test.tsx',
  '../knowledge-hub-web/tests/replyReferences.test.tsx',
  '../knowledge-hub-web/tests/graphAtlas.test.ts',
  '../knowledge-hub-web/tests/atlasData.test.ts',
  '../knowledge-hub-web/tests/atlasElement.test.ts',
  '../knowledge-hub-web/tests/diagramUsability.test.ts',
  '../knowledge-hub-web/tests/imageClipboard.test.ts',
  '../knowledge-hub-web/tests/spellingTarget.test.ts',
  '../knowledge-hub-web/tests/presentation.test.ts',
  '../knowledge-hub-web/tests/composerIntent.test.ts',
  '../knowledge-hub-web/tests/dailyInsightsSource.test.ts',
  '../knowledge-hub-web/tests/localSyncDailyInsights.test.ts',
  '../knowledge-hub-web/tests/desktopJobs.test.ts',
  '../knowledge-hub-web/tests/people.test.ts',
  '../knowledge-hub-web/tests/entityLinks.test.ts',
  '../knowledge-hub-web/tests/commandPaletteItems.test.ts',
  '../knowledge-hub-web/tests/todayViewModel.test.ts',
  '../knowledge-hub-web/tests/navigation.test.ts',
  '../knowledge-hub-web/tests/documentTitle.test.ts',
  '../knowledge-hub-web/tests/appDialogs.test.ts',
  '../knowledge-hub-web/tests/projectFormValidation.test.ts',
  '../knowledge-hub-web/tests/projectIdentity.test.ts',
  '../knowledge-hub-web/tests/apiError.test.ts',
  '../knowledge-hub-web/tests/diagramTheme.test.ts',
  '../knowledge-hub-web/tests/diagramSelectionStyle.test.ts',
  '../knowledge-hub-web/tests/diagramMural.test.ts',
  '../knowledge-hub-web/tests/diagramLineJumps.test.ts',
  '../knowledge-hub-web/tests/diagramAiFlow.test.ts',
  '../knowledge-hub-web/tests/canvasHierarchy.test.ts',
  '../knowledge-hub-web/tests/note-filename.test.ts',
  '../knowledge-hub-web/tests/planInsights.test.ts',
  '../knowledge-hub-web/tests/syncPolling.test.ts',
  '../knowledge-hub-web/tests/planPreferences.test.ts',
  '../knowledge-hub-web/tests/useCaseView.test.ts',
  '../knowledge-hub-web/tests/savedViews.test.ts',
  '../knowledge-hub-web/tests/noteDraftStorage.test.ts',
  '../knowledge-hub-web/tests/documentList.test.ts',
  '../knowledge-hub-web/tests/blogPostEditor.test.tsx',
  '../knowledge-hub-web/tests/youtubeEvidence.test.tsx',
  '../knowledge-hub-web/tests/projectOptions.test.ts',
  '../knowledge-hub-web/tests/decisionSemantics.test.tsx',
  '../knowledge-hub-web/tests/thinkLocation.test.ts',
] : [
  'scripts/managed-jobs.test.ts',
  'scripts/designs.test.ts',
  'scripts/document-review.test.ts',
  'scripts/publishing.test.ts',
  'scripts/publishing-api.test.ts',
  'scripts/managed-jobs-api.test.ts',
  'scripts/memory-suggestions.test.ts',
  'scripts/graph-atlas.test.ts',
  'scripts/demo-specification.test.ts',
  'scripts/diagram-layout.test.ts',
  'scripts/company-relationships.test.ts',
  'scripts/youtube-discovery.test.ts',
  'scripts/share-email.test.ts',
  'scripts/linkedin.test.ts',
  'scripts/linkedin-draft.test.ts',
  'scripts/bluesky.test.ts',
  'scripts/mural.test.ts',
  'scripts/focused-context.test.ts',
  'scripts/project-context.test.ts',
  'scripts/chat-session-store.test.ts',
  'scripts/chat-references.test.ts',
  'scripts/daily-insights.test.ts',
  'scripts/knowledge-manifest.test.ts',
  'scripts/knowledge-evidence.test.ts',
  'scripts/document-reading.test.ts',
  'scripts/athena-dialogue.test.ts',
  'scripts/knowledge-read.test.ts',
  'scripts/knowledge-safety.test.ts',
  'scripts/knowledge-context.test.ts',
  'scripts/knowledge-readonly.test.ts',
  'scripts/knowledge-idx-spec.test.ts',
  'scripts/knowledge-traversal.test.ts',
  'scripts/knowledge-wiring.test.ts',
  'scripts/discover-parking.test.ts',
  'scripts/people.test.ts',
  'scripts/project-parents-migration.test.ts',
  'scripts/note-links.test.ts',
  'scripts/discover-watchlists.test.ts',
  'scripts/note-history.test.ts', 'scripts/build.test.ts', 'scripts/turn-jobs.test.ts',
  'scripts/task-calendar.test.ts', 'scripts/today-activity.test.ts',
  'scripts/note-list.test.ts',
  'scripts/runtime.test.ts',
  'scripts/discover-views.test.ts',
  'scripts/knowledge-health.test.ts',
  'scripts/knowledge-monitoring.test.ts',
  'scripts/knowledge-search.test.ts',
  'scripts/retrieval-scope.test.ts',
  'scripts/discovery-context.test.ts',
  'scripts/knowledge-structured.test.ts',
  'scripts/knowledge-indexing.test.ts',
  'scripts/knowledge-indexing-switch.test.ts',
  'scripts/project-cockpit.test.ts',
  'scripts/review-packets.test.ts',
  'scripts/use-cases.test.ts',
  'scripts/plan-review.test.ts',
  'scripts/plan-nudges.test.ts',
  'scripts/blog-quick-take.test.ts',
  'scripts/blog-publishing.test.ts',
  'scripts/podcast-prep.test.ts',
  'scripts/email-account-connections.test.ts',
  'scripts/alliance-mail.test.ts',
  'scripts/spark-grounding.test.ts',
  'scripts/diagram-drilldown.test.ts',
  'scripts/canvas-recycle-bin.test.ts',
  'scripts/ai-flow.test.ts',
  'scripts/local-documents.test.ts',
  'scripts/knowledge-fixtures.test.ts',
  'scripts/semantic-entities.test.ts',
  'scripts/semantic-rules.test.ts',
  'scripts/semantic-decisions.test.ts',
  'scripts/semantic-routes.test.ts',
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

if (frontend) {
  // UI imports need Vite's env replacement and a stylesheet stub. Keep the
  // bundle in memory so isolated runs never leave generated test files behind.
  const require = createRequire(resolve(web, 'package.json'));
  const { build } = require('esbuild');
  for (const entry of ['tests/note-list.test.tsx', 'tests/discoverParking.test.tsx', 'tests/watchlistFailure.test.tsx', 'tests/knowledgeSources.test.tsx', 'tests/linkedinPublishing.test.tsx', 'tests/jobsReview.test.tsx', 'tests/publishingFeeds.test.tsx', 'tests/design-artifact.test.tsx', 'tests/document-review.test.tsx']) {
    const bundle = await build({
      absWorkingDir: web,
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      define: { 'import.meta.env': '{}' },
      loader: { '.scss': 'empty' },
    });
    const bundled = spawnSync(process.execPath, ['-'], {
      cwd: web,
      env,
      input: bundle.outputFiles[0].text,
      stdio: ['pipe', 'inherit', 'inherit'],
      timeout: 30_000,
    });
    if (bundled.error) throw bundled.error;
    if (bundled.status !== 0) process.exitCode = bundled.status ?? 1;
  }
}
