import { registerSpecialist } from '../registry.js';
import { NotFoundError, ValidationError } from '../../types/errors.js';
import { captureDailyInsights } from '../../services/dailyInsights.js';
import {
  dailyInsightsImportSpecialist, dailyInsightsStageStore, deleteStagedDailyInsightsImport, getStagedDailyInsightsImport, parseDailyInsightsImportInput,
  resolveDailyInsightsImport,
} from '../../services/dailyInsightsImport.js';
import { extractDailyInsights } from '../../services/dailyInsightsExtraction.js';

registerSpecialist({
  id: dailyInsightsImportSpecialist.id,
  name: 'Metis — Work Analyst',
  description: 'Processes staged M365 Daily Insights reports. Imports only clearly supported actions assigned to Richard, compares actions with every task status including completed and rejected/archived work, and reports ambiguous candidates without creating tasks. Task, diary, and knowledge persistence remains deterministic and revision-safe.',
  subjectType: dailyInsightsImportSpecialist.subjectType,
  resolveSubject: resolveDailyInsightsImport,
  parseInput: parseDailyInsightsImportInput,
  run: async context => {
    const importId = context.input['importId'];
    if (typeof importId !== 'string') throw new ValidationError('Metis requires a valid staged Daily Insights report.');
    const staged = await getStagedDailyInsightsImport(context.db, importId);
    if (!staged) throw new NotFoundError('Daily Insights import');
    context.signal.throwIfAborted();
    context.progress(`Reviewing the ${staged.date} briefing for high-confidence actions and supported diary entries.`);
    const result = await captureDailyInsights(context.db, staged.filename, staged.report, staged.sourcePath,
      staged.sourceModifiedAt.toISOString(), async (filename, report, _signal, existingTasks) =>
        extractDailyInsights(filename, report, context.signal, existingTasks, context.progress,
          dailyInsightsStageStore(context.db, staged.id)));
    context.signal.throwIfAborted();
    await deleteStagedDailyInsightsImport(context.db, staged.id);
    // A fresh briefing refreshes Today's meeting preparation, promises and cadence nudges in the background.
    void import('../../goals/meetingPrep.js').then(m => m.refreshMeetingPrep(context.db, 'briefing'))
      .catch((error: unknown) => console.error('[MeetingPrep] Briefing refresh failed:', error instanceof Error ? error.message : error));
    const taskCount = result.tasksCreated + result.tasksUpdated;
    return {
      data: { ...result, sourcePath: staged.sourcePath, url: '/library' },
      summary: `Daily Insights ${result.date} is processed: ${taskCount} task${taskCount === 1 ? '' : 's'} created or updated, ${result.tasksPreserved} preserved, and ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}.`,
    };
  },
});
