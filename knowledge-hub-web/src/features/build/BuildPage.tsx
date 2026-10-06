/**
 * features/build/BuildPage.tsx — the Build pipeline: write (or send in) a
 * GHCP spec, decompose it into dependency-ordered tasks, then hand each task
 * to a GitHub cloud coding agent (Copilot or Claude) and follow the PRs
 * through to merge.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { InlineLoading } from '@carbon/react';
import { Add, Launch } from '@carbon/icons-react';
import {
  api,
  type BuildAgent,
  type BuildSpecStatus,
  type BuildSpecSummary,
  type BuildSpecWithTasks,
  type BuildTask,
  type BuildTaskStatus,
} from '../../services/api';
import type { ApiResponse } from '../../types/apiResponse';
import { BranchField, describeBuildError, RepoField, unwrap, useGithubRepos } from './buildShared';

const RUNNING_POLL_MS = 20_000;
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

function shortDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const StatusPill: React.FC<{ kind: 'spec' | 'task'; status: BuildSpecStatus | BuildTaskStatus }> = ({ kind, status }) => (
  <span className={`build-pill build-pill--${status}`}>
    {kind === 'spec' ? SPEC_STATUS_LABEL[status as BuildSpecStatus] : TASK_STATUS_LABEL[status as BuildTaskStatus]}
  </span>
);

// ── New spec ─────────────────────────────────────────────────────────────────

const NewSpecForm: React.FC<{ repos: string[]; onCreated: (id: string) => void; onCancel: () => void }> = ({ repos, onCreated, onCancel }) => {
  const [draft, setDraft] = useState({ title: '', repo: '', baseBranch: '', specMarkdown: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setBaseBranch = useCallback((baseBranch: string) => { setDraft((d) => ({ ...d, baseBranch })); }, []);
  const create = (): void => {
    setBusy(true); setError(null);
    void api.createBuildSpec({
      title: draft.title, repo: draft.repo, specMarkdown: draft.specMarkdown,
      ...(draft.baseBranch.trim() !== '' ? { baseBranch: draft.baseBranch.trim() } : {}),
    }).then((r) => { onCreated(unwrap(r).id); })
      .catch((e: unknown) => { setError(describeBuildError(e)); })
      .finally(() => { setBusy(false); });
  };
  return (
    <section className="build-panel build-new">
      <h2 className="build-section__title">New spec</h2>
      {error !== null && <p className="build-error">{error}</p>}
      <div className="build-fields">
        <label className="build-field build-field--wide">
          <span className="build-field__label">Title</span>
          <input className="build-input" value={draft.title} autoFocus onChange={(e) => { setDraft({ ...draft, title: e.target.value }); }} />
        </label>
        <RepoField value={draft.repo} repos={repos} onChange={(repo) => { setDraft((d) => ({ ...d, repo, baseBranch: '' })); }} />
        <BranchField repo={draft.repo} value={draft.baseBranch} onChange={setBaseBranch} />
      </div>
      <label className="build-field build-field--wide">
        <span className="build-field__label">Spec (markdown)</span>
        <textarea className="build-input build-input--spec" rows={14} value={draft.specMarkdown}
          placeholder="Goal, scope, acceptance criteria, constraints… or send a Think note / Athena output here instead."
          onChange={(e) => { setDraft({ ...draft, specMarkdown: e.target.value }); }} />
      </label>
      <div className="build-row">
        <button type="button" className="docs-upload-btn" disabled={busy || draft.title.trim() === '' || draft.repo.trim() === ''} onClick={create}>
          {busy ? 'Creating…' : 'Create spec'}
        </button>
        <button type="button" className="kb-import-btn" onClick={onCancel}>Cancel</button>
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
            onClick={() => { if (window.confirm(`Merge PR #${String(task.prNumber)} now?`)) run(api.buildTaskAction(task.id, 'merge')); }}>Merge now</button>
        )}
        {task.status !== 'merged' && task.status !== 'cancelled' && (
          <button type="button" className="kb-import-btn kb-import-btn--danger" disabled={busy}
            onClick={() => { if (window.confirm('Skip this task? Tasks that depend on it will go ahead without it.')) run(api.buildTaskAction(task.id, 'cancel')); }}>Skip</button>
        )}
      </div>
    </li>
  );
};

// ── Spec detail ──────────────────────────────────────────────────────────────

const SpecDetail: React.FC<{ specId: string; repos: string[]; onDeleted: () => void }> = ({ specId, repos, onDeleted }) => {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { data: spec, isLoading } = useQuery({
    queryKey: ['build-spec', specId],
    queryFn: async () => unwrap(await api.getBuildSpec(specId)),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? RUNNING_POLL_MS : false),
  });
  const { data: events = [] } = useQuery({
    queryKey: ['build-events', specId, spec?.updatedAt],
    queryFn: async () => unwrap(await api.listBuildEvents(specId)),
    enabled: spec !== undefined,
  });
  const { data: availableAgents = null } = useQuery({
    queryKey: ['build-agents', spec?.repo],
    queryFn: async () => unwrap(await api.listBuildAgents(spec?.repo ?? '')),
    enabled: spec !== undefined && spec.tasks.some((t) => t.status === 'pending'),
    retry: false,
    staleTime: 5 * 60_000,
  });

  const [draft, setDraft] = useState<{ title: string; repo: string; baseBranch: string; specMarkdown: string } | null>(null);
  useEffect(() => { setDraft(null); setError(null); }, [specId]);

  const applySpec = (s: BuildSpecWithTasks): void => {
    qc.setQueryData(['build-spec', specId], s);
    void qc.invalidateQueries({ queryKey: ['build-specs'] });
    void qc.invalidateQueries({ queryKey: ['build-events', specId] });
  };

  const act = (label: string, p: () => Promise<ApiResponse<BuildSpecWithTasks>>): void => {
    setBusy(label); setError(null);
    void p().then((r) => { applySpec(unwrap(r)); })
      .catch((e: unknown) => { setError(describeBuildError(e)); void qc.invalidateQueries({ queryKey: ['build-spec', specId] }); })
      .finally(() => { setBusy(null); });
  };

  if (isLoading || spec === undefined) return <section className="build-detail"><InlineLoading description="Loading spec…" /></section>;

  const editable = EDITABLE.includes(spec.status);
  const current = draft ?? { title: spec.title, repo: spec.repo, baseBranch: spec.baseBranch, specMarkdown: spec.specMarkdown };
  const dirty = draft !== null && (draft.title !== spec.title || draft.repo !== spec.repo || draft.baseBranch !== spec.baseBranch || draft.specMarkdown !== spec.specMarkdown);
  const setBaseBranch = (baseBranch: string): void => { setDraft({ ...current, baseBranch }); };
  const merged = spec.tasks.filter((t) => t.status === 'merged' || t.status === 'cancelled').length;
  const needsYou = spec.tasks.filter((t) => t.status === 'awaiting_approval' || t.status === 'blocked' || t.status === 'failed').length;

  const save = (): void => {
    if (draft === null) return;
    const patch = draft;
    act('save', () => api.updateBuildSpec(spec.id, patch));
    setDraft(null);
  };

  return (
    <section className="build-detail">
      <div className="build-detail__head">
        <div className="build-detail__titles">
          <h2 className="build-detail__title">{spec.title}</h2>
          <p className="build-detail__sub">
            <a className="build-link" href={`https://github.com/${spec.repo}`} target="_blank" rel="noreferrer">{spec.repo}<Launch size={12} /></a>
            <span> · {spec.baseBranch}</span>
            {spec.tasks.length > 0 && <span> · {merged}/{spec.tasks.length} done</span>}
            {needsYou > 0 && <span className="build-detail__attention"> · {needsYou} need{needsYou === 1 ? 's' : ''} you</span>}
          </p>
        </div>
        <StatusPill kind="spec" status={spec.status} />
      </div>

      <div className="build-row build-detail__actions">
        {DECOMPOSABLE.includes(spec.status) && (
          <button type="button" className={spec.tasks.length === 0 ? 'docs-upload-btn' : 'kb-import-btn'} disabled={busy !== null || dirty}
            onClick={() => {
              if (spec.tasks.length > 0 && !window.confirm('Re-decompose? This replaces the current task list.')) return;
              act('decompose', () => api.buildSpecAction(spec.id, 'decompose'));
            }}>
            {busy === 'decompose' ? 'Decomposing…' : spec.tasks.length === 0 ? 'Decompose into tasks' : 'Re-decompose'}
          </button>
        )}
        {(spec.status === 'decomposed' || spec.status === 'paused') && (
          <button type="button" className="docs-upload-btn" disabled={busy !== null || dirty}
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
            onClick={() => {
              if (!window.confirm('Delete this spec? Issues and PRs already on GitHub are left as they are.')) return;
              setBusy('delete');
              void api.deleteBuildSpec(spec.id).then(onDeleted).catch((e: unknown) => { setError(describeBuildError(e)); }).finally(() => { setBusy(null); });
            }}>Delete</button>
        )}
      </div>

      {error !== null && <p className="build-error">{error}</p>}
      {spec.lastError !== null && error === null && <p className="build-error">{spec.lastError}</p>}

      <details className="build-panel build-spec" open={spec.tasks.length === 0}>
        <summary className="build-section__title">Spec &amp; settings</summary>
        <div className="build-fields">
          <label className="build-field build-field--wide">
            <span className="build-field__label">Title</span>
            <input className="build-input" value={current.title} disabled={!editable} onChange={(e) => { setDraft({ ...current, title: e.target.value }); }} />
          </label>
          <RepoField value={current.repo} repos={repos} disabled={!editable} onChange={(repo) => { setDraft({ ...current, repo, baseBranch: '' }); }} />
          <BranchField repo={current.repo} value={current.baseBranch} disabled={!editable} onChange={setBaseBranch} />
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
        <label className="build-field build-field--wide">
          <span className="build-field__label">Spec (markdown)</span>
          <textarea className="build-input build-input--spec" rows={16} value={current.specMarkdown} disabled={!editable}
            onChange={(e) => { setDraft({ ...current, specMarkdown: e.target.value }); }} />
        </label>
        {editable && (
          <div className="build-row">
            <button type="button" className="kb-import-btn" disabled={!dirty || busy !== null} onClick={save}>Save changes</button>
            {dirty && <button type="button" className="kb-import-btn" onClick={() => { setDraft(null); }}>Discard</button>}
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

      {events.length > 0 && (
        <section className="build-section">
          <h3 className="build-section__title">Activity</h3>
          <ul className="build-events">
            {events.map((ev) => (
              <li key={ev.id} className={`build-event build-event--${ev.kind}`}>
                <time className="build-event__time">{shortDate(ev.createdAt)}</time>
                <span className="build-event__msg">{ev.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
};

// ── Page ─────────────────────────────────────────────────────────────────────

const SpecListItem: React.FC<{ spec: BuildSpecSummary; active: boolean; onSelect: () => void }> = ({ spec, active, onSelect }) => {
  const done = (spec.taskCounts.merged ?? 0) + (spec.taskCounts.cancelled ?? 0);
  return (
    <li>
      <button type="button" className={`build-list__item${active ? ' build-list__item--active' : ''}`} onClick={onSelect}>
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
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('spec');
  const [creating, setCreating] = useState(false);
  const { data: specs = [], isLoading } = useQuery({
    queryKey: ['build-specs'],
    queryFn: async () => unwrap(await api.listBuildSpecs()),
    refetchInterval: (q) => (q.state.data?.some((s) => s.status === 'running') === true ? RUNNING_POLL_MS : false),
  });
  const select = (id: string | null): void => {
    setCreating(false);
    setParams(id === null ? {} : { spec: id }, { replace: true });
  };

  return (
    <div className="build-page">
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Build</h1>
          <p className="page-subtitle">Turn a spec into tasks for GitHub’s cloud coding agents, then follow each PR through to merge.</p>
        </div>
        <button type="button" className="docs-upload-btn" onClick={() => { setCreating(true); }}><Add size={20} /> New spec</button>
      </div>

      <div className="build-layout">
        <aside className="build-list" aria-label="Specs">
          {isLoading && <InlineLoading description="Loading…" />}
          {!isLoading && specs.length === 0 && (
            <p className="build-empty">No specs yet. Create one here, or use “Send to Build” on a Think note or an Athena output.</p>
          )}
          <ul className="build-list__items">
            {specs.map((s) => <SpecListItem key={s.id} spec={s} active={!creating && s.id === selectedId} onSelect={() => { select(s.id); }} />)}
          </ul>
        </aside>

        <div className="build-main">
          {creating && (
            <NewSpecForm repos={repos} onCancel={() => { setCreating(false); }}
              onCreated={(id) => { void qc.invalidateQueries({ queryKey: ['build-specs'] }); select(id); }} />
          )}
          {!creating && selectedId !== null && (
            <SpecDetail specId={selectedId} repos={repos}
              onDeleted={() => { void qc.invalidateQueries({ queryKey: ['build-specs'] }); select(null); }} />
          )}
          {!creating && selectedId === null && (
            <p className="build-empty build-empty--main">Pick a spec on the left, or start a new one.</p>
          )}
        </div>
      </div>
    </div>
  );
};
