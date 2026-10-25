import React, { useMemo } from 'react';
import { renderMarkdown } from '../utils/markdown';
import { sanitizeHtml } from '../utils/sanitizeHtml';
import { handleCodeCopyClick } from './athena/renderReply';
import { confirmDialog } from '../services/appDialogs';

export type DocumentViewMode = 'md' | 'html';

export const DocumentViewToggle: React.FC<{
  value: DocumentViewMode;
  onChange: (value: DocumentViewMode) => void;
  pendingReview?: boolean;
  artifact?: boolean;
}> = ({ value, onChange, pendingReview = false, artifact = false }) => (
  <div className="kh-document-view" role="group" aria-label="Document view">
    {(['md', 'html'] as const).map(mode => (
      <button key={mode} type="button" className="kh-document-view__button"
        aria-pressed={value === mode} onClick={() => {
          if (mode === value) return;
          if (!pendingReview) { onChange(mode); return; }
          void confirmDialog('This view contains unaccepted review feedback. Switching views discards it without changing the source.',
            { title: 'Discard review feedback?', confirmLabel: 'Discard and switch' }).then(ok => { if (ok) onChange(mode); });
        }}
        title={mode === 'md' ? 'Markdown document' : artifact ? 'Athena Blueprint: a sectioned visual of the whole spec' : 'Formatted HTML review view'}>
        {mode === 'html' && artifact ? 'Blueprint' : mode.toUpperCase()}
      </button>
    ))}
  </div>
);

type DocumentSource = { markdown: string; html?: never } | { html: string; markdown?: never };

export const DocumentHtmlView: React.FC<DocumentSource & { label?: string }> = ({ markdown, html: sourceHtml, label = 'Document HTML view' }) => {
  const html = useMemo(() => sourceHtml !== undefined ? sanitizeHtml(sourceHtml, { documentContent: true }) : renderMarkdown(markdown ?? ''), [markdown, sourceHtml]);
  if (html.trim() === '') return <p className="kh-document-view__hint">No content yet. Switch to MD to write the document.</p>;
  return <article className="kh-document-html" aria-label={label} onClick={handleCodeCopyClick}
    dangerouslySetInnerHTML={{ __html: html }} />;
};
