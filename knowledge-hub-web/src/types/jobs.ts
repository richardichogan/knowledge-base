export interface JobDefinition {
  name: string; kind: 'content-sync' | 'm365-import' | 'weekly-microsoft' | 'prompt'; prompt: string;
  schedule: { timezone: string; days: number[]; times: string[] };
  approval: 'required' | 'automatic'; deviceId: string; inputFolder: string; outputFolder: string;
  outputs: Array<'think' | 'slack' | 'blog' | 'bluesky' | 'linkedin' | 'file'>;
}
export interface ManagedJob {
  id: string; revision: number; enabled: boolean; archived: boolean; definition: JobDefinition; nextAt: string | null; updatedAt: string;
}
export interface JobRun {
  id: string; jobId: string; revision: number; definition: JobDefinition; scheduledAt: string; deadline: string;
  status: string; preview: boolean; steps: Array<{ key: string; status: string; error?: string; result?: unknown }>;
  artifacts: Record<string, unknown>; approvedAt: string | null; createdAt: string; updatedAt: string;
}
export interface JobDevice {
  id: string; name: string; folders: Array<{ id: string; name: string; path: string }>; seenAt: string;
}
export interface JobEvent {
  id: string; jobId: string; runId: string | null; actor: string; event: string; detail: unknown; createdAt: string;
}
export interface JobProposal {
  id: string; payload: { operation: 'save' | 'run' | 'approve'; definition: JobDefinition; enabled?: boolean; preview?: boolean; artifacts?: Record<string, unknown> };
}
