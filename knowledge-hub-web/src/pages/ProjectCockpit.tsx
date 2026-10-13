import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, InlineLoading, Modal, Select, SelectItem, Tag, TextInput } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataNotice } from '../components/DataNotice';
import { api } from '../services/api';
import type {
  CockpitLink, CockpitSection, ProjectCockpit, ProjectRegisterItem, ProjectRegisterKind, ProjectRegisterInput,
} from '../services/api';
import { describeApiError, requireApiData } from '../services/apiError';
import './ProjectCockpit.css';
import { ReviewPackets } from './ReviewPackets';

const KIND_LABEL: Record<ProjectRegisterKind, string> = { question: 'Question', risk: 'Risk', issue: 'Issue' };
const PAGE = 25;
const when = (iso: string | null): string => (iso === null ? '' : new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' }));

const Unavailable: React.FC<{ title: string }> = ({ title }) => (
  <p className="pcp-unavailable" role="status">{title} could not be loaded. The rest of the cockpit is unaffected.</p>
);

interface LinkListProps {
  title: string;
  section: CockpitSection<CockpitLink[]>;
  empty: string;
  action?: (link: CockpitLink) => React.ReactNode;
}

const LinkList: React.FC<LinkListProps> = ({ title, section, empty, action }) => (
  <section className="pcp-block" aria-label={title}>
    <h3>{title}{section.available && <span className="pcp-count">{section.total}</span>}</h3>
    {!section.available ? <Unavailable title={title} /> : section.data.length === 0 ? <p className="pcp-empty">{empty}</p> : (
      <>
        <ul className="pcp-list">
          {section.data.map((link, index) => (
            <li key={`${link.href}-${link.sourceId ?? index}`}>
              <a href={link.href}>{link.label}</a>
              <span className="pcp-meta">{[link.meta, when(link.at)].filter(Boolean).join(' · ')}</span>
              {action?.(link)}
            </li>
          ))}
        </ul>
        {section.truncated && <p className="pcp-more">Showing the {section.data.length} most recent of {section.total}.</p>}
      </>
    )}
  </section>
);

const RegisterRow: React.FC<{ item: ProjectRegisterItem; busy: boolean; onChange: (input: ProjectRegisterInput) => void; onDelete: () => void }> = ({ item, busy, onChange, onDelete }) => {
  const [resolution, setResolution] = useState(item.resolution);
  return (
    <li className={`pcp-reg pcp-reg--${item.status}`}>
      <div className="pcp-reg__head">
        <Tag size="sm" type={item.kind === 'risk' ? 'red' : item.kind === 'issue' ? 'magenta' : 'blue'}>{KIND_LABEL[item.kind]}</Tag>
        <strong>{item.title}</strong>
        {item.sourceType === 'chat_decision' && <span className="pcp-meta">from a chat decision</span>}
      </div>
      <div className="pcp-reg__fields">
        <TextInput id={`own-${item.id}`} labelText="Owner" size="sm" defaultValue={item.owner} maxLength={200}
          onBlur={(e) => { if (e.target.value.trim() !== item.owner) onChange({ owner: e.target.value }); }} />
        <TextInput id={`due-${item.id}`} labelText="Due" type="date" size="sm" defaultValue={item.dueDate ?? ''}
          onBlur={(e) => { if (e.target.value !== (item.dueDate ?? '')) onChange({ dueDate: e.target.value === '' ? null : e.target.value }); }} />
        {item.status === 'open' ? (
          <TextInput id={`res-${item.id}`} labelText="Resolution" size="sm" value={resolution} maxLength={4000}
            placeholder="How was it resolved?" onChange={(e) => setResolution(e.target.value)} />
        ) : <p className="pcp-resolution"><strong>Resolved{item.resolvedAt ? ` ${when(item.resolvedAt)}` : ''}.</strong> {item.resolution}</p>}
      </div>
      <div className="pcp-reg__actions">
        {item.status === 'open'
          ? <Button kind="tertiary" size="sm" disabled={busy} onClick={() => onChange({ status: 'resolved', resolution })}>Resolve</Button>
          : <Button kind="ghost" size="sm" disabled={busy} onClick={() => onChange({ status: 'open' })}>Reopen</Button>}
        <Button kind="danger--ghost" size="sm" disabled={busy} onClick={onDelete}>Delete</Button>
      </div>
    </li>
  );
};

const Register: React.FC<{ projectId: string }> = ({ projectId }) => {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [offset, setOffset] = useState(0);
  const [kind, setKind] = useState<ProjectRegisterKind>('question');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const key = ['project-register', projectId, status, offset];
  const list = useQuery({
    queryKey: key,
    queryFn: async () => requireApiData(await api.getProjectRegister(projectId, { status, limit: PAGE, offset })),
    retry: false, refetchOnWindowFocus: false,
  });
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['project-register', projectId] });
    void qc.invalidateQueries({ queryKey: ['project-cockpit', projectId] });
  };
  const mutate = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => { await run(); },
    onSuccess: () => { setError(null); refresh(); },
    onError: (err) => setError(describeApiError(err)),
  });
  const total = list.data?.total ?? 0;

  return (
    <section className="pcp-block" aria-label="Register">
      <h3>Questions, risks and issues{list.data && <span className="pcp-count">{total}</span>}</h3>
      <div className="pcp-reg__tabs" role="group" aria-label="Register state">
        {(['open', 'resolved'] as const).map((s) => (
          <Button key={s} size="sm" kind={status === s ? 'secondary' : 'ghost'} aria-pressed={status === s}
            onClick={() => { setStatus(s); setOffset(0); }}>{s === 'open' ? 'Open' : 'Resolved'}</Button>
        ))}
      </div>
      <form className="pcp-reg__new" onSubmit={(e) => {
        e.preventDefault();
        const trimmed = title.trim();
        if (trimmed === '') return;
        mutate.mutate(() => api.createProjectRegisterItem(projectId, { kind, title: trimmed }).then(requireApiData).then(() => setTitle('')));
      }}>
        <Select id="pcp-kind" labelText="Type" size="sm" value={kind} onChange={(e) => setKind(e.target.value as ProjectRegisterKind)}>
          {(Object.keys(KIND_LABEL) as ProjectRegisterKind[]).map((k) => <SelectItem key={k} value={k} text={KIND_LABEL[k]} />)}
        </Select>
        <TextInput id="pcp-title" labelText="What needs tracking?" size="sm" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
        <Button type="submit" size="sm" disabled={title.trim() === '' || mutate.isPending}>Add</Button>
      </form>
      {error && <DataNotice title="The register was not updated." error={error} />}
      {list.isLoading ? <InlineLoading description="Loading register…" /> : list.error ? (
        <DataNotice title="The register could not be loaded." error={list.error} onRetry={() => { void list.refetch(); }} />
      ) : list.data?.items.length === 0 ? <p className="pcp-empty">Nothing {status} here.</p> : (
        <ul className="pcp-reg__list">
          {list.data?.items.map((item) => (
            <RegisterRow key={`${item.id}-${item.updatedAt}`} item={item} busy={mutate.isPending}
              onChange={(input) => mutate.mutate(() => api.updateProjectRegisterItem(projectId, item.id, input).then(requireApiData))}
              onDelete={() => mutate.mutate(() => api.deleteProjectRegisterItem(projectId, item.id))} />
          ))}
        </ul>
      )}
      {total > PAGE && (
        <div className="pcp-pager">
          <Button size="sm" kind="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(offset - PAGE, 0))}>Previous</Button>
          <span>{offset + 1}–{Math.min(offset + PAGE, total)} of {total}</span>
          <Button size="sm" kind="ghost" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
        </div>
      )}
    </section>
  );
};

export const ProjectCockpitModal: React.FC<{ projectId: string | null; projectName: string; onClose: () => void }> = ({ projectId, projectName, onClose }) => {
  const qc = useQueryClient();
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [promoted, setPromoted] = useState<Set<string>>(new Set());
  const cockpit = useQuery<ProjectCockpit>({
    queryKey: ['project-cockpit', projectId],
    queryFn: async () => requireApiData(await api.getProjectCockpit(projectId ?? '')),
    enabled: projectId !== null, retry: false, refetchOnWindowFocus: false,
  });
  const data = cockpit.data;
  const promote = async (link: CockpitLink): Promise<void> => {
    if (projectId === null || link.sourceId === undefined) return;
    setPromoteError(null);
    try {
      requireApiData(await api.promoteProjectDecision(projectId, link.sourceId, 'question'));
      setPromoted((prev) => new Set(prev).add(link.sourceId ?? ''));
      void qc.invalidateQueries({ queryKey: ['project-register', projectId] });
      void qc.invalidateQueries({ queryKey: ['project-cockpit', projectId] });
    } catch (err) {
      setPromoteError(describeApiError(err));
    }
  };

  if (projectId === null) return null;

  return createPortal(
    <Modal
      open
      passiveModal
      size="lg"
      hasScrollingContent
      modalLabel="Project Cockpit"
      modalHeading={projectName}
      onRequestClose={onClose}
      className="pcp-modal"
    >
      <div className="pcp">
        {cockpit.isLoading && <InlineLoading description="Loading cockpit…" />}
        {cockpit.error && <DataNotice title="The cockpit could not be loaded." error={cockpit.error} onRetry={() => { void cockpit.refetch(); }} />}
        {data && (
          <>
            <section className="pcp-outcome" aria-label="Outcome">
              {data.outcome.available ? (
                <>
                  <p className="pcp-goal">{data.outcome.data.goal || 'No goal recorded for this project yet.'}</p>
                  <p className="pcp-meta">
                    {data.outcome.data.lifecycleState}
                    {data.outcome.data.targetEndDate ? ` · target ${data.outcome.data.targetEndDate}` : ''}
                    {` · ${data.outcome.data.expectedOutputs.length} expected outputs`}
                  </p>
                  {data.outcome.data.expectedOutputs.length > 0 && (
                    <ul className="pcp-outputs">{data.outcome.data.expectedOutputs.map((o, i) => <li key={i}>{o}</li>)}</ul>
                  )}
                </>
              ) : <Unavailable title="Outcome" />}
              <p className="pcp-meta">Counts come from linked items only; no completion score is inferred. Updated {new Date(data.generatedAt).toLocaleTimeString('en-GB')}.</p>
            </section>

            <h2 className="pcp-step">Actionable work</h2>
            <LinkList title="Blockers" section={data.blockers} empty="No blocked tasks." />
            <LinkList title="Open commitments" section={data.commitments} empty="No open tasks linked to this project." />
            <Register projectId={projectId} />
            <ReviewPackets projectId={projectId} />

            <details className="pcp-evidence">
              <summary>Supporting evidence</summary>
              {promoteError && <DataNotice title="The decision was not promoted." error={promoteError} />}
              <LinkList title="Chat decisions" section={data.decisions} empty="No chat decisions for this project."
                action={(link) => link.sourceId === undefined ? null : (
                  <Button kind="ghost" size="sm" disabled={promoted.has(link.sourceId)} onClick={() => { void promote(link); }}>
                    {promoted.has(link.sourceId) ? 'In register' : 'Add to register'}
                  </Button>
                )} />
              <LinkList title="Recent notes" section={data.notes} empty="No notes filed to this project." />
              <LinkList title="Outputs" section={data.outputs} empty="No chat outputs for this project." />
            </details>
          </>
        )}
      </div>
    </Modal>,
    document.body
  );
};
