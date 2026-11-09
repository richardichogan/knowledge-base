/**
 * Plan › Drafts — every email and Slack/Teams message Athena (or Richard) has drafted.
 * Athena cannot send anything: drafts are reviewed and edited here, copied, sent by hand and marked Sent.
 * The open draft uses the normal note editor, so its fields, properties and Athena tools are unchanged.
 */
import React, { useEffect, useId, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Chat, Email } from '@carbon/icons-react';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { extractNoteBlockText, fetchNote, type NoteContentBlock } from '../../notes/noteStorage';
import { athenaLinkText } from '../../notes/linkLabels';
import { deferredView } from '../../utils/deferredView';
import { useAthenaContext } from '../../context/AthenaContext';
import { DRAFT_CHANNEL_LABELS, type DraftSummary } from '../../types/workContent';
import './drafts.scss';

const NoteEditor = deferredView('Draft', async () => ({ default: (await import('../../notes/NoteEditor')).NoteEditor }));
export const DRAFTS_KEY = ['work-drafts'] as const;

const relative = (iso: string): string => {
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days < 1) return then.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (days < 7) return then.toLocaleDateString('en-GB', { weekday: 'short' });
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

const DraftRow: React.FC<{ draft: DraftSummary; active: boolean; onOpen: () => void }> = ({ draft, active, onOpen }) => {
  const Icon = draft.channel === 'email' ? Email : Chat;
  return <li>
    <button type="button" className={`kh-drafts__row${active ? ' kh-drafts__row--active' : ''}`} aria-current={active ? 'true' : undefined} onClick={onOpen}>
      <span className={`kh-drafts__channel kh-drafts__channel--${draft.channel}`} title={DRAFT_CHANNEL_LABELS[draft.channel]}>
        <Icon size={16} aria-hidden="true" /><span className="kh-drafts__sr">{DRAFT_CHANNEL_LABELS[draft.channel]}</span>
      </span>
      <span className="kh-drafts__text">
        <span className="kh-drafts__title">{draft.subject || draft.title.replace(/^(Email|Message) draft:\s*/i, '')}</span>
        <span className="kh-drafts__meta">{draft.channel !== 'email' && `${DRAFT_CHANNEL_LABELS[draft.channel]} · `}{draft.to ? `To ${draft.to}` : 'No recipient yet'}{draft.taskTitle ? ` · ${draft.taskTitle}` : ''}</span>
      </span>
      <time className="kh-drafts__when" dateTime={draft.sentAt ?? draft.updatedAt}>{relative(draft.sentAt ?? draft.updatedAt)}</time>
    </button>
  </li>;
};

export const DraftsView: React.FC<{ selectId: string | null }> = ({ selectId }) => {
  const fid = useId();
  const qc = useQueryClient();
  // Mark Sent happens inside the editor's properties, so poll lightly to move a sent draft into its group.
  const drafts = useQuery({ queryKey: DRAFTS_KEY, queryFn: async () => requireApiData(await api.getDrafts()), refetchInterval: 20_000 });
  const items = useMemo(() => drafts.data ?? [], [drafts.data]);
  const [selected, setSelected] = useState<string | null>(selectId);
  useEffect(() => { if (selectId) setSelected(selectId); }, [selectId]);
  useEffect(() => {
    if (!drafts.data) return;
    if (!selected || !drafts.data.some(draft => draft.noteId === selected)) setSelected(drafts.data[0]?.noteId ?? null);
  }, [drafts.data, selected]);
  const groups = [
    { key: 'review', title: 'To review', items: items.filter(draft => draft.status === 'draft') },
    { key: 'sent', title: 'Sent', items: items.filter(draft => draft.status === 'sent') },
  ];
  const active = items.find(draft => draft.noteId === selected) ?? null;
  const doc = useQuery({
    queryKey: ['draft-document', selected],
    queryFn: async () => {
      const note = await fetchNote(selected!);
      if (!note) throw new Error('This draft is unavailable.');
      return note;
    },
    enabled: !!selected, refetchOnWindowFocus: false,
  });

  const { setAthenaContext } = useAthenaContext();
  useEffect(() => {
    const list = `Plan › Drafts (${groups[0]!.items.length} to review, ${groups[1]!.items.length} sent). Athena cannot send email, Slack or Teams; Richard copies and sends drafts himself. Use list_drafts for every draft and read_work_content for a full body.\n`
      + items.slice(0, 40).map(draft => `- ${draft.noteId}: [${DRAFT_CHANNEL_LABELS[draft.channel]}, ${draft.status}] ${draft.subject || draft.title}${draft.to ? ` → ${draft.to}` : ''}${draft.taskTitle ? ` (task: ${draft.taskTitle})` : ''}`).join('\n');
    if (!doc.data || !active) {
      setAthenaContext({ type: 'drafts', id: 'plan-drafts', title: 'Drafts', detail: list });
      return;
    }
    let body = '';
    try {
      const blocks: unknown = JSON.parse(doc.data.contentJson);
      if (Array.isArray(blocks)) body = extractNoteBlockText(blocks as NoteContentBlock[], athenaLinkText);
    } catch { /* an unreadable body stays out of the context */ }
    setAthenaContext({ type: 'note', id: doc.data.id, title: doc.data.title, workContentId: doc.data.id,
      detail: `Open draft (${DRAFT_CHANNEL_LABELS[active.channel]}, ${active.status === 'sent' ? 'marked Sent' : 'not sent'}). To: ${active.to || 'not set'}${active.subject ? `. Subject: ${active.subject}` : ''}${active.taskTitle ? `. Linked task: ${active.taskTitle}` : ''}.\nUse update_email_draft with the current revisions to edit it.\n\nDraft body:\n${body}\n\n${list}`,
      ...(doc.data.projectId ? { projectId: doc.data.projectId } : {}) });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- groups derive from items
  }, [doc.data, active, items, setAthenaContext]);
  useEffect(() => () => { setAthenaContext(null); }, [setAthenaContext]);

  const refresh = (): void => { void qc.invalidateQueries({ queryKey: DRAFTS_KEY }); };

  return <div className="kh-drafts">
    <nav className="kh-drafts__list" aria-label="Drafts">
      {drafts.isPending && <p className="kh-drafts__status" role="status">Loading drafts…</p>}
      {drafts.isError && <div className="kh-drafts__status" role="alert">
        <p>Drafts could not be loaded: {describeApiError(drafts.error)}</p>
        <button type="button" className="kh-btn-ghost" onClick={() => { void drafts.refetch(); }}>Retry</button>
      </div>}
      {drafts.isSuccess && items.length === 0 && <div className="kh-drafts__empty">
        <h2>No drafts yet</h2>
        <p>When Athena drafts an email or a Slack or Teams message for a task, it appears here for you to review, copy and send yourself.</p>
      </div>}
      {groups.map(group => group.items.length > 0 && <section key={group.key} aria-labelledby={`${fid}-${group.key}`}>
        <h2 id={`${fid}-${group.key}`} className="kh-drafts__group">{group.title} <span>{group.items.length}</span></h2>
        <ul>{group.items.map(draft => <DraftRow key={draft.noteId} draft={draft} active={draft.noteId === selected}
          onOpen={() => { setSelected(draft.noteId); }} />)}</ul>
      </section>)}
    </nav>
    <div className="kh-drafts__editor">
      {!selected ? (drafts.isSuccess && items.length > 0 && <p className="kh-drafts__status">Choose a draft to review it.</p>)
        : doc.isError ? <p className="kh-drafts__status" role="alert">This draft could not be opened: {describeApiError(doc.error)}</p>
        : !doc.data ? <p className="kh-drafts__status" role="status">Opening draft…</p>
        : <NoteEditor key={doc.data.id} doc={doc.data}
          onSaved={updated => { qc.setQueryData(['draft-document', updated.id], updated); refresh(); }}
          onDelete={() => { setSelected(null); refresh(); }} />}
    </div>
  </div>;
};
