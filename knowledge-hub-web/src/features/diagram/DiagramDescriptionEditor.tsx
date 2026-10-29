import React, { useId, useRef } from 'react';
import { ListBulleted } from '@carbon/icons-react';
import { continueDescriptionBullet, descriptionRuns, formatDescription, toggleDescriptionBullets } from './diagramDescription';

const LIMIT = 10000;

export function DiagramDescriptionEditor({ value, onChange, onFocus, label = 'Shape or connector description', disabled = false, rows = 6 }: {
  value: string;
  onChange: (value: string, first: boolean) => void;
  onFocus?: () => void;
  label?: string;
  disabled?: boolean;
  rows?: number;
}): React.ReactElement {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  function apply(result: { text: string; start: number; end: number }): void {
    const field = input.current;
    if (field === null || disabled || result.text.length > LIMIT) return;
    onChange(result.text, true);
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(result.start, result.end);
    });
  }
  function format(style: 'bold' | 'italic' | 'bullet'): void {
    const field = input.current;
    if (field === null) return;
    apply(style === 'bullet' ? toggleDescriptionBullets(value, field.selectionStart, field.selectionEnd)
      : formatDescription(value, field.selectionStart, field.selectionEnd, style));
  }
  const preview: React.ReactNode[] = [];
  const lines = value.split('\n');
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (/^\s*[-+*] /.test(line)) {
      const items: React.ReactNode[] = [];
      const key = index;
      while (index < lines.length && /^\s*[-+*] /.test(lines[index]!)) {
        items.push(<li key={index}>{descriptionRuns(lines[index]!.replace(/^\s*[-+*] /, '')).map((run, i) =>
          <span key={i} className={`${run.bold ? 'dg-description-run--bold' : ''}${run.italic ? ' dg-description-run--italic' : ''}`}>{run.text}</span>)}</li>);
        index++;
      }
      preview.push(<ul key={key}>{items}</ul>);
    } else {
      preview.push(<div key={index}>{line === '' ? <br /> : descriptionRuns(line).map((run, i) =>
        <span key={i} className={`${run.bold ? 'dg-description-run--bold' : ''}${run.italic ? ' dg-description-run--italic' : ''}`}>{run.text}</span>)}</div>);
      index++;
    }
  }
  return <div className="dg-description">
    <label htmlFor={id}>Description</label>
    <div className="dg-description__toolbar" role="group" aria-label="Description formatting">
      <button type="button" title="Bold (Ctrl+B)" aria-label="Bold description"
        disabled={disabled || value.length > LIMIT - 4}
        onMouseDown={event => { event.preventDefault(); }} onClick={() => { format('bold'); }}><strong>B</strong></button>
      <button type="button" title="Italic (Ctrl+I)" aria-label="Italic description"
        disabled={disabled || value.length > LIMIT - 2}
        onMouseDown={event => { event.preventDefault(); }} onClick={() => { format('italic'); }}><em>I</em></button>
      <button type="button" title="Bulleted list" aria-label="Bulleted description list" disabled={disabled}
        onMouseDown={event => { event.preventDefault(); }} onClick={() => { format('bullet'); }}><ListBulleted size={16} /></button>
      <span id={`${id}-hint`}>Select text to format. Enter continues a bullet; Enter on an empty bullet ends the list.</span>
    </div>
    <textarea id={id} ref={input} aria-label={label} aria-describedby={`${id}-hint`}
      rows={rows} disabled={disabled} maxLength={LIMIT} value={value} spellCheck onFocus={onFocus}
      onChange={event => { onChange(event.target.value, false); }}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing) {
          const result = continueDescriptionBullet(value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
          if (result) { event.preventDefault(); event.stopPropagation(); apply(result); }
          return;
        }
        if (!(event.ctrlKey || event.metaKey) || event.altKey || !['b', 'i'].includes(event.key.toLowerCase())) return;
        event.preventDefault();
        event.stopPropagation();
        format(event.key.toLowerCase() === 'b' ? 'bold' : 'italic');
      }} />
    {value !== '' && <div className="dg-description__preview" aria-label="Formatted description preview">
      {preview}
    </div>}
    <p className="dg-properties__hint">Formatting is saved as Markdown: **bold**, *italic* and - bullet lists. Preview shown above.</p>
  </div>;
}
