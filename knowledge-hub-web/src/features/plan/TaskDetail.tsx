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
import type { PlanTask } from '../../types/task';
import { ArrowLeft, ArrowRight, Launch } from '@carbon/icons-react';
import { EntityChip, IdentityChip, identitiesFor, useIdentity } from '../../identity';
import { confirmDialog } from '../../services/appDialogs';
import { setTaskChatBridge } from '../../utils/activeBlockNoteEditor';

export function TaskDetail({ taskId, onBackToPlan, presentation = 'plan' }: {
  taskId: string; onBackToPlan?: () => void; presentation?: 'plan' | 'today';
}): React.ReactElement {
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
    onSuccess: async () => { setDirection(''); await refresh(); },
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
    })(); }}>{presentation === 'today' ? <>View in Plan<ArrowRight size={16} /></> : <><ArrowLeft size={16} />Back to Plan</>}</button>;
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
  const refreshWithResult = Boolean(latest?.resultNoteId) && visibleJobs.length === 0;
  return <article className="kh-task-detail">
    <header className="kh-task-detail__header">
      {presentation === 'plan' && backToPlan}
      {presentation === 'today' && <div className="kh-task-detail__identity-row">
        <EntityChip projectId={task.projectId} fallbackLabel={project} size="md" />
        {backToPlan}
      </div>}
      <div className="kh-task-detail__meta">
        {presentation === 'plan' && <EntityChip projectId={task.projectId} fallbackLabel={project} size="md" />}
        <span>{task.status === 'in-progress' ? 'In progress' : task.status.charAt(0).toUpperCase() + task.status.slice(1)} · {task.priority} priority{task.dueDate ? ` · Due ${task.dueDate}` : ''}</span>
      </div>
      <h2>{task.title}</h2>
      {(tags.length > 0 || otherTags.length > 0) && <div className="kh-chip-row kh-task-detail__tags" aria-label="Task topics">
        {tags.map(tag => <IdentityChip key={tag.tagId} identity={tag} size="md" />)}
        {otherTags.map(name => <EntityChip key={name} name={name} size="md" />)}
      </div>}
      <div className="kh-task-detail__actions dc-article-toolbar">
        {!editing && <button type="button" className="dc-explore__action" disabled={taskChatBusy}
          onClick={() => { edit.reset(); setEditingTask(task); setEditing(true); }}>Edit task</button>}
        <button type="button" className="dc-explore__primary" disabled={editing} onClick={() => { openAthena(taskAthenaPrompt(task, project), {
          type: 'task', id: task.id, title: task.title, projectId: task.projectId,
          detail: `${JSON.stringify(task)}\nDiscuss assistance only. Execution requires the saved proposal's Approve and start action in this task view.`,
        }); }}>Discuss with Athena</button>
      </div>
    </header>
    {editing && <TaskEditor inline open initial={editingTask ?? task} defaultStatus={editingTask?.status ?? task.status} projects={projects}
      saving={edit.isPending} error={edit.error instanceof Error ? edit.error.message : null}
      onClose={() => { if (!edit.isPending) setEditing(false); }} onSave={input => { if (!edit.isPending) edit.mutate(input); }} />}
    {!editing && task.body && <p className="kh-task-detail__body"><TaskNoteText text={task.body} /></p>}
    {!editing && task.waitingOn && <p>Waiting on: {task.waitingOn}</p>}
    {task.externalUrl && <a className="dc-explore__source-link" href={task.externalUrl} target="_blank" rel="noreferrer">Original task source <Launch size={16} /></a>}
    <section className="kh-task-detail__assistance" aria-labelledby={`task-assistance-${task.id}`}>
      <h3 id={`task-assistance-${task.id}`}>How Athena could help</h3>
      <p>Athena prepares a proposal for new non-recurring tasks and notifies you when it is ready. Inbox tasks wait until you accept them. Recurring tasks use Help me on request. Research, drafting and changes do not start until you approve them here.</p>
      <label className="kh-task-detail__field">Direction or clarification <span>(optional)</span>
        <textarea value={direction} maxLength={3000} disabled={busy || editing} rows={3}
          onChange={event => { setDirection(event.target.value); }}
          placeholder="What should she look at, compare or prepare? Leave blank to keep your last direction." />
      </label>
      <button type="button" className="dc-explore__primary" disabled={busy || editing}
        onClick={() => { assess.mutate(); }}>{assess.isPending ? 'Assessing what Athena can do...' : latest ? 'Reassess with this direction' : 'Help me'}</button>
      {active && !latest && <p role="status">Athena is preparing a help proposal. You will be notified when it is ready.</p>}
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
          {!active && refreshWithResult && <button type="button" className="dc-explore__action" disabled={detail.isFetching} onClick={() => { void detail.refetch(); }}>Refresh assistance status</button>}
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
      {!active && !refreshWithResult && <button type="button" className="dc-explore__action" disabled={detail.isFetching} onClick={() => { void detail.refetch(); }}>Refresh assistance status</button>}
    </section>
    <TaskActivitySection taskId={task.id} />
    <ConnectionsPanel refId={task.id} refType="task" />
  </article>;
}
