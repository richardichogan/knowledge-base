import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SuggestionMenuController, type SuggestionMenuProps } from '@blocknote/react';
import type { BlockNoteEditor } from '@blocknote/core';
import { SuggestionMenu } from '@blocknote/core/extensions';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { requireApiData } from '../services/apiError';
import { useAthenaContext } from '../context/AthenaContext';
import { createNote } from './noteStorage';
import { ENTITY_LINK_LABELS, debouncedLinkSearch, wikiQuery, type EntityLinkTarget } from './entityLinks';
import { editorSchema } from './editorSchema';
import { EMPTY_PERSON } from '../types/people';

type Editor = BlockNoteEditor<typeof editorSchema.blockSchema, typeof editorSchema.inlineContentSchema, typeof editorSchema.styleSchema>;
type Item = { title: string; detail: string } & (
  { kind: 'existing'; target: EntityLinkTarget } | { kind: 'create'; text: string; entityType: 'note' | 'definition' | 'person' | 'company' } | { kind: 'athena' } | { kind: 'message' }
);

function LinkSuggestions({ items, selectedIndex, onItemClick, loadingState }: SuggestionMenuProps<Item>): React.ReactElement {
  return <div className="note-link-menu" id="bn-suggestion-menu" role="listbox" aria-label="Link to Athena content">
    {loadingState === 'loading-initial' && <div className="note-link-menu__status" role="status">Finding links...</div>}
    {items.map((item, index) => <button key={`${item.kind}:${item.title}:${index}`} type="button" role="option"
      id={`bn-suggestion-menu-item-${index}`} aria-selected={selectedIndex === index}
      className={`note-link-menu__item${selectedIndex === index ? ' note-link-menu__item--selected' : ''}`}
      disabled={item.kind === 'message'} onMouseDown={event => { event.preventDefault(); }}
      onClick={() => { onItemClick?.(item); }}>
      <span>{item.title}</span><small>{item.detail}</small>
    </button>)}
  </div>;
}

export function EntityLinkMenu({ editor, noteId, projectId, onError }: {
  editor: Editor; noteId: string; projectId: string; onError: (message: string) => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const { launchAthena } = useAthenaContext();
  const [creating, setCreating] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const search = useMemo(() => debouncedLinkSearch((query: string) => qc.fetchQuery({
    queryKey: ['entity-link-search', query, noteId],
    queryFn: async () => requireApiData(await api.getLinkTargets(query, undefined, undefined, noteId)),
    staleTime: 15_000,
  })), [qc, noteId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; search.dispose(); }; }, [search]);

  const insert = useCallback((target: EntityLinkTarget, wiki: boolean): void => {
    // The single-character controller starts on the second "["; remove the first too.
    if (wiki) {
      const from = editor._tiptapEditor.state.selection.from;
      if (from > 0 && editor._tiptapEditor.state.doc.textBetween(from - 1, from) === '[') {
        editor._tiptapEditor.commands.deleteRange({ from: from - 1, to: from });
      }
    }
    editor.insertInlineContent([
      target.type === 'note'
        ? { type: 'noteMention', props: { noteId: target.id } }
        : { type: 'entityMention', props: { entityType: target.type, entityId: target.id } },
      ' ',
    ]);
  }, [editor]);

  const choose = useCallback((item: Item, wiki: boolean): void => {
    if (item.kind === 'message' || busy.current) return;
    if (item.kind === 'existing') { insert(item.target, wiki); return; }
    if (item.kind === 'athena') { launchAthena(); return; }
    busy.current = true;
    setCreating(true);
    // Freeze the source editor until creation resolves so insertion cannot land in another block.
    const wasEditable = editor.isEditable;
    editor.isEditable = false;
    const create = async (): Promise<EntityLinkTarget> => {
      if (item.entityType === 'person') {
        const person = requireApiData(await api.savePerson({ ...EMPTY_PERSON, name: item.text }));
        return { type: 'person', id: person.id, title: person.name, href: `/people?personId=${encodeURIComponent(person.id)}` };
      }
      if (item.entityType === 'company') {
        const company = requireApiData(await api.saveCompany({ name: item.text, description: '', website: '', projectIds: [] }));
        return { type: 'company', id: company.id, title: company.name, href: `/companies?companyId=${encodeURIComponent(company.id)}` };
      }
      const note = await createNote({ title: item.text, contentType: item.entityType === 'definition' ? 'definition' : 'note',
        contentJson: JSON.stringify([{ type: 'heading', props: { level: 1 }, content: item.text }]) }, projectId || undefined);
      if (!note) throw new Error('The new note was not returned.');
      return { type: 'note', id: note.id, title: note.title, href: `/think?noteId=${encodeURIComponent(note.id)}` };
    };
    void create()
      .then(target => {
        for (const key of ['notes-list', 'people', 'companies']) void qc.invalidateQueries({ queryKey: [key] });
        void qc.invalidateQueries({ queryKey: ['entity-link-search'] });
        if (!mounted.current) return;
        editor.isEditable = wasEditable;
        insert(target, wiki);
      })
      .catch((error: unknown) => {
        console.error('[note links] Could not create linked record:', error);
        if (mounted.current) {
          editor.isEditable = wasEditable;
          editor.insertInlineContent([wiki ? `[${item.text}]]` : `@${item.text}`]);
          onError(error instanceof Error ? error.message : 'Could not create the linked record. Your text was retained.');
        }
      }).finally(() => {
        busy.current = false;
        if (mounted.current) { editor.isEditable = wasEditable; setCreating(false); }
      });
  }, [editor, insert, launchAthena, onError, projectId, qc]);

  const getItems = useCallback(async (raw: string, wiki: boolean): Promise<Item[]> => {
    const { text, closed } = wiki ? wikiQuery(raw) : { text: raw.trim(), closed: false };
    if (text.length > 200 || /[\r\n]/.test(text)) return [{ kind: 'message', title: 'Keep link titles under 200 characters', detail: 'Escape to continue writing' }];
    let targets: EntityLinkTarget[];
    try { targets = await search.run(text); } catch (error) {
      console.error('[note links] Search failed:', error);
      return [{ kind: 'message', title: 'Could not find links', detail: 'Your writing is safe. Escape, then type @ or [[ to retry.' }];
    }
    const exact = targets.filter(target => target.title.toLocaleLowerCase() === text.toLocaleLowerCase());
    if (wiki && closed && exact.length === 1) {
      const from = editor._tiptapEditor.state.selection.from;
      const typed = `[[${raw}`;
      // Check the live cursor after the asynchronous lookup; a paste never starts this controller.
      if (from >= typed.length && editor._tiptapEditor.state.doc.textBetween(from - typed.length, from) === typed) {
        const menu = editor.getExtension(SuggestionMenu);
        if (menu) {
          menu.closeMenu();
          menu.clearQuery();
          insert(exact[0]!, true);
          return [];
        }
      }
    }
    const items: Item[] = targets.map(target => ({ kind: 'existing', title: target.title, detail: ENTITY_LINK_LABELS[target.type], target }));
    if (text && !targets.some(target => target.type === 'note' && target.title.toLocaleLowerCase() === text.toLocaleLowerCase())) {
      items.push({ kind: 'create', entityType: 'note', title: `Create note "${text}"`, detail: 'Create and link; stay in this note', text });
      items.push({ kind: 'create', entityType: 'definition', title: `Create definition "${text}"`, detail: 'Create a definition and link; stay in this note', text });
    }
    if (text) for (const entityType of ['person', 'company'] as const) {
      if (!targets.some(target => target.type === entityType && target.title.toLocaleLowerCase() === text.toLocaleLowerCase())) {
        items.push({ kind: 'create', entityType, title: `Create ${entityType} "${text}"`, detail: `Create a dedicated ${entityType} page and insert its link`, text });
      }
    }
    if (!wiki && (!text || 'athena'.startsWith(text.toLowerCase()))) items.push({ kind: 'athena', title: 'Athena', detail: 'Ask about the current note in the side panel' });
    return items.length ? items : [{ kind: 'message', title: 'No matching links', detail: 'Keep typing a title to create a note' }];
  }, [editor, insert, search]);
  const atItems = useCallback((query: string) => getItems(query, false), [getItems]);
  const wikiItems = useCallback((query: string) => getItems(query, true), [getItems]);
  return <>
    {creating && <span className="note-link-menu__status" role="status">Creating linked record...</span>}
    <SuggestionMenuController triggerCharacter="@" getItems={atItems} suggestionMenuComponent={LinkSuggestions}
      shouldOpen={tr => !tr.selection.$from.parent.type.spec.code &&
        (tr.selection.$from.parentOffset === 0 || /[\s([{]/.test(tr.selection.$from.parent.textBetween(tr.selection.$from.parentOffset - 1, tr.selection.$from.parentOffset)))}
      onItemClick={item => { choose(item, false); }} />
    <SuggestionMenuController triggerCharacter="[" getItems={wikiItems} suggestionMenuComponent={LinkSuggestions}
      shouldOpen={tr => !tr.selection.$from.parent.type.spec.code && tr.selection.$from.parentOffset > 0 &&
        tr.selection.$from.parent.textBetween(tr.selection.$from.parentOffset - 1, tr.selection.$from.parentOffset) === '['}
      onItemClick={item => { choose(item, true); }} />
  </>;
}
