/**
 * features/build/BuildPage.tsx — the Build pipeline: write (or send in) a
 * GHCP spec, decompose it into dependency-ordered tasks, then hand each task
 * to a GitHub cloud coding agent (Copilot or Claude) and follow the PRs
 * through to merge.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../../services/appDialogs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { InlineLoading } from '@carbon/react';
import { Add, Launch } from '@carbon/icons-react';
import {
  api,
  type BuildAgent,
  type BuildSpec,
  type BuildSpecStatus,
  type BuildSpecSummary,
  type BuildSpecWithTasks,
  type BuildEvent,
  type BuildTask,
  type BuildTaskStatus,
} from '../../services/api';
import type { ApiResponse } from '../../types/apiResponse';
import { BranchField, describeBuildError, RepoField, unwrap, useGithubRepos } from './buildShared';
import { PageHeader } from '../../components/PageHeader';
import { DocumentHtmlView, DocumentViewToggle, type DocumentViewMode } from '../../components/DocumentView';
import { DocumentReview } from '../../components/DocumentReview';
import { DataNotice } from '../../components/DataNotice';
import { useAthenaContext, type AthenaPageContext } from '../../context/AthenaContext';
import { setBuildChatBridge } from '../../utils/activeBlockNoteEditor';

const RUNNING_POLL_MS = 20_000;
const EMPTY_BUILD_EVENTS: BuildEvent[] = [];
const MAX_PARALLEL_CHOICES = [1, 2, 3, 4, 5];
const EDITABLE: readonly BuildSpecStatus[] = ['draft', 'decomposed', 'paused', 'failed', 'done'];
const DECOMPOSABLE: readonly BuildSpecStatus[] = ['draft', 'decomposed', 'failed'];

const SPEC_STATUS_LABEL: Record<BuildSpecStatus, string> = {
  draft: 'Draft', decomposing: 'Decomposing…', decomposed: 'Ready to start', running: 'Running',
  paused: 'Paused', done: 'Done', failed: 'Failed',
};

const TASK_STATUS_LABEL: Record<BuildTaskStatus, string> = {
  pending: 'Waiting', dispatched: 'Agent working', pr_open: 'PR open', awaiting_approval: 'Needs you',
  merged: 'Merged', blocked: 'Blocked', failed: 'Failed', cancelled: 'Skipped',
};

const AGENT_LABEL: Record<BuildAgent, string> = { copilot: 'Copilot', claude: 'Claude' };

function buildAthenaContext(spec: BuildSpecWithTasks, events: BuildEvent[], eventsLoaded: boolean): AthenaPageContext {
  const markdown = spec.specMarkdown.slice(0, 6_000);
  const taskRows = spec.tasks.slice(0, 8).map(task => ({
    id: task.id, seq: task.seq, title: task.title, status: task.status, agent: task.agent,
    dependsOn: task.dependsOn, instructions: task.bodyMarkdown.slice(0, 500),
  }));
  const eventRows = events.slice(0, 8).map(event => ({
    id: event.id, kind: event.kind, message: event.message, createdAt: event.createdAt,
  }));
  const detail = [
    `Selected Build spec ID: ${spec.id}. This is saved state; local unsaved edits are not included.`,
    `Settings and state: ${JSON.stringify({
      title: spec.title, repo: spec.repo, baseBranch: spec.baseBranch, useWorkBranch: spec.useWorkBranch,
      workBranch: spec.workBranch, status: spec.status, maxParallel: spec.maxParallel, autoMerge: spec.autoMerge,
      updatedAt: spec.updatedAt, planNotes: spec.planNotes, projectId: spec.projectId,
    })}`,
    `Saved Markdown (${markdown.length} of ${spec.specMarkdown.length} characters):\n${markdown}${spec.specMarkdown.length > markdown.length ? '\n[Excerpt; use read_build_spec pages for the full saved Markdown.]' : ''}`,
    `Tasks (${taskRows.length} of ${spec.tasks.length}, each instruction excerpt capped at 500 characters):\n${JSON.stringify(taskRows)}${spec.tasks.length > taskRows.length ? '\n[Use read_build_tasks and read_build_task for all tasks and full instructions.]' : ''}`,
    `Activity ${eventsLoaded ? `(${eventRows.length} of ${events.length} recently loaded)` : '(not retrieved in the page yet)'}:\n${eventsLoaded ? JSON.stringify(eventRows) : 'Use read_build_events; do not infer an empty history from missing page data.'}`,
    'Use read_build_spec, read_build_tasks, read_build_task and read_build_events for bounded complete retrieval. Athena writes are refused while the editor has unsaved changes or pending HTML review feedback.',
  ].join('\n\n');
  return { type: 'build-spec', id: spec.id, buildSpecId: spec.id, title: spec.title, detail,
    ...(spec.projectId ? { projectId: spec.projectId } : {}) };
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const StatusPill: React.FC<{ kind: 'spec' | 'task'; status: BuildSpecStatus | BuildTaskStatus }> = ({ kind, status }) => (
  <span className={`build-pill build-pill--${status}`}>
    {kind === 'spec' ? SPEC_STATUS_LABEL[status as BuildSpecStatus] : TASK_STATUS_LABEL[status as BuildTaskStatus]}
  </span>
);

// ── Integration branch ───────────────────────────────────────────────────────

const awaitingFinalMerge = (s: BuildSpec | undefined): boolean =>
  s?.status === 'done' && s.finalPrNumber !== null && s.finalPrMergedAt === null;

const branchUrl = (repo: string, branch: string): string =>
  `https://github.com/${repo}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;

const WorkBranchToggle: React.FC<{ checked: boolean; target: string; disabled?: boolean; onChange: (v: boolean) => void }> = ({
  checked, target, disabled = false, onChange,
}) => (
  <label className="build-check build-check--field" title={`Agents merge into a build/… branch; one PR into ${target || 'the target'} at the end`}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => { onChange(e.target.checked); }} />
    <span>Use an integration branch</span>
  </label>
);

/** "main ← build/x" in the spec header. */
const BranchFlow: React.FC<{ spec: BuildSpec }> = ({ spec }) => (
  <>
    <span>{spec.baseBranch}</span>
    {spec.workBranch !== null && (
      <>
        <span> ← </span>
        <a className="build-link" href={branchUrl(spec.repo, spec.workBranch)} target="_blank" rel="noreferrer">{spec.workBranch}<Launch size={12} /></a>
      </>
    )}
    {spec.workBranch === null && spec.useWorkBranch && spec.status !== 'done' && <span className="build-task__note"> (integration branch created on start)</span>}
  </>
);

const FinalMergePanel: React.FC<{ spec: BuildSpec; busy: string | null; onMerge: () => void }> = ({ spec, busy, onMerge }) => {
  if (spec.finalPrNumber === null || spec.finalPrUrl === null) return null;
  const prLink = <a className="build-link" href={spec.finalPrUrl} target="_blank" rel="noreferrer">PR #{spec.finalPrNumber}<Launch size={12} /></a>;
  if (spec.finalPrMergedAt !== null) {
    return <section className="build-panel build-final"><p className="build-hint">Merged into <strong>{spec.baseBranch}</strong> via {prLink}. Integration branch deleted.</p></section>;
  }
  return (
    <section className="build-panel build-final">
      <p className="build-hint">All tasks are on <strong>{spec.workBranch}</strong>. {prLink} into <strong>{spec.baseBranch}</strong> is ready.</p>
      <div className="build-row">
        <button type="button" className="docs-upload-btn" disabled={busy !== null} onClick={onMerge}>
          {busy === 'merge-final' ? 'Merging…' : `Merge into ${spec.baseBranch}`}
        </button>
      </div>
    </section>
  );
};

// ── Task row ─────────────────────────────────────────────────────────────────

interface TaskRowProps {
  task: BuildTask;
  tasks: BuildTask[];
  availableAgents: BuildAgent[] | null;
  onSpec: (s: BuildSpecWithTasks) => void;
  onError: (msg: string) => void;
}

const TaskRow: React.FC<TaskRowProps> = ({ task, tasks, availableAgents, onSpec, onError }) => {
  const [busy, setBusy] = useState(false);
  const [editingDeps, setEditingDeps] = useState(false);
  const titleById = useMemo(() => new Map(tasks.map((t) => [t.id, `${t.seq.toString()}. ${t.title}`])), [tasks]);
  const pending = task.status === 'pending';
  const run = (p: Promise<ApiResponse<BuildSpecWithTasks>>): void => {
    setBusy(true);
    void p.then((r) => { onSpec(unwrap(r)); }).catch((e: unknown) => { onError(describeBuildError(e)); }).finally(() => { setBusy(false); });
  };
  const toggleDep = (id: string): void => {
    const next = task.dependsOn.includes(id) ? task.dependsOn.filter((d) => d !== id) : [...task.dependsOn, id];
    run(api.updateBuildTask(task.id, { dependsOn: next }));
  };
  const agentMissing = availableAgents !== null && pending && !availableAgents.includes(task.agent);

  return (
    <li className={`build-task build-task--${task.status}`}>
      <div className="build-task__head">
        <span className="build-task__seq">{task.seq}</span>
        <span className="build-task__title">{task.title}</span>
        <StatusPill kind="task" status={task.status} />
      </div>
      <div className="build-task__meta">
        {pending ? (
          <select className="build-select build-select--compact" value={task.agent} disabled={busy} aria-label="Agent"
            onChange={(e) => { run(api.updateBuildTask(task.id, { agent: e.target.value as BuildAgent })); }}>
            <option value="copilot">Copilot</option>
            <option value="claude">Claude</option>
          </select>
        ) : <span className="build-task__agent">{AGENT_LABEL[task.agent]}</span>}
        <span className="build-task__size" title="Estimated size">{task.size}</span>
        {task.issueUrl !== null && (
          <a className="build-link" href={task.issueUrl} target="_blank" rel="noreferrer">Issue #{task.issueNumber}<Launch size={12} /></a>
        )}
        {task.prUrl !== null && (
          <a className="build-link" href={task.prUrl} target="_blank" rel="noreferrer">PR #{task.prNumber}<Launch size={12} /></a>
        )}
        {task.fixAttempts > 0 && <span className="build-task__note">{task.fixAttempts} fix request{task.fixAttempts === 1 ? '' : 's'}</span>}
      </div>
      {task.agentReason !== '' && pending && <p className="build-task__reason">{task.agentReason}</p>}
      {agentMissing && <p className="build-warning">{AGENT_LABEL[task.agent]} isn’t enabled for this repo. Switch agent or enable it in GitHub.</p>}
      {task.lastError !== null && <p className="build-error build-error--inline">{task.lastError}</p>}

      <div className="build-task__deps">
        <span className="build-field__label">Depends on</span>
        {task.dependsOn.length === 0 && !editingDeps && <span className="build-task__note">nothing, can start straight away</span>}
        {!editingDeps && task.dependsOn.map((d) => <span key={d} className="build-chip">{titleById.get(d) ?? 'removed task'}</span>)}
        {pending && !editingDeps && <button type="button" className="build-text-btn" onClick={() => { setEditingDeps(true); }}>Edit</button>}
      </div>
      {editingDeps && (
        <div className="build-task__dep-editor">
          {tasks.filter((t) => t.id !== task.id).map((t) => (
            <label key={t.id} className="build-check">
              <input type="checkbox" checked={task.dependsOn.includes(t.id)} disabled={busy} onChange={() => { toggleDep(t.id); }} />
              <span>{t.seq}. {t.title}</span>
            </label>
          ))}
          <button type="button" className="kb-import-btn" onClick={() => { setEditingDeps(false); }}>Done</button>
        </div>
      )}

      <details className="build-task__body">
        <summary>Instructions for the agent</summary>
        <pre className="build-pre">{task.bodyMarkdown}</pre>
      </details>

      <div className="build-task__actions">
        {(task.status === 'blocked' || task.status === 'failed' || task.status === 'awaiting_approval') && (
          <button type="button" className="kb-import-btn" disabled={busy} onClick={() => { run(api.buildTaskAction(task.id, 'retry')); }}>Retry</button>
        )}
        {task.prNumber !== null && (task.status === 'awaiting_approval' || task.status === 'blocked' || task.status === 'pr_open') && (
          <button type="button" className="kb-import-btn" disabled={busy}
            onClick={async () => { if (await confirmDialog(`Merge PR #${String(task.prNumber)} now?`, { title: 'Merge pull request', confirmLabel: 'Merge' })) run(api.buildTaskAction(task.id, 'merge')); }}>Merge now</button>
        )}
        {task.status !== 'merged' && task.status !== 'cancelled' && (
          <button type="button" className="kb-import-btn kb-import-btn--danger" disabled={busy}
            onClick={async () => { if (await confirmDialog('Skip this task? Tasks that depend on it will go ahead without it.', { title: 'Skip task', confirmLabel: 'Skip', tone: 'danger' })) run(api.buildTaskAction(task.id, 'cancel')); }}>Skip</button>
        )}
      </div>
    </li>
  );
};

// ── Spec detail ──────────────────────────────────────────────────────────────

const SpecDetail: React.FC<{ specId: string; repos: string[]; onDeleted: () => void; onProtectionChange: (protectedDraft: boolean) => void }> =
  ({ specId, repos, onDeleted, onProtectionChange }) => {
  const qc = useQueryClient();
  const { setAthenaContext } = useAthenaContext();
  const [view, setView] = useState<DocumentViewMode>('md');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const specQuery = useQuery({
    queryKey: ['build-spec', specId],
    queryFn: async () => unwrap(await api.getBuildSpec(specId)),
    refetchInterval: (q) => (q.state.data?.status === 'running' || awaitingFinalMerge(q.state.data) ? RUNNING_POLL_MS : false),
  });
  const spec = specQuery.data;
  const eventsQuery = useQuery({
    queryKey: ['build-events', specId, spec?.updatedAt],
    queryFn: async () => unwrap(await api.listBuildEvents(specId)),
    enabled: spec !== undefined,
  });
  const events = eventsQuery.data ?? EMPTY_BUILD_EVENTS;
  const { data: availableAgents = null } = useQuery({
    queryKey: ['build-agents', spec?.repo],
    queryFn: async () => unwrap(await api.listBuildAgents(spec?.repo ?? '')),
    enabled: spec !== undefined && spec.tasks.some((t) => t.status === 'pending'),
    retry: false,
    staleTime: 5 * 60_000,
  });

  const [draft, setDraft] = useState<{ title: string; repo: string; baseBranch: string; specMarkdown: string; expectedSpecMarkdown: string } | null>(null);
  const [reviewPending, setReviewPending] = useState(false);
  const dirty = spec !== undefined && draft !== null
    && (draft.title !== spec.title || draft.repo !== spec.repo || draft.baseBranch !== spec.baseBranch || draft.specMarkdown !== spec.specMarkdown);
  const draftDirtyRef = useRef(dirty);
  const reviewPendingRef = useRef(reviewPending);
  draftDirtyRef.current = dirty;
  reviewPendingRef.current = reviewPending;
  useEffect(() => {
    onProtectionChange(dirty || reviewPending);
    return () => { onProtectionChange(false); };
  }, [dirty, onProtectionChange, reviewPending]);
  const pageContext = useMemo(() => spec === undefined ? null : buildAthenaContext(spec, events, eventsQuery.isSuccess),
    [spec, events, eventsQuery.isSuccess]);
  useEffect(() => {
    if (pageContext !== null) setAthenaContext(pageContext);
    return () => { if (pageContext !== null) setAthenaContext(null); };
  }, [pageContext, setAthenaContext]);
  useEffect(() => setBuildChatBridge(specId, async () => {
    if (draftDirtyRef.current || reviewPendingRef.current) {
      throw new Error('Save or discard the unsaved Build spec changes and accept or discard pending HTML review feedback before asking Athena to edit this spec.');
    }
    return async changed => {
      if (!changed) return;
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['build-spec', specId] }),
        qc.invalidateQueries({ queryKey: ['build-specs'] }),
        qc.invalidateQueries({ queryKey: ['build-events', specId] }),
      ]);
    };
  }), [qc, specId]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      if (!draftDirtyRef.current && !reviewPendingRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, []);
  useEffect(() => { setDraft(null); setError(null); }, [specId]);

  const applySpec = (s: BuildSpecWithTasks): void => {
    qc.setQueryData(['build-spec', specId], s);
    void qc.invalidateQueries({ queryKey: ['build-specs'] });
    void qc.invalidateQueries({ queryKey: ['build-events', specId] });
  };

  const act = (label: string, p: () => Promise<ApiResponse<BuildSpecWithTasks>>, onSuccess?: (saved: BuildSpecWithTasks) => void): void => {
    setBusy(label); setError(null);
    void p().then((r) => { const saved = unwrap(r); applySpec(saved); onSuccess?.(saved); })
      .catch((e: unknown) => { setError(describeBuildError(e)); void qc.invalidateQueries({ queryKey: ['build-spec', specId] }); })
      .finally(() => { setBusy(null); });
  };

  if (spec === undefined) return <section className="build-detail">
    {specQuery.isPending && <InlineLoading description="Loading spec…" />}
    {specQuery.isError && <DataNotice title="Spec could not be loaded" error={specQuery.error} onRetry={() => { void specQuery.refetch(); }} />}
    {!specQuery.isPending && !specQuery.isError && <p className="build-empty">This spec is unavailable.</p>}
  </section>;

  const editable = EDITABLE.includes(spec.status);
  const branchLocked = spec.workBranch !== null;
  const current = draft ?? { title: spec.title, repo: spec.repo, baseBranch: spec.baseBranch, specMarkdown: spec.specMarkdown, expectedSpecMarkdown: spec.specMarkdown };
  const setBaseBranch = (baseBranch: string): void => { setDraft({ ...current, baseBranch }); };
  const merged = spec.tasks.filter((t) => t.status === 'merged' || t.status === 'cancelled').length;
  const needsYou = spec.tasks.filter((t) => t.status === 'awaiting_approval' || t.status === 'blocked' || t.status === 'failed').length;

  const save = (): void => {
    if (draft === null) return;
    const patch = draft;
    act('save', () => api.updateBuildSpec(spec.id, patch), saved => {
      setDraft(current => current === patch ? null
        : current?.expectedSpecMarkdown === patch.expectedSpecMarkdown ? { ...current, expectedSpecMarkdown: saved.specMarkdown } : current);
    });
  };

  return (
    <section className="build-detail">
      <div className="build-detail__head">
        <div className="build-detail__titles">
          <h2 className="build-detail__title">{spec.title}</h2>
          <p className="build-detail__sub">
            <a className="build-link" href={`https://github.com/${spec.repo}`} target="_blank" rel="noreferrer">{spec.repo}<Launch size={12} /></a>
            <span> · </span><BranchFlow spec={spec} />
            {spec.tasks.length > 0 && <span> · {merged}/{spec.tasks.length} done</span>}
            {needsYou > 0 && <span className="build-detail__attention"> · {needsYou} need{needsYou === 1 ? 's' : ''} you</span>}
          </p>
        </div>
        <StatusPill kind="spec" status={spec.status} />
      </div>

      <div className="build-row build-detail__actions">
        {DECOMPOSABLE.includes(spec.status) && (
          <button type="button" className={spec.tasks.length === 0 ? 'docs-upload-btn' : 'kb-import-btn'} disabled={busy !== null || dirty || reviewPending}
            onClick={async () => {
              if (spec.tasks.length > 0 && !await confirmDialog('Re-decompose? This replaces the current task list.', { title: 'Replace task list', confirmLabel: 'Re-decompose', tone: 'danger' })) return;
              act('decompose', () => api.buildSpecAction(spec.id, 'decompose'));
            }}>
            {busy === 'decompose' ? 'Decomposing…' : spec.tasks.length === 0 ? 'Decompose into tasks' : 'Re-decompose'}
          </button>
        )}
        {(spec.status === 'decomposed' || spec.status === 'paused') && (
          <button type="button" className="docs-upload-btn" disabled={busy !== null || dirty || reviewPending}
            onClick={() => { act('start', () => api.buildSpecAction(spec.id, 'start')); }}>
            {busy === 'start' ? 'Starting…' : spec.status === 'paused' ? 'Resume' : 'Start build'}
          </button>
        )}
        {spec.status === 'running' && (
          <button type="button" className="kb-import-btn" disabled={busy !== null} onClick={() => { act('pause', () => api.buildSpecAction(spec.id, 'pause')); }}>Pause</button>
        )}
        {(spec.status === 'running' || spec.status === 'paused') && (
          <button type="button" className="kb-import-btn" disabled={busy !== null} onClick={() => { act('sync', () => api.buildSpecAction(spec.id, 'sync')); }}>
            {busy === 'sync' ? 'Checking…' : 'Check now'}
          </button>
        )}
        {spec.status !== 'running' && spec.status !== 'decomposing' && (
          <button type="button" className="kb-import-btn kb-import-btn--danger" disabled={busy !== null}
            onClick={async () => {
              if (!await confirmDialog('Delete this spec? Issues and PRs already on GitHub are left as they are.', { title: 'Delete spec', confirmLabel: 'Delete', tone: 'danger' })) return;
              setBusy('delete');
              void api.deleteBuildSpec(spec.id).then(onDeleted).catch((e: unknown) => { setError(describeBuildError(e)); }).finally(() => { setBusy(null); });
            }}>Delete</button>
        )}
      </div>

      <FinalMergePanel spec={spec} busy={busy} onMerge={async () => {
        if (await confirmDialog(`Merge ${spec.workBranch ?? 'the integration branch'} into ${spec.baseBranch}?`, { title: 'Merge integration branch', confirmLabel: 'Merge' })) {
          act('merge-final', () => api.buildSpecAction(spec.id, 'merge-final'));
        }
      }} />

      {specQuery.isError && <DataNotice title="Spec refresh failed; showing the last saved copy" error={specQuery.error} onRetry={() => { void specQuery.refetch(); }} />}
      {error !== null && <p className="build-error">{error}</p>}
      {spec.lastError !== null && error === null && <p className="build-error">{spec.lastError}</p>}

      <details className="build-panel build-spec" open={spec.tasks.length === 0}>
        <summary className="build-section__title">Spec &amp; settings</summary>
        <div className="build-fields">
          <label className="build-field build-field--wide">
            <span className="build-field__label">Title</span>
            <input className="build-input" value={current.title} disabled={!editable} onChange={(e) => { setDraft({ ...current, title: e.target.value }); }} />
          </label>
          <RepoField value={current.repo} repos={repos} disabled={!editable || branchLocked} onChange={(repo) => { setDraft({ ...current, repo, baseBranch: '' }); }} />
          <BranchField repo={current.repo} value={current.baseBranch} disabled={!editable || branchLocked} onChange={setBaseBranch} />
          <WorkBranchToggle checked={spec.useWorkBranch} target={current.baseBranch} disabled={!editable || branchLocked || busy !== null}
            onChange={(useWorkBranch) => { act('settings', () => api.updateBuildSpec(spec.id, { useWorkBranch })); }} />
          <label className="build-field">
            <span className="build-field__label">Agents at once</span>
            <select className="build-select" value={spec.maxParallel} disabled={!editable || busy !== null}
              onChange={(e) => { act('settings', () => api.updateBuildSpec(spec.id, { maxParallel: Number(e.target.value) })); }}>
              {MAX_PARALLEL_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="build-check build-check--field">
            <input type="checkbox" checked={spec.autoMerge} disabled={!editable || busy !== null}
              onChange={(e) => { act('settings', () => api.updateBuildSpec(spec.id, { autoMerge: e.target.checked })); }} />
            <span>Auto-merge when checks pass</span>
          </label>
        </div>
        <DocumentViewToggle value={view} onChange={setView} pendingReview={reviewPending} />
        {view === 'html' ? <DocumentReview key={spec.id} source={current.specMarkdown} version={current.specMarkdown} disabled={!editable || busy !== null} onPendingChange={setReviewPending}
          onApply={proposal => {
            if (current.specMarkdown.split(proposal.find).length !== 2) throw new Error('The source changed. Review it again.');
            setDraft({ ...current, specMarkdown: current.specMarkdown.replace(proposal.find, () => proposal.replacement) });
          }}>
          <DocumentHtmlView markdown={current.specMarkdown} label="Spec HTML view" />
        </DocumentReview> : <label className="build-field build-field--wide">
          <span className="build-field__label">Spec (markdown)</span>
          <textarea className="build-input build-input--spec" rows={16} value={current.specMarkdown} disabled={!editable}
            onChange={(e) => { setDraft({ ...current, specMarkdown: e.target.value }); }} />
        </label>}
        {editable && (
          <div className="build-row">
            <button type="button" className="kb-import-btn" disabled={!dirty || busy !== null || reviewPending} onClick={save}>Save changes</button>
            {dirty && <button type="button" className="kb-import-btn" disabled={busy !== null || reviewPending} onClick={() => { setDraft(null); }}>Discard</button>}
          </div>
        )}
        {!editable && <p className="build-hint">Pause the build to edit the spec or settings.</p>}
      </details>

      {spec.planNotes !== '' && (
        <section className="build-panel">
          <h3 className="build-section__title">Plan notes</h3>
          <p className="build-plan-notes">{spec.planNotes}</p>
        </section>
      )}

      {spec.tasks.length > 0 && (
        <section className="build-section">
          <h3 className="build-section__title">Tasks ({spec.tasks.length})</h3>
          {spec.status === 'decomposed' && <p className="build-hint">Check the agents and dependencies, then start the build. Each task becomes a GitHub issue assigned to its agent.</p>}
          <ol className="build-tasks">
            {spec.tasks.map((t) => (
              <TaskRow key={t.id} task={t} tasks={spec.tasks} availableAgents={availableAgents} onSpec={applySpec} onError={setError} />
            ))}
          </ol>
        </section>
      )}

      <section className="build-section">
        <h3 className="build-section__title">Activity</h3>
        {eventsQuery.isPending && <InlineLoading description="Loading activity…" />}
        {eventsQuery.isError && <DataNotice title="Activity could not be loaded" error={eventsQuery.error} onRetry={() => { void eventsQuery.refetch(); }} />}
        {!eventsQuery.isPending && !eventsQuery.isError && events.length === 0 && <p className="build-empty">No activity recorded yet.</p>}
        {events.length > 0 && <ul className="build-events">
          {events.map((ev) => (
            <li key={ev.id} className={`build-event build-event--${ev.kind}`}>
              <time className="build-event__time">{shortDate(ev.createdAt)}</time>
              <span className="build-event__msg">{ev.message}</span>
            </li>
          ))}
        </ul>}
      </section>
    </section>
  );
};

// ── Page ─────────────────────────────────────────────────────────────────────

const SpecListItem: React.FC<{ spec: BuildSpecSummary; active: boolean; onSelect: () => void }> = ({ spec, active, onSelect }) => {
  const done = (spec.taskCounts.merged ?? 0) + (spec.taskCounts.cancelled ?? 0);
  return (
    <li>
      <button type="button" aria-current={active ? 'true' : undefined} className={`build-list__item${active ? ' build-list__item--active' : ''}`} onClick={onSelect}>
        <span className="build-list__title">{spec.title}</span>
        <span className="build-list__meta">
          <StatusPill kind="spec" status={spec.status} />
          <span className="build-list__repo">{spec.repo}</span>
          {spec.taskTotal > 0 && <span>{done}/{spec.taskTotal}</span>}
        </span>
      </button>
    </li>
  );
};

export const BuildPage: React.FC = () => {
  const qc = useQueryClient();
  const repos = useGithubRepos();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('spec');
  const [protectedDraft, setProtectedDraft] = useState(false);
  const protectedDraftRef = useRef(protectedDraft);
  protectedDraftRef.current = protectedDraft;
  const specsQuery = useQuery({
    queryKey: ['build-specs'],
    queryFn: async () => unwrap(await api.listBuildSpecs()),
    refetchInterval: (q) => (q.state.data?.some((s) => s.status === 'running') === true ? RUNNING_POLL_MS : false),
  });
  const specs = specsQuery.data ?? [];
  const confirmLeave = useCallback(async (): Promise<boolean> => {
    if (!protectedDraftRef.current) return true;
    return confirmDialog('Discard the unsaved Build spec changes or unaccepted HTML review feedback and leave this spec?', {
      title: 'Leave spec editor?', confirmLabel: 'Discard and leave', tone: 'danger',
    });
  }, []);
  const select = (id: string | null): void => {
    void (async () => {
      if (id !== selectedId && !await confirmLeave()) return;
      setProtectedDraft(false);
      setParams(id === null ? {} : { spec: id }, { replace: true });
    })();
  };
  useEffect(() => {
    const guard = (event: MouseEvent): void => {
      if (!protectedDraftRef.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (destination.pathname === location.pathname && destination.search === location.search && destination.hash === location.hash) return;
      event.preventDefault();
      event.stopPropagation();
      void confirmLeave().then(confirmed => {
        if (confirmed) navigate(`${destination.pathname}${destination.search}${destination.hash}`);
      });
    };
    document.addEventListener('click', guard, true);
    return () => { document.removeEventListener('click', guard, true); };
  }, [confirmLeave, location.hash, location.pathname, location.search, navigate]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      if (!protectedDraftRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, []);

  return (
    <main className="build-page">
      <PageHeader title="Build" subtitle="Turn a spec into tasks for GitHub’s cloud coding agents, then follow each PR through to merge." actions={
        <button type="button" className="docs-upload-btn" onClick={() => { void (async () => {
          if (!await confirmLeave()) return;
          setProtectedDraft(false);
          navigate('/think?new=spec');
        })(); }}><Add size={20} /> New spec</button>
      } />

      <div className="build-layout">
        <aside className="build-list" aria-label="Specs">
          {specsQuery.isPending && <InlineLoading description="Loading…" />}
          {specsQuery.isError && <DataNotice title="Build specs could not be loaded" error={specsQuery.error} onRetry={() => { void specsQuery.refetch(); }} />}
          {!specsQuery.isPending && !specsQuery.isError && specs.length === 0 && (
            <p className="build-empty">No specs yet. Create a spec in Think using “New spec”, then “Send to Build”; or send an Athena output.</p>
          )}
          <ul className="build-list__items">
            {specs.map((s) => <SpecListItem key={s.id} spec={s} active={s.id === selectedId} onSelect={() => { select(s.id); }} />)}
          </ul>
        </aside>

        <div className="build-main">
          {selectedId !== null && (
            <SpecDetail specId={selectedId} repos={repos}
              onProtectionChange={setProtectedDraft}
              onDeleted={() => { void qc.invalidateQueries({ queryKey: ['build-specs'] }); select(null); }} />
          )}
          {selectedId === null && (
            <p className="build-empty build-empty--main">
              {specs.length === 0
                ? 'Your spec and build progress will appear here.'
                : 'Pick a spec on the left, or start a new one.'}
            </p>
          )}
        </div>
      </div>
    </main>
  );
};
