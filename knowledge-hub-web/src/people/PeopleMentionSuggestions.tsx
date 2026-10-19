import React, { useEffect, useId, useState, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { requireApiData } from '../services/apiError';
import { insertPersonMention, peopleQuery } from './chatMentions';
import type { Person } from '../types/people';

export function PeopleMentionSuggestions({ input, textarea, onChange }: {
  input: string; textarea: RefObject<HTMLTextAreaElement>; onChange: (value: string) => void;
}): React.ReactElement | null {
  const id = useId();
  const [cursor, setCursor] = useState(input.length);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const query = peopleQuery(input, cursor);
  const key = query ? `${query.start}:${query.query}` : '';
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const timer = setTimeout(() => { setDebounced(query?.query ?? ''); }, 120); return () => { clearTimeout(timer); }; }, [query?.query]);
  const results = useQuery({
    queryKey: ['people', debounced],
    enabled: focused && query !== null && dismissed !== key,
    queryFn: async () => requireApiData(await api.getPeople(debounced)),
    staleTime: 15_000,
  });
  const items = results.data?.slice(0, 8) ?? [];
  const open = focused && query !== null && dismissed !== key;
  const choose = (person: Person): void => {
    if (!query) return;
    const result = insertPersonMention(input, query, person);
    onChange(result.input); setDismissed(key);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(result.cursor, result.cursor); setCursor(result.cursor); });
  };
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
    if (items[selected]) el.setAttribute('aria-activedescendant', `${id}-${selected}`);
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(key); }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) {
        event.preventDefault(); event.stopPropagation();
        setSelected(value => (value + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      }
      if ((event.key === 'Enter' && !event.shiftKey || event.key === 'Tab') && items[selected] && debounced === query?.query) {
        event.preventDefault(); event.stopPropagation(); choose(items[selected]);
      }
    };
    el.addEventListener('keydown', onKey, true);
    return () => {
      el.removeEventListener('keydown', onKey, true);
      for (const name of ['aria-controls', 'aria-expanded', 'aria-autocomplete', 'aria-activedescendant']) el.removeAttribute(name);
    };
  });
  if (!open) return null;
  return <div className="people-mentions" role="listbox" id={id} aria-label="Mention a person">
    <div className="people-mentions__heading">People</div>
    {results.isFetching || debounced !== query.query ? <p role="status">Finding people...</p>
      : results.error ? <p role="alert">People lookup failed. <button type="button" onMouseDown={event => { event.preventDefault(); }} onClick={() => { void results.refetch(); }}>Retry</button></p>
        : items.length ? items.map((person, index) => <button key={person.id} id={`${id}-${index}`} type="button" role="option"
          aria-selected={selected === index} className={`people-mentions__item${selected === index ? ' people-mentions__item--selected' : ''}`}
          onMouseDown={event => { event.preventDefault(); }} onClick={() => { choose(person); }}>
          <strong>{person.name}</strong><small>{[person.organisation, person.emails[0]].filter(Boolean).join(' / ')}</small>
        </button>) : <p>No matching people. Add contacts under Tools / People. Project @mentions still work.</p>}
  </div>;
}
