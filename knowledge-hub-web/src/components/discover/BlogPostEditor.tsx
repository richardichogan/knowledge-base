import React, { useEffect, useRef, useState } from 'react';
import { sanitizeHtml } from '../../utils/sanitizeHtml';

/** Both views edit the same HTML value; rendering never replaces unedited source. */
export function BlogPostEditor({ value, onChange, disabled = false }: {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
}): React.ReactElement {
  const [mode, setMode] = useState<'rich' | 'html'>('rich');
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  const lastValue = useRef<string | null>(null);

  useEffect(() => {
    if (editor.current && lastValue.current !== value) {
      editor.current.innerHTML = sanitizeHtml(value);
      lastValue.current = value;
    }
  }, [value, mode]);

  function changed(): void {
    if (!editor.current) return;
    const html = sanitizeHtml(editor.current.innerHTML);
    lastValue.current = html;
    onChange(html);
  }

  function command(name: string, argument?: string): void {
    if (disabled || !editor.current) return;
    editor.current.focus();
    // Native editing retains the browser's selection and undo history.
    if (!document.execCommand(name, false, argument)) {
      setError('This editing action is unavailable in this browser. Use the HTML view instead.');
      return;
    }
    setError(null);
    changed();
  }

  function paste(event: React.ClipboardEvent<HTMLDivElement>): void {
    event.preventDefault();
    const html = event.clipboardData.getData('text/html');
    if (html) command('insertHTML', sanitizeHtml(html));
    else {
      const text = document.createElement('div');
      text.textContent = event.clipboardData.getData('text/plain');
      command('insertHTML', text.innerHTML.replace(/\r\n?|\n/g, '<br>'));
    }
  }

  return <div className="dc-blog-editor">
    <span id="blog-content-label" className="dc-linkedin__label">Post</span>
    <div className="dc-linkedin__formats" role="group" aria-label="Post editor view">
      <button type="button" disabled={disabled} aria-pressed={mode === 'rich'}
        onClick={() => { lastValue.current = null; setMode('rich'); setError(null); }}>Rich text</button>
      <button type="button" disabled={disabled} aria-pressed={mode === 'html'}
        onClick={() => { setMode('html'); setError(null); }}>HTML</button>
    </div>
    {mode === 'rich' ? <>
      <div className="dc-blog-editor__toolbar" role="group" aria-label="Post formatting">
        {([
          ['Bold', 'bold', undefined], ['Italic', 'italic', undefined],
          ['Heading', 'formatBlock', 'h2'], ['Paragraph', 'formatBlock', 'p'],
          ['Bullet list', 'insertUnorderedList', undefined],
          ['Numbered list', 'insertOrderedList', undefined],
          ['Undo', 'undo', undefined], ['Redo', 'redo', undefined],
        ] as const).map(([label, name, argument]) => <button key={name + (argument ?? '')} type="button"
          disabled={disabled} onMouseDown={event => { event.preventDefault(); }}
          onClick={() => { command(name, argument); }}>{label}</button>)}
      </div>
      <div ref={editor} id="blog-content" className="dc-blog-editor__rich" role="textbox"
        aria-labelledby="blog-content-label" aria-describedby="blog-content-help"
        aria-multiline="true" aria-readonly={disabled} tabIndex={0}
        contentEditable={!disabled} suppressContentEditableWarning onInput={changed} onPaste={paste}
        onDrop={event => { event.preventDefault(); setError('Paste text into the post rather than dropping files or content.'); }}
        onClick={event => { if ((event.target as HTMLElement).closest('a')) event.preventDefault(); }} />
    </> : <textarea id="blog-content" className="dc-linkedin__copy dc-blog-editor__html" rows={14}
      aria-labelledby="blog-content-label" aria-describedby="blog-content-help"
      disabled={disabled} value={value} spellCheck={false} onChange={event => { onChange(event.target.value); }} />}
    <p id="blog-content-help" className="dc-blog-editor__help">
      Both views edit the same post. Drafts and published posts are always sent as HTML.
    </p>
    {error && <p className="dc-linkedin__error" role="alert">{error}</p>}
  </div>;
}
