import React, { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { requireApiData } from '../services/apiError';
import { peopleQuery } from '../people/chatMentions';
import { CHAT_MENTION_LABELS, insertChatMention, type ChatMentionTarget } from './mentions';
import { EMPTY_PERSON } from '../types/people';

export function ChatMentionSuggestions({ input, textarea, onChange, onProject }: {
  input: string; textarea: RefObject<HTMLTextAreaElement>; onChange: (value: string) => void;
  onProject: (id: string) => void;
}): React.ReactElement | null {
  const id = useId();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [createError, setCreateError] = useState('');
  const liveInput = useRef(input);
  liveInput.current = input;
  const [cursor, setCursor] = useState(input.length);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const menu = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<{ left: number; top: number; width: number; maxHeight: number; above: boolean } | null>(null);
  const query = peopleQuery(input, cursor);
  const key = query ? `${query.start}:${query.query}` : '';
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const timer = setTimeout(() => { setDebounced(query?.query ?? ''); }, 120); return () => { clearTimeout(timer); }; }, [query?.query]);
  const results = useQuery({
    queryKey: ['chat-mention-targets', debounced],
    enabled: focused && query !== null && dismissed !== key,
    queryFn: async () => requireApiData(await api.getChatMentionTargets(debounced)),
    staleTime: 15_000,
  });
  const items = results.data ?? [];
  const creatable = query?.query && debounced === query.query && !results.error && !results.isFetching
    ? (['person', 'company'] as const).filter(type =>
      !items.some(item => item.type === type && item.title.toLocaleLowerCase() === query.query.toLocaleLowerCase()))
    : [];
  const choiceCount = items.length + creatable.length;
  const open = focused && query !== null && dismissed !== key;
  const positioned = geometry !== null;
  useLayoutEffect(() => {
    if (!open) return;
    const position = (): void => {
      const inputElement = textarea.current;
      if (!inputElement) return;
      const rect = (inputElement.closest('.ai-input-field') ?? inputElement).getBoundingClientRect();
      const width = Math.min(400, Math.max(240, rect.width), window.innerWidth - 24);
      const above = rect.top > 160;
      setGeometry({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: above ? rect.top - 8 : rect.bottom + 8,
        width, above,
        maxHeight: Math.min(320, Math.max(80, above ? rect.top - 20 : window.innerHeight - rect.bottom - 20)),
      });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open, textarea]);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!open || !element || !positioned || !element.showPopover) return;
    element.setAttribute('popover', 'manual');
    element.showPopover();
    return () => { if (element.matches(':popover-open')) element.hidePopover(); };
  }, [open, positioned]);
  const choose = (target: ChatMentionTarget): void => {
    if (!query) return;
    const result = insertChatMention(input, query, target);
    if (target.type === 'project') onProject(target.id);
    onChange(result.input); setDismissed(key);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(result.cursor, result.cursor); setCursor(result.cursor); });
  };
  async function create(type: 'person' | 'company'): Promise<void> {
    if (!query?.query || creatingRef.current) return;
    creatingRef.current = true; setCreating(true); setCreateError('');
    const original = input;
    try {
      const record = type === 'person'
        ? requireApiData(await api.savePerson({ ...EMPTY_PERSON, name: query.query }))
        : requireApiData(await api.saveCompany({ name: query.query, description: '', website: '', projectIds: [] }));
      await Promise.all(['chat-mention-targets', 'entity-link-search', 'people', 'companies'].map(key => qc.invalidateQueries({ queryKey: [key] })));
      if (liveInput.current === original) choose({ type, id: record.id, title: record.name,
        href: type === 'person' ? `/people?personId=${encodeURIComponent(record.id)}` : `/companies?companyId=${encodeURIComponent(record.id)}`, detail: '' });
    } catch (cause) { setCreateError(cause instanceof Error ? cause.message : 'Could not create the record. Your message is unchanged.'); }
    finally { creatingRef.current = false; setCreating(false); }
  }
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    const update = (): void => { setCursor(el.selectionStart); };
    const onFocus = (): void => { setFocused(true); update(); };
    const onBlur = (): void => { setFocused(false); };
    setFocused(document.activeElement === el);
    el.addEventListener('input', update); el.addEventListener('click', update); el.addEventListener('keyup', update);
    el.addEventListener('focus', onFocus); el.addEventListener('blur', onBlur);
    return () => {
      el.removeEventListener('input', update); el.removeEventListener('click', update); el.removeEventListener('keyup', update);
      el.removeEventListener('focus', onFocus); el.removeEventListener('blur', onBlur);
    };
  }, [textarea]);
  useEffect(() => { setSelected(0); setDismissed(null); }, [key]);
  useEffect(() => {
    const el = textarea.current;
    if (!el || !open) return;
    el.setAttribute('aria-controls', id); el.setAttribute('aria-expanded', 'true'); el.setAttribute('aria-autocomplete', 'list');
    if (selected < choiceCount) el.setAttribute('aria-activedescendant', `${id}-${selected}`);
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(key); }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && choiceCount) {
        event.preventDefault(); event.stopPropagation();
        setSelected(value => (value + (event.key === 'ArrowDown' ? 1 : choiceCount - 1)) % choiceCount);
      }
      const target = items[selected];
      const createType = creatable[selected - items.length];
      if ((event.key === 'Enter' && !event.shiftKey || event.key === 'Tab') && (target || createType) && debounced === query?.query) {
        event.preventDefault(); event.stopPropagation();
        if (target) choose(target);
        else if (createType) void create(createType);
      }
    };
    el.addEventListener('keydown', onKey, true);
    return () => {
      el.removeEventListener('keydown', onKey, true);
      for (const name of ['aria-controls', 'aria-expanded', 'aria-autocomplete', 'aria-activedescendant']) el.removeAttribute(name);
    };
  });
  if (!open || geometry === null) return null;
  const host = textarea.current?.closest('dialog, [data-carbon-theme], .cds--g100') ?? document.body;
  return createPortal(<div ref={menu} className={`people-mentions people-mentions--floating${geometry.above ? ' people-mentions--above' : ''}`}
    style={{ left: geometry.left, top: geometry.top, width: geometry.width, maxHeight: geometry.maxHeight }}
    role="listbox" id={id} aria-label="Mention a person, company, project, note or document">
    <div className="people-mentions__heading">People, companies, projects &amp; documents</div>
    {results.isFetching || debounced !== query.query ? <p role="status">Finding matches...</p>
      : results.error ? <p role="alert">Mention lookup failed. <button type="button" onMouseDown={event => { event.preventDefault(); }} onClick={() => { void results.refetch(); }}>Retry</button></p>
        : items.length ? items.map((target, index) => <button key={`${target.type}:${target.id}`} id={`${id}-${index}`} type="button" role="option"
          aria-selected={selected === index} className={`people-mentions__item${selected === index ? ' people-mentions__item--selected' : ''}`}
          onMouseDown={event => { event.preventDefault(); }} onClick={() => { choose(target); }}>
          <strong>{target.title}</strong><small>{CHAT_MENTION_LABELS[target.type]}{target.detail ? ` / ${target.detail}` : ''}</small>
        </button>) : <p>No matches. Try a saved note, document title, person or project name.</p>}
    {createError && <p role="alert">{createError}</p>}
    {creatable.map((type, index) =>
      <button key={`create-${type}`} id={`${id}-${items.length + index}`} type="button" role="option" aria-selected={selected === items.length + index}
        className={`people-mentions__item${selected === items.length + index ? ' people-mentions__item--selected' : ''}`}
        disabled={creating} onMouseDown={event => { event.preventDefault(); }} onClick={() => { void create(type); }}>
        <strong>{creating ? 'Creating...' : `Create ${type} "${query.query}"`}</strong><small>Create a linked {type} page</small>
      </button>)}
  </div>, host);
}
