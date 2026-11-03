import React, { useMemo } from 'react';
import { renderMarkdownPreview } from '../utils/markdown';

export function TaskDescription({ text, className }: { text: string; className: string }): React.ReactElement {
  const html = useMemo(() => renderMarkdownPreview(text), [text]);
  return <div className={`${className} kh-task-prose`}
    onClick={event => { if (event.target instanceof Element && event.target.closest('a')) event.stopPropagation(); }}
    dangerouslySetInnerHTML={{ __html: html }} />;
}
