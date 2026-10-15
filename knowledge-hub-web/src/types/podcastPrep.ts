export interface PodcastPrepRun {
  recordingDate: string;
  status: 'running' | 'ready' | 'failed';
  sessionId: string;
  outputId: string | null;
  generatedAt: string | null;
  acknowledgedAt: string | null;
  warnings: string[];
  error: string | null;
  attempts: number;
}
export interface PodcastPrepStatus {
  nextRecording: string | null;
  scheduleWarning: string | null;
  run: PodcastPrepRun | null;
  latestBrief: PodcastPrepRun | null;
}
export function podcastBriefUrl(run: PodcastPrepRun): string {
  return `/chat?session=${encodeURIComponent(run.sessionId)}${run.outputId ? `&output=${encodeURIComponent(run.outputId)}` : ''}`;
}
