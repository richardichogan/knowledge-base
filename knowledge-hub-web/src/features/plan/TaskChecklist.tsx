import React, { useState } from 'react';
import { Checkbox, TextInput } from '@carbon/react';
import { Add, Close } from '@carbon/icons-react';
import type { ChecklistItem } from '../../types/task';

interface Props {
  items: ChecklistItem[];
  onChange: (items: ChecklistItem[]) => void;
  /** When false, items can only be ticked and the section is hidden while empty. */
  editable?: boolean;
  disabled?: boolean;
  idPrefix: string;
}

const MAX_ITEMS = 50;

export const TaskChecklist: React.FC<Props> = ({ items, onChange, editable = false, disabled = false, idPrefix }) => {
  const [draft, setDraft] = useState('');
  const done = items.filter(item => item.done).length;
  const add = (): void => {
    const title = draft.trim();
    if (title === '' || items.length >= MAX_ITEMS) return;
    onChange([...items, { id: crypto.randomUUID(), title, done: false }]);
    setDraft('');
  };
  if (!editable && items.length === 0) return null;
  return (
    <section className="kh-task-checklist" aria-label="Checklist">
      <h3 className="kh-task-checklist__title">Checklist{items.length > 0 && <span> · {done} of {items.length} done</span>}</h3>
      <ul className="kh-task-checklist__list">
        {items.map(item => (
          <li key={item.id} className="kh-task-checklist__item">
            <Checkbox id={`${idPrefix}-${item.id}`} labelText={item.title} checked={item.done} disabled={disabled}
              onChange={(_, { checked }) => { onChange(items.map(i => i.id === item.id ? { ...i, done: checked } : i)); }} />
            {editable && (
              <button type="button" className="kh-task-checklist__remove" disabled={disabled}
                aria-label={`Remove ${item.title}`} onClick={() => { onChange(items.filter(i => i.id !== item.id)); }}>
                <Close size={16} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <div className="kh-task-checklist__add">
          <TextInput id={`${idPrefix}-new`} labelText="Add checklist item" hideLabel placeholder="Add an item and press Enter"
            value={draft} maxLength={300} disabled={disabled || items.length >= MAX_ITEMS}
            onChange={event => { setDraft(event.target.value); }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
          <button type="button" className="dc-explore__action" disabled={disabled || draft.trim() === ''} onClick={add}>
            <Add size={16} /> Add
          </button>
        </div>
      )}
    </section>
  );
};
