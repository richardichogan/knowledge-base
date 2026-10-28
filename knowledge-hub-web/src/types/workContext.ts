import type { ProjectCockpit, ProjectRegisterItem } from '../services/api';

export interface ProjectChanges {
  since: string; until: string; truncated: boolean;
  items: Array<{ id: string; kind: string; title: string; at: string; href: string; detail: string }>;
}
export interface MeetingPreparation {
  generatedAt: string;
  meeting: { id: string; title: string; start: string; body: string; bodyTruncated: boolean; attendees: string[]; cancelled: boolean };
  projectId: string | null;
  cockpit: ProjectCockpit | null;
  register: ProjectRegisterItem[];
  registerTruncated: boolean;
  notes: Array<{ id: string; title: string; text: string; updatedAt: string; truncated: boolean }>;
  limitations: string[];
}
