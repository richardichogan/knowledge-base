import type { JobDefinition } from '../../types/jobs';

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
