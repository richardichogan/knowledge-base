import React, { useId, useRef } from 'react';
import { descriptionRuns, formatDescription } from './diagramDescription';

const LIMIT = 10000;

export function DiagramDescriptionEditor({ value, onChange, onFocus }: {
  value: string;
  onChange: (value: string, first: boolean) => void;
  onFocus: () => void;
}): React.ReactElement {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  function format(style: 'bold' | 'italic'): void {
    const field = input.current;
    if (field === null) return;
    const result = formatDescription(value, field.selectionStart, field.selectionEnd, style);
    if (result.text.length > LIMIT) return;
    onChange(result.text, true);
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(result.start, result.end);
    });
  }
  return <div className="dg-description">
    <label htmlFor={id}>Description</label>
    <div className="dg-description__toolbar" role="group" aria-label="Description formatting">
      <button type="button" title="Bold (Ctrl+B)" aria-label="Bold description"
        disabled={value.length > LIMIT - 4}
        onMouseDown={event => { event.preventDefault(); }} onClick={() => { format('bold'); }}><strong>B</strong></button>
      <button type="button" title="Italic (Ctrl+I)" aria-label="Italic description"
        disabled={value.length > LIMIT - 2}
        onMouseDown={event => { event.preventDefault(); }} onClick={() => { format('italic'); }}><em>I</em></button>
      <span id={`${id}-hint`}>Select text to format. Ctrl+B / Ctrl+I.</span>
    </div>
    <textarea id={id} ref={input} aria-label="Shape or connector description" aria-describedby={`${id}-hint`}
      rows={6} maxLength={LIMIT} value={value} spellCheck onFocus={onFocus}
      onChange={event => { onChange(event.target.value, false); }}
      onKeyDown={event => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || !['b', 'i'].includes(event.key.toLowerCase())) return;
        event.preventDefault();
        event.stopPropagation();
        format(event.key.toLowerCase() === 'b' ? 'bold' : 'italic');
      }} />
    {value !== '' && <div className="dg-description__preview" aria-label="Formatted description preview">
      {descriptionRuns(value).map((run, index) => <span key={index} className={`${run.bold ? 'dg-description-run--bold' : ''}${run.italic ? ' dg-description-run--italic' : ''}`}>{run.text}</span>)}
    </div>}
    <p className="dg-properties__hint">Formatting is saved as Markdown: **bold** and *italic*. Preview shown above.</p>
  </div>;
}
