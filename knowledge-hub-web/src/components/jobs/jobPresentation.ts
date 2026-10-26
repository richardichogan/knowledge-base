import type { JobDefinition, JobRun } from '../../types/jobs';

export const jobKinds: Record<JobDefinition['kind'], string> = {
  prompt: 'Athena prompt', 'content-sync': 'Content sync',
  'm365-import': 'M365 report import', 'weekly-microsoft': 'Microsoft updates',
};

export const outputNames: Record<JobDefinition['outputs'][number], string> = {
  think: 'Think', slack: 'Slack', blog: 'Blog', bluesky: 'Bluesky', linkedin: 'LinkedIn', file: 'Markdown file',
};

export function scheduleLabel(schedule: JobDefinition['schedule']): string {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = [...new Set(schedule.days)].sort();
  const frequency = days.length === 7 ? 'Every day'
    : days.join(',') === '1,2,3,4,5' ? 'Weekdays'
      : days.map(day => weekdays[day]).join(', ') || 'No days selected';
  return `${frequency} at ${schedule.times.join(' & ')}`;
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    'awaiting-approval': 'Needs approval', 'waiting-file': 'Waiting for file',
    'waiting-device': 'Waiting for desktop', succeeded: 'Completed', partial: 'Partially completed',
    unconfirmed: 'Check delivery',
  };
  return labels[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

export function runStatusLabel(run: JobRun): string {
  const sync = run.artifacts['sync'];
  if (run.definition.kind === 'content-sync' && sync && typeof sync === 'object' && !Array.isArray(sync)) {
    const result = sync as Record<string, unknown>;
    const sources = result['results'];
    const completedSource = Array.isArray(sources) && sources.some((source: unknown) =>
      !!source && typeof source === 'object' && 'errors' in source && source.errors === 0);
    if (['succeeded', 'failed', 'partial'].includes(run.status) && Number(result['totalErrors']) > 0
      && (Number(result['totalIndexed']) > 0 || completedSource)) return 'Succeeded with source errors';
  }
  if (run.artifacts['editorialOutcome'] === 'hold' || run.status === 'partial' && run.artifacts['editorialOutcome'] === 'revise') return 'Editorial review needed';
  return statusLabel(run.status);
}
