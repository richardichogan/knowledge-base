import type { CanvasSummaryApi, DiscoverItem, Project, SourceStatus, SparkCluster } from './api';
import type { ChatDecision, ChatOutputSummary, ChatSessionSummary } from '../types/ai';
import type { ContentItemSummary } from '../types/contentItem';
import type { NoteListItem } from '../notes/types';

export const TODAY_LIMITS = { attention: 5, continue: 4, explore: 3, changes: 3 } as const;
const DAY_MS = 86_400_000;

export interface TodayTask {
  id: string;
  title: string;
  body: string;
  status: string;
  priority: string;
  projectId: string;
  dueDate: string | null;
  updatedAt: string;
  archived: boolean;
}

export interface TodayItem {
  id: string;
  title: string;
  type: string;
  projectId?: string;
  project?: string;
  reason: string;
  status?: string;
  tone: 'danger' | 'warning' | 'normal';
  date?: string;
  href: string;
  action: string;
  score: number;
  source: string;
  taskId?: string;
  discoverId?: string;
  clusterId?: string;
}

export interface TodayChatDetails {
  session: ChatSessionSummary;
  outputs: ChatOutputSummary[];
  decisions: ChatDecision[];
}

export interface TodayInputs {
  tasks: TodayTask[];
  notes: NoteListItem[];
  projects: Project[];
  activity: ContentItemSummary[];
  sources: SourceStatus[];
  discover: DiscoverItem[];
  clusters: SparkCluster[];
  canvases: CanvasSummaryApi[];
  chats: TodayChatDetails[];
}

export interface TodayModel {
  attention: TodayItem[];
  continuing: TodayItem[];
  changes: TodayItem[];
  exploration: TodayItem[];
}

export function workDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function relativeTime(iso: string, now = new Date()): string {
  const elapsed = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(elapsed)) return 'Date unavailable';
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} hours ago`;
  const days = Math.floor(minutes / 1_440);
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}

export function readTodayTasks(value: unknown): TodayTask[] {
  if (typeof value !== 'object' || value === null || !('items' in value) || !Array.isArray(value.items)) {
    throw new Error('Plan returned an invalid task list');
  }
  return value.items.map((row: unknown) => {
    if (typeof row !== 'object' || row === null) throw new Error('Plan returned an invalid task');
    const required = (key: string): string => {
      if (!(key in row)) throw new Error(`Task is missing ${key}`);
      const value = Reflect.get(row, key);
      if (typeof value !== 'string') throw new Error(`Task has invalid ${key}`);
      return value;
    };
    const optional = (key: string): string => {
      const value: unknown = Reflect.get(row, key);
      return typeof value === 'string' ? value : '';
    };
    const due: unknown = Reflect.get(row, 'dueDate');
    return {
      id: required('id'), title: required('title'), status: required('status'),
      priority: required('priority'), body: optional('body'), projectId: optional('projectId'),
      updatedAt: optional('updatedAt'), dueDate: typeof due === 'string' ? due.slice(0, 10) : null,
      archived: Reflect.get(row, 'archived') === true,
    };
  });
}

export function buildTodayModel(data: TodayInputs, now: Date, since: string): TodayModel {
  const today = workDate(now);
  const day = new Date(`${today}T00:00:00Z`).getTime();
  const project = (id: string | null | undefined): Pick<TodayItem, 'project' | 'projectId'> => {
    if (!id) return {};
    const match = data.projects.find((p) => p.id === id);
    return { projectId: id, ...(match ? { project: match.name } : {}) };
  };
  const fresh = (date: string): boolean => new Date(date).getTime() > new Date(since).getTime();
  const recentScore = (date: string): number => {
    const savedAt = new Date(date).getTime();
    return Number.isFinite(savedAt) ? Math.max(0, 14 - (now.getTime() - savedAt) / DAY_MS) : 0;
  };
  const attention: TodayItem[] = [];
  const continuing: TodayItem[] = [];
  const changes: TodayItem[] = [];
  const exploration: TodayItem[] = [];
  for (const task of data.tasks) {
    if (task.archived || task.status === 'completed') continue;
    const days = task.dueDate === null ? null : Math.round((new Date(`${task.dueDate}T00:00:00Z`).getTime() - day) / DAY_MS);
    const overdue = days !== null && days < 0;
    const approaching = days !== null && days <= 3;
    const blocked = task.status === 'blocked';
    const feedback = task.status === 'awaiting-feedback';
    const high = task.priority === 'high' || task.priority === 'urgent';
    const age = (now.getTime() - new Date(task.updatedAt).getTime()) / DAY_MS;
    const stale = task.status === 'in-progress' && age >= 7;
    const status = overdue ? 'Overdue' : blocked ? 'Blocked' : feedback ? 'Awaiting feedback'
      : approaching ? days === 0 ? 'Due today' : 'Due soon' : stale ? 'Needs a check-in' : 'High priority';
    const reason = [
      overdue ? `The due date has passed by ${Math.abs(days ?? 0)} day${days === -1 ? '' : 's'}.`
        : approaching ? days === 0 ? 'Due today.' : `Due in ${days} days.` : '',
      blocked ? 'Blocked in Plan; review what is needed to move it forward.' : '',
      feedback ? 'Waiting for feedback; check whether a follow-up is needed.' : '',
      stale ? 'In progress with no task update for at least a week.' : '',
      high ? `${task.priority === 'urgent' ? 'Urgent' : 'High priority'} in Plan.` : '',
    ].filter(Boolean).join(' ');
    const item: TodayItem = {
      id: `task:${task.id}`, title: task.title, type: 'Task', ...project(task.projectId),
      reason: reason || 'In progress in Plan. Resume the next step.',
      tone: overdue ? 'danger' : blocked || approaching ? 'warning' : 'normal',
      ...(task.dueDate ? { date: task.dueDate } : {}),
      href: `/plan?taskId=${encodeURIComponent(task.id)}`, action: blocked ? 'Unblock in Plan' : feedback ? 'Review feedback' : 'Review task',
      score: overdue ? 100 + Math.min(Math.abs(days ?? 0), 30) : blocked ? 90 : task.priority === 'urgent' ? 85 : approaching ? 80 - (days ?? 0) : feedback ? 70 : high ? 60 : 50,
      source: 'Plan', taskId: task.id,
    };
    if (overdue || approaching || blocked || feedback || high || stale) attention.push({ ...item, status });
    else if (task.status === 'in-progress') continuing.push({ ...item, action: 'Continue', score: 25 + recentScore(task.updatedAt), date: task.updatedAt });
  }
  for (const source of data.sources.filter((s) => s.status === 'error')) {
    attention.push({
      id: `sync:${source.source}`, title: `${source.source.replace(/-/g, ' ')} sync needs checking`,
      type: 'Integration', reason: 'The last sync reported an error. New information from this connection may be missing.',
      status: 'Sync failed', tone: 'danger', href: '/my-work', action: 'Check connection',
      score: 95, source: source.source, ...(source.lastSyncAt ? { date: source.lastSyncAt } : {}),
    });
  }
  const incidentKeys = new Set<string>();
  const sortedActivity = [...data.activity].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const changeGroups = new Map<string, { count: number; title: string; date: string }>();
  for (const event of sortedActivity) {
    const source = String(event.source);
    const meta = event.metadata;
    const automation = /(?:action|pipeline|deployment)$/.test(source);
    const state = String(meta?.['conclusion'] ?? meta?.['status'] ?? meta?.['state'] ?? '');
    const key = `${source}:${String(meta?.['repo'] ?? meta?.['projectPath'] ?? '')}:${String(meta?.['workflowId'] ?? meta?.['workflowName'] ?? meta?.['ref'] ?? event.title)}`;
    const latestAutomation = !incidentKeys.has(key);
    if (automation) incidentKeys.add(key);
    const failure = automation && ['failure', 'failed', 'error', 'timed_out', 'startup_failure'].includes(state);
    if (fresh(event.publishedAt) && latestAutomation && failure) {
      attention.push({
        id: `activity:${event.id}`, title: event.title, type: 'Automation',
        reason: 'This run failed. Check the failure before relying on its result.',
        ...project(event.projectContext), status: 'Failed', tone: 'danger', date: event.publishedAt,
        href: safeHref(event.url, '/my-work'), action: 'Review failure', score: 96, source,
      });
      continue;
    }
    if (!fresh(event.publishedAt) || failure) continue;
    if (source === 'task' || source === 'note' || source === 'discovered-article') continue;
    const name = project(event.projectContext).project;
    const label = automation ? 'Routine automations completed successfully. No action required.'
      : source === 'onedrive-document' ? `documents updated${name ? ` in ${name}` : ' in Library'}`
        : /review|email/.test(source) ? `feedback or messages received${name ? ` in ${name}` : ''}`
          : /commit|pr|mr|issue|release/.test(source) ? `repository updates${name ? ` in ${name}` : ''}`
            : source === 'graph-calendar' ? 'calendar updates' : `${source.replace(/-/g, ' ')} updates`;
    // Only confirmed successful runs are counted as successful automations.
    if (automation && !['success', 'succeeded'].includes(state)) continue;
    const groupKey = `${automation ? 'automation' : source}:${automation ? '' : event.projectContext ?? ''}`;
    const group = changeGroups.get(groupKey);
    changeGroups.set(groupKey, { count: (group?.count ?? 0) + 1, title: label, date: group?.date ?? event.publishedAt });
  }
  for (const [id, group] of changeGroups) changes.push({
    id: `change:${id}`, title: `${group.count} ${group.title}`, type: 'Activity',
    reason: 'Since the last Today visit, or the last 24 hours on your first visit.',
    tone: 'normal', date: group.date, href: '/my-work', action: 'View activity', score: /feedback/.test(group.title) ? 30 : 10, source: 'My Work',
  });
  for (const note of data.notes) {
    const score = recentScore(note.updatedAt);
    if (score <= 0) continue;
    continuing.push({
      id: `note:${note.id}`, title: note.title, type: 'Think note', ...project(note.projectId),
      reason: note.body ? `Last saved: ${note.body}` : 'Recently saved in Think. Pick up the draft where you left it.',
      tone: 'normal', date: note.updatedAt, href: `/think?noteId=${encodeURIComponent(note.id)}`, action: 'Continue',
      score: 35 + score, source: 'Think',
    });
  }
  for (const canvas of data.canvases) {
    if (canvas.nodeCount === 0 || recentScore(canvas.updatedAt) <= 0) continue;
    continuing.push({
      id: `canvas:${canvas.id}`, title: canvas.title, type: 'Canvas', ...project(canvas.project),
      reason: canvas.description || `${canvas.nodeCount} connected cards to develop in Think.`,
      tone: 'normal', date: canvas.updatedAt, href: `/think?mapId=${encodeURIComponent(canvas.id)}`, action: 'Continue',
      score: 32 + recentScore(canvas.updatedAt), source: 'Think',
    });
  }
  for (const chat of data.chats) {
    for (const decision of chat.decisions.filter((d) => d.status === 'open')) {
      attention.push({
        id: `decision:${decision.id}`, title: decision.text, type: 'Decision', ...project(chat.session.projectId),
        reason: `An open question in "${chat.session.title}". Review the discussion and record the decision.`,
        status: 'Decision required', tone: 'normal', date: decision.updatedAt,
        href: `/chat?session=${encodeURIComponent(chat.session.id)}`, action: 'Make decision', score: 72, source: 'Athena',
      });
    }
    if (chat.outputs.length > 0 && recentScore(chat.session.updatedAt) > 0) {
      continuing.push({
        id: `chat:${chat.session.id}`, title: chat.session.title, type: 'Athena outputs', ...project(chat.session.projectId),
        reason: `${chat.outputs.length} saved output${chat.outputs.length === 1 ? '' : 's'}: ${chat.outputs.map((o) => o.title).join(', ')}.`,
        tone: 'normal', date: chat.session.updatedAt, href: `/chat?session=${encodeURIComponent(chat.session.id)}`, action: 'Continue',
        score: 40 + recentScore(chat.session.updatedAt), source: 'Athena',
      });
      const count = chat.outputs.filter((o) => fresh(o.updatedAt)).length;
      if (count > 0) changes.push({
        id: `change:chat:${chat.session.id}`, title: `${count} Athena output${count === 1 ? '' : 's'} saved in "${chat.session.title}"`,
        type: 'Outputs', ...project(chat.session.projectId), reason: 'Latest saved versions are ready to review.',
        tone: 'normal', date: chat.session.updatedAt, href: `/chat?session=${encodeURIComponent(chat.session.id)}`, action: 'Review outputs', score: 25, source: 'Athena',
      });
    }
  }
  for (const item of data.discover.filter((d) => d.workflowState === 'to-review')) {
    const reason = item.sparkReason || item.relevanceExplanation;
    if (!reason) continue;
    exploration.push({
      id: `discover:${item.id}`, title: item.title, type: item.platform || 'Article', reason,
      tone: 'normal', date: item.publishedAt, href: safeHref(item.url, '/discover'), action: 'Review article',
      score: item.compositeScore ?? item.relevanceScore ?? 0, source: item.sourceTitle, discoverId: item.id,
    });
  }
  for (const cluster of data.clusters.filter((c) => !c.dismissed && !c.surfaced && c.sparkCount >= 4)) exploration.push({
    id: `cluster:${cluster.id}`, title: cluster.theme, type: 'Spark cluster',
    reason: `${cluster.sparkCount} captured thoughts share this theme. Develop them into an outline.`,
    tone: 'normal', date: cluster.updatedAt, href: '/think', action: 'Develop in Think',
    score: Math.min(cluster.sparkCount, 10), source: 'Sparks', clusterId: cluster.id,
  });
  const attentionIds = new Set(attention.map((i) => i.id));
  const decisionChats = new Set(attention.filter((i) => i.type === 'Decision').map((i) => i.href));
  const sort = (items: TodayItem[]): TodayItem[] => items.sort((a, b) => b.score - a.score || (b.date ?? '').localeCompare(a.date ?? '') || a.id.localeCompare(b.id));
  return {
    attention: sort(attention),
    continuing: sort(continuing.filter((i) => !attentionIds.has(i.id) && !decisionChats.has(i.href))).slice(0, TODAY_LIMITS.continue),
    changes: sort(changes),
    exploration: sort(exploration).slice(0, TODAY_LIMITS.explore),
  };
}

export function safeHref(value: string | undefined | null, defaultPath: string): string {
  if (!value) return defaultPath;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : defaultPath;
  } catch {
    return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : defaultPath;
  }
}

export function todayContext(model: TodayModel): string {
  return JSON.stringify({
    attention: model.attention.slice(0, TODAY_LIMITS.attention),
    continuing: model.continuing,
    changes: model.changes.slice(0, 8),
    exploration: model.exploration,
  });
}
