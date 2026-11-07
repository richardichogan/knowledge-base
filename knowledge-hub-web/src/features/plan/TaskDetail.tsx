import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { requireApiData } from '../../services/apiError';
import { useProjects } from '../../services/useProjects';
import { useAthenaContext } from '../../context/AthenaContext';
import { DataNotice } from '../../components/DataNotice';
import { ConnectionsPanel } from '../../components/connections/ConnectionsPanel';
import { TaskActivitySection, TaskEditor, TaskNoteText, type TaskEditorInput } from '../../pages/TasksPage';
import { taskAthenaPrompt } from './taskInsights';
import { TaskChecklist } from './TaskChecklist';
import type { ChecklistItem, PlanTask } from '../../types/task';
import { ArrowLeft, ArrowRight, Launch } from '@carbon/icons-react';
import { EntityChip, IdentityChip, identitiesFor, useIdentity } from '../../identity';
import { confirmDialog } from '../../services/appDialogs';
import { setTaskChatBridge } from '../../utils/activeBlockNoteEditor';

function taskStatusLabel(status: string): string {
  return status === 'in-progress' ? 'In progress' : status.charAt(0).toUpperCase() + status.slice(1);
}

function formatDue(dueDate: string, status: string): { label: string; overdue: boolean } {
  const [y, m, d] = dueDate.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return { label: dueDate, overdue: false };
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const label = date.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', ...(y !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
  return { label, overdue: status !== 'completed' && date < today };
}

export function TaskDetail({ taskId, onBackToPlan, backLabel = 'Plan', presentation = 'plan' }: {
  taskId: string; onBackToPlan?: () => void; backLabel?: string; presentation?: 'plan' | 'today';
}): React.ReactElement {
  const [editorActions, setEditorActions] = useState<HTMLDivElement | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { projects } = useProjects();
  const { openAthena } = useAthenaContext();
  const identity = useIdentity();
  const [editing, setEditing] = useState(false);
  const [editingTask, setEditingTask] = useState<PlanTask | null>(null);
  const [taskChatBusy, setTaskChatBusy] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [direction, setDirection] = useState('');
  const [showDirection, setShowDirection] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [copyError, setCopyError] = useState<unknown>(null);
  const [automaticHelpError, setAutomaticHelpError] = useState<Error | null>(null);
  const detail = useQuery({
    queryKey: ['task-assistance', taskId],
    queryFn: async () => requireApiData(await api.getTaskAssistance(taskId)),
    refetchInterval: query => query.state.data?.jobs.some(job => job.status === 'queued' || job.status === 'running') ? 5000 : false,
  });
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all(['task-assistance', 'tasks', 'today', 'today-tasks', 'at-risk-tasks', 'notes-list', 'task-notes', 'task-links'].map(key =>
      qc.invalidateQueries({ queryKey: key === 'task-assistance' ? [key, taskId] : [key] })));
  }, [qc, taskId]);
  useEffect(() => setTaskChatBridge(taskId, async () => {
    if (editingRef.current) throw new Error('Save or cancel the open task editor before asking Athena to work on this task.');
    setTaskChatBusy(true);
    return async () => {
      try { await refresh(); }
      finally { setTaskChatBusy(false); }
    };
  }), [taskId, refresh]);
  const assess = useMutation({
    mutationFn: async () => requireApiData(await api.assessTaskAssistance(taskId, direction)),
    onSuccess: async () => { setDirection(''); setShowDirection(false); await refresh(); },
  });
  const approve = useMutation({
    mutationFn: async (proposalId: string) => requireApiData(await api.approveTaskAssistance(taskId, proposalId)),
    onSuccess: refresh,
  });
  const edit = useMutation({
    mutationFn: async (input: TaskEditorInput) => requireApiData(await api.updateTask(taskId, input)),
    onSuccess: async saved => {
      setAutomaticHelpError(saved.assistanceStatus === 'failed'
        ? new Error('Task saved, but Athena could not queue its help proposal. Choose Help me to retry.') : null);
      setEditing(false);
      await refresh();
    },
  });
  const tick = useMutation({
    mutationFn: async (checklist: ChecklistItem[]) => requireApiData(await api.updateTask(taskId, { checklist })),
    onSuccess: refresh,
  });
  const copy = useMutation({
    mutationFn: async (id: string) => {
      const draft = requireApiData(await api.copyTaskAssistanceEmail(taskId, id));
      await navigator.clipboard.writeText(draft.text);
    },
    onMutate: () => { setCopyError(null); setCopyStatus(''); },
    onSuccess: () => { setCopyStatus('Email draft copied. Review it in Outlook before sending.'); },
    onError: error => { console.error('[Task assistance] Email copy failed', error); setCopyError(error); },
  });
  const backToPlan = <button type="button" className="kh-task-detail__back" disabled={edit.isPending}
    onClick={() => { void (async () => {
      if (editing && !await confirmDialog('Discard the unsaved task edits and return to Plan?', {
        title: 'Leave task editor?', confirmLabel: 'Discard edits', tone: 'danger',
      })) return;
      if (onBackToPlan) onBackToPlan();
      else navigate(presentation === 'today' ? `/plan?taskId=${encodeURIComponent(taskId)}` : '/plan');
    })(); }}>{presentation === 'today' ? <>View in Plan<ArrowRight size={16} /></> : <><ArrowLeft size={16} />Back to {backLabel}</>}</button>;
  const task = detail.data?.task;
  if (!task) return <div className="kh-task-detail">
    {backToPlan}
    {detail.isPending ? <p role="status">Loading task...</p> : <DataNotice title="Task is unavailable" error={detail.error} onRetry={() => { void detail.refetch(); }} />}
  </div>;
  const project = projects.find(item => item.id === task.projectId)?.name ?? task.projectId;
  const tags = identitiesFor(identity, task.taxonomyTagIds ?? [], task.projectId);
  const otherTags = task.tags.filter(name => !tags.some(tag => tag.label.toLowerCase() === name.toLowerCase())
    && name.toLowerCase() !== project?.toLowerCase());
  const latest = detail.data?.proposals[0];
  const active = detail.data?.jobs.some(job => job.status === 'queued' || job.status === 'running') ?? false;
  const busy = assess.isPending || approve.isPending || active;
  const visibleJobs = detail.data?.jobs.filter(job => !(job.status === 'done' && !job.error && latest?.resultNoteId
    && job.result?.['noteId'] === latest.resultNoteId)) ?? [];
  const due = task.dueDate ? formatDue(task.dueDate, task.status) : null;
  const decisions = latest?.proposal.humanDecisions.length ?? 0;
  const assistStatus = active && !latest ? 'Athena is preparing a help proposal. You will be notified when it is ready.'
    : !latest ? 'No proposal yet. Nothing starts until you approve it here.'
      : latest.resultNoteId ? 'Result ready for your review.'
        : `Proposal ready${decisions ? ` · ${decisions} decision${decisions === 1 ? '' : 's'} stay with you` : ''}.`;
  return <article className="kh-task-detail">
    <header className="kh-task-detail__header">
      <div className="kh-task-detail__identity-row">
        <EntityChip projectId={task.projectId} fallbackLabel={project} size="md" />
        {backToPlan}
      </div>
      {!editing && <>
        <p className="kh-task-detail__meta">
          {taskStatusLabel(task.status)} · {task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}
          {due && <> · <span className={due.overdue ? 'kh-task-detail__due--overdue' : undefined}>{due.overdue ? 'Overdue · ' : ''}Due {due.label}</span></>}
        </p>
        {task.waitingOn && <p className="kh-task-detail__waiting">Waiting on <strong>{task.waitingOn}</strong></p>}
        <h2>{task.title}</h2>
        {(tags.length > 0 || otherTags.length > 0) && <div className="kh-chip-row kh-task-detail__tags" aria-label="Task topics">
          {tags.map(tag => <IdentityChip key={tag.tagId} identity={tag} size="md" />)}
          {otherTags.map(name => <EntityChip key={name} name={name} size="md" />)}
        </div>}
      </>}
      <div className="kh-task-detail__actions dc-article-toolbar">
        {editing && <div className="kh-task-detail__editor-actions" ref={setEditorActions} />}
        {!editing && <button type="button" className="dc-explore__primary" disabled={taskChatBusy}
          onClick={() => { edit.reset(); setEditingTask(task); setEditing(true); }}>Edit task</button>}
        <button type="button" className="dc-explore__action" disabled={editing} onClick={() => { openAthena(taskAthenaPrompt(task, project), {
          type: 'task', id: task.id, title: task.title, projectId: task.projectId,
          detail: `${JSON.stringify(task)}\nDiscuss assistance only. Execution requires the saved proposal's Approve and start action in this task view.`,
        }); }}>Discuss with Athena</button>
      </div>
    </header>
    {editing && <TaskEditor inline open initial={editingTask ?? task} defaultStatus={editingTask?.status ?? task.status} projects={projects}
      actionsTarget={editorActions} saving={edit.isPending} error={edit.error instanceof Error ? edit.error.message : null}
      onClose={() => { if (!edit.isPending) setEditing(false); }} onSave={input => { if (!edit.isPending) edit.mutate(input); }} />}
    {!editing && task.body && <p className="kh-task-detail__body"><TaskNoteText text={task.body} /></p>}
    {!editing && <TaskChecklist idPrefix="task-check" items={task.checklist ?? []} editable disabled={tick.isPending}
      onChange={items => { tick.mutate(items); }} />}
    {!editing && tick.error instanceof Error && <p className="kh-task-checklist__error" role="alert">Checklist not saved: {tick.error.message}</p>}
    {task.externalUrl && <a className="dc-explore__source-link" href={task.externalUrl} target="_blank" rel="noreferrer">Original task source <Launch size={16} /></a>}
    <section className="kh-task-detail__assistance" aria-labelledby={`task-assistance-${task.id}`}>
      <h3 id={`task-assistance-${task.id}`}>How Athena could help</h3>
      <p className="kh-task-detail__assist-status" role="status">{assistStatus}</p>
      {showDirection ? <label className="kh-task-detail__field">Direction or clarification <span>(optional)</span>
        <textarea value={direction} maxLength={3000} disabled={busy || editing} rows={3} autoFocus
          onChange={event => { setDirection(event.target.value); }}
          placeholder="What should Athena look at, compare or prepare? Leave blank to keep your last direction." />
      </label> : null}
      <div className="kh-task-detail__actions">
        <button type="button" className={latest ? 'dc-explore__action' : 'dc-explore__primary'} disabled={busy || editing}
          onClick={() => { assess.mutate(); }}>{assess.isPending ? 'Assessing what Athena can do...' : latest ? direction.trim() ? 'Reassess with this direction' : 'Reassess' : 'Help me'}</button>
        {!showDirection && <button type="button" className="dc-explore__action" disabled={busy || editing}
          onClick={() => { setShowDirection(true); }}>Add direction</button>}
      </div>
      {assess.error && <DataNotice title="Assistance assessment failed" error={assess.error} />}
      {automaticHelpError && <DataNotice title="Task saved; help proposal needs attention" error={automaticHelpError} />}
      {detail.isError && <DataNotice title="Assistance status could not refresh" error={detail.error} onRetry={() => { void detail.refetch(); }} />}
      {latest && <div className="kh-task-detail__proposal" aria-live="polite">
        <h4>{latest.proposal.outputFormat === 'docx' ? 'Document proposal' : latest.proposal.kind === 'research' ? 'Iris · Research proposal' : latest.proposal.kind === 'email' ? 'Hermes · Email draft proposal' : 'Task preparation proposal'}</h4>
        <p>{latest.proposal.summary}</p>
        <dl className="dc-project-fits kh-task-detail__proposal-facts">
          {latest.direction && <div><dt>Your direction</dt><dd>{latest.direction}</dd></div>}
          <div><dt>Proposed work</dt><dd>{latest.proposal.approach}</dd></div>
          <div><dt>Result for your review</dt><dd>{latest.proposal.output}</dd></div>
          {latest.proposal.outputFormat === 'docx' && <div><dt>Word download</dt><dd>Open the result in Think and choose Export as Word (.docx). The original source stays unchanged.</dd></div>}
        </dl>
        {latest.proposal.publicQueries.length > 0 && <><h4>Public searches to approve</h4><p>Only these exact queries can be sent to external search providers.</p>
          <ul>{latest.proposal.publicQueries.map(query => <li key={query}>{query}</li>)}</ul></>}
        {latest.proposal.questions.length > 0 && <div className="kh-task-detail__review-box"><h4>{latest.proposal.kind === 'research' ? 'Questions to investigate · research can start' : 'Questions for review · help can start'}</h4><ul>{latest.proposal.questions.map(question => <li key={question}>{question}</li>)}</ul></div>}
        {latest.proposal.humanDecisions.length > 0 && <div className="kh-task-detail__review-box"><h4>Decisions that stay with you</h4><ul>{latest.proposal.humanDecisions.map(decision => <li key={decision}>{decision}</li>)}</ul></div>}
        {latest.stale && !latest.resultNoteId && <p role="status">The task changed. Reassess it before starting.</p>}
        {direction.trim() && !latest.resultNoteId && <p role="status">Reassess with your new direction before approving.</p>}
        {!latest.resultNoteId && <button type="button" className="dc-explore__primary"
          disabled={busy || editing || latest.stale || Boolean(direction.trim())}
          onClick={() => { approve.mutate(latest.id); }}>{approve.isPending ? 'Starting...' : latest.approved ? 'Retry approved work' : 'Approve and start'}</button>}
        {latest.resultNoteId && <div className="kh-task-detail__actions">
          <Link className="dc-explore__source-link" to={`/think?noteId=${encodeURIComponent(latest.resultNoteId)}`}>Open result in Think</Link>
          {latest.proposal.kind === 'email' && <button type="button" className="dc-explore__action" disabled={copy.isPending} onClick={() => { copy.mutate(latest.id); }}>{copy.isPending ? 'Copying...' : 'Copy email draft'}</button>}
        </div>}
      </div>}
      {approve.error && <DataNotice title="Assistance could not start" error={approve.error} />}
      {copyError != null && <DataNotice title="Email draft could not be copied" error={copyError} />}
      {copyStatus && <p role="status">{copyStatus}</p>}
      {visibleJobs.map(job => <div key={job.id} className="kh-task-detail__job">
        <h4>{job.specialistName} · {job.status === 'done' ? 'Ready for your review' : job.status}</h4>
        {job.status !== 'done' && job.progress.at(-1) && <p role="status">{job.progress.at(-1)}</p>}
        {job.error && <p className="kh-task-detail__error" role="alert">{job.error}</p>}
        {typeof job.result?.['noteId'] === 'string' && <Link className="dc-explore__source-link" to={`/think?noteId=${encodeURIComponent(job.result['noteId'])}`}>Open saved result</Link>}
      </div>)}
    </section>
    <TaskActivitySection taskId={task.id} />
    <ConnectionsPanel refId={task.id} refType="task" />
  </article>;
}
