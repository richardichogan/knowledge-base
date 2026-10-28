import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FormattingToolbar, FormattingToolbarController, getFormattingToolbarItems } from '@blocknote/react';
import type { BlockNoteEditor } from '@blocknote/core';
import { TextSelection } from '@tiptap/pm/state';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { requireApiData } from '../services/apiError';
import { confirmDialog } from '../services/appDialogs';
import { applyPassageTag, capturePassageSelection, setPassageTagBridge, type PassageSelection } from '../utils/activeBlockNoteEditor';
import { editorSchema } from './editorSchema';
import { PASSAGE_TAGS, type PassageTag } from './passageTags';
import { passageTagKeys } from './passageTagModel';

type Editor = BlockNoteEditor<typeof editorSchema.blockSchema, typeof editorSchema.inlineContentSchema, typeof editorSchema.styleSchema>;

function markedText(value: unknown): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(walk); return; }
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    if (typeof record.text === 'string' && record.text.length > 0 && record.styles && typeof record.styles === 'object') {
      const id = (record.styles as Record<string, unknown>).followUp;
      if (typeof id === 'string') found.set(id, (found.get(id) ?? '') + record.text);
    }
    Object.entries(record).forEach(([key, child]) => { if (key !== 'styles') walk(child); });
  };
  walk(value);
  return found;
}

function TagToolbar(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const selectionRef = useRef<PassageSelection | null>(null);
  return <FormattingToolbar>
    {getFormattingToolbarItems()}
    <span className="note-passage-menu">
      <button type="button" className="note-passage-menu__trigger" aria-expanded={open}
        onMouseDown={event => { event.preventDefault(); selectionRef.current = capturePassageSelection(); }}
        onClick={() => { selectionRef.current = capturePassageSelection() ?? selectionRef.current; setOpen(value => !value); }}>Tag</button>
      {open && <span className="note-passage-menu__list" role="menu" aria-label="Tag selected passage"
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}>
        {(Object.keys(PASSAGE_TAGS) as PassageTag[]).map(kind => <button key={kind} type="button" role="menuitem"
          className="note-passage-menu__item" onMouseDown={event => { event.preventDefault(); }}
          onClick={() => {
            const selection = selectionRef.current;
            if (!selection) { setError('Select text in the note first.'); return; }
            void applyPassageTag(kind, selection).then(() => { setOpen(false); setError(''); })
              .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : 'Could not tag the passage.'); });
          }}><span aria-hidden="true">{PASSAGE_TAGS[kind].icon}</span>{PASSAGE_TAGS[kind].label}</button>)}
        {error && <span className="note-passage-menu__error" role="alert">{error}</span>}
      </span>}
    </span>
  </FormattingToolbar>;
}

export function PassageTagManager({ editor, noteId, save, onError, githubPublished }: {
  editor: Editor;
  noteId: string;
  save: () => Promise<boolean>;
  onError: (message: string) => void;
  githubPublished: boolean;
}): React.ReactElement {
  const qc = useQueryClient();
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [reconcileTick, setReconcileTick] = useState(0);
  const processing = useRef(new Set<string>());
  const alive = useRef(true);
  const followups = useQuery({
    queryKey: ['passage-followups', noteId],
    queryFn: async () => requireApiData(await api.getPassageFollowups(noteId)),
    retry: false,
  });
  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['passage-followups', noteId] });
    void qc.invalidateQueries({ queryKey: ['tasks'] });
    void qc.invalidateQueries({ queryKey: ['passage-search'] });
  }, [noteId, qc]);

  const createTask = useCallback(async (tagId: string): Promise<void> => {
    if (processing.current.has(tagId)) return;
    processing.current.add(tagId);
    setBusy(current => new Set(current).add(tagId));
    setError(null);
    try {
      if (!await save()) throw new Error('Save the note before creating the Follow-up task.');
      const registration = requireApiData(await api.savePassageFollowup(noteId, tagId));
      if (registration.state === 'created') { await refresh(); return; }
      const draft = requireApiData(await api.draftPassageFollowup(noteId, tagId));
      if (!await save()) throw new Error('The updated note could not be saved.');
      if (markedText(editor.document).get(tagId)?.trim() !== draft.passageText) {
        throw new Error('The passage changed while Athena was working. Retry with the updated text.');
      }
      requireApiData(await api.savePassageFollowup(noteId, tagId, draft));
      await refresh();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not create the Follow-up task.';
      if (alive.current) setError(`${message} The tag is retained; retry below.`);
      await refresh();
    } finally {
      processing.current.delete(tagId);
      if (alive.current) setBusy(current => {
        const next = new Set(current);
        next.delete(tagId);
        return next;
      });
    }
  }, [editor, noteId, refresh, save]);

  const apply = useCallback(async (kind: PassageTag, selection: PassageSelection): Promise<void> => {
    if (!editor.isEditable || selection.noteId !== noteId || editor._tiptapEditor.state.doc !== selection.doc) {
      throw new Error('The note changed. Select the passage again.');
    }
    const state = editor._tiptapEditor.state;
    const selectedIds = new Set<string>();
    let partial = false;
    state.doc.nodesBetween(selection.from, selection.to, node => {
      if (!node.isText) return;
      const mark = node.marks.find(item => item.type.name === kind);
      if (typeof mark?.attrs['stringValue'] === 'string') selectedIds.add(mark.attrs['stringValue']);
    });
    if (selectedIds.size > 1) throw new Error('Select one tagged passage at a time.');
    const existing = [...selectedIds][0];
    let linkedTaskId: string | null = null;
    if (existing) {
      state.doc.descendants((node, pos) => {
        if (node.isText && node.marks.some(mark => mark.type.name === kind && mark.attrs['stringValue'] === existing)
          && (pos < selection.from || pos + node.nodeSize > selection.to)) partial = true;
      });
      if (partial) throw new Error('Select the entire tagged passage to remove its tag.');
      if (kind === 'followUp') {
        const rows = await qc.fetchQuery({
          queryKey: ['passage-followups', noteId],
          queryFn: async () => requireApiData(await api.getPassageFollowups(noteId)),
          staleTime: 0,
        });
        const row = rows.find(item => item.tagId === existing);
        linkedTaskId = row?.taskId ?? null;
        if (row?.taskId && !await confirmDialog(`Remove this Follow-up tag and delete its linked task “${row.taskTitle ?? 'Follow-up'}”?`, {
          title: 'Remove Follow-up', confirmLabel: 'Remove and delete task', tone: 'danger',
        })) return;
        if (editor._tiptapEditor.state.doc !== selection.doc) throw new Error('The note changed. Select the passage again.');
        processing.current.add(existing);
      }
    }
    editor._tiptapEditor.view.dispatch(editor._tiptapEditor.state.tr.setSelection(TextSelection.create(state.doc, selection.from, selection.to)));
    const added = existing ? null : crypto.randomUUID();
    if (existing) editor.removeStyles({ [kind]: existing });
    else editor.addStyles({ [kind]: added! });
    if (kind === 'followUp' && existing) {
      try {
        if (!await save()) throw new Error('The tag removal could not be saved; the task was not deleted.');
        requireApiData(await api.removePassageFollowup(noteId, existing, true, linkedTaskId));
        await refresh();
      } finally { processing.current.delete(existing); }
    } else if (kind === 'followUp' && added) {
      void createTask(added);
    }
  }, [createTask, editor, noteId, qc, refresh, save]);

  const pasted = useCallback((ids: string[]) => {
    ids.forEach(id => { void createTask(id); });
  }, [createTask]);
  useEffect(() => setPassageTagBridge(noteId, apply, pasted), [noteId, apply, pasted]);
  useEffect(() => {
    alive.current = true;
    const unsubscribe = editor.onChange(() => { setVersion(value => value + 1); });
    return () => { alive.current = false; unsubscribe(); };
  }, [editor]);

  useEffect(() => {
    if (!followups.data || reconcileError) return;
    const timer = window.setTimeout(() => {
      const present = markedText(editor.document);
      const missing = followups.data?.find(row => !present.has(row.tagId) && !processing.current.has(row.tagId));
      if (!missing) return;
      processing.current.add(missing.tagId);
      void (async () => {
        try {
          const deleteTask = missing.taskId !== null && await confirmDialog(
            `The tagged text was deleted. Delete its linked task “${missing.taskTitle ?? 'Follow-up'}” too?`,
            { title: 'Follow-up text deleted', confirmLabel: 'Delete task', tone: 'danger' });
          if (!alive.current || markedText(editor.document).has(missing.tagId)) return;
          if (!await save()) throw new Error('The note could not be saved; its linked task was not changed.');
          if (!alive.current || markedText(editor.document).has(missing.tagId)) return;
          requireApiData(await api.removePassageFollowup(noteId, missing.tagId, deleteTask, missing.taskId));
          await refresh();
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : 'Could not update the Follow-up task.';
          if (alive.current) { setReconcileError(message); onError(message); }
          await refresh();
        } finally { processing.current.delete(missing.tagId); }
      })();
    }, 800);
    return () => { window.clearTimeout(timer); };
  }, [editor, followups.data, noteId, onError, reconcileError, reconcileTick, refresh, save, version]);

  const present = markedText(editor.document);
  const publishedWarning = githubPublished && passageTagKeys(editor.document).size > 0;
  const pending = followups.isSuccess
    ? [...present.entries()].filter(([id]) => !followups.data.some(row => row.tagId === id && row.state === 'created'))
    : [];
  return <>
    <FormattingToolbarController formattingToolbar={TagToolbar} />
    {(pending.length > 0 || error || followups.isError || reconcileError || publishedWarning) && <div className="note-passage-status" role="status">
      {publishedWarning && <p>GitHub Markdown omits passage tags; tags remain in this Think note.</p>}
      {followups.isError && <p role="alert">Could not load Follow-up tasks. <button type="button" onClick={() => { void followups.refetch(); }}>Retry</button></p>}
      {error && <p role="alert">{error}</p>}
      {reconcileError && <p role="alert">{reconcileError}{' '}
        <button type="button" onClick={() => { setReconcileError(null); setReconcileTick(value => value + 1); }}>Retry</button></p>}
      {pending.map(([id, text]) => <div key={id} className="note-passage-status__row">
        <span>Follow-up: {text}</span>
        <button type="button" disabled={busy.has(id) || followups.isError} onClick={() => { void createTask(id); }}>
          {busy.has(id) ? 'Creating task…' : 'Retry task'}
        </button>
      </div>)}
    </div>}
  </>;
}
