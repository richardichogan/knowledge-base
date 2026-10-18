import React, { useMemo, useState } from 'react';
import type { DocEntry, DocType } from '../../services/api';
import { DOCUMENT_BATCH_SIZE, documentListWindow, documentLocation } from './documentListModel';
import './document-list.scss';

const TYPE_LABEL: Record<DocType, string> = {
  'blog-draft': 'Blog draft', spec: 'Spec', newsletter: 'Newsletter', readme: 'README', doc: 'Doc',
};

interface DocumentListProps {
  matches: DocEntry[];
  selectedDoc: DocEntry | null;
  pending: boolean;
  failed: boolean;
  onSelect: (id: string) => void;
}

export function DocumentList({ matches, selectedDoc, pending, failed, onSelect }: DocumentListProps): React.ReactElement {
  const [limit, setLimit] = useState(DOCUMENT_BATCH_SIZE);
  const window = useMemo(() => documentListWindow(matches, limit, selectedDoc), [matches, limit, selectedDoc]);
  const groups = useMemo(() => {
    const result = new Map<string, DocEntry[]>();
    for (const doc of window.docs) {
      const group = result.get(doc.sourceLabel) ?? [];
      group.push(doc);
      result.set(doc.sourceLabel, group);
    }
    return [...result.entries()];
  }, [window.docs]);

  function row(doc: DocEntry): React.ReactElement {
    const location = documentLocation(doc);
    return (
      <button
        type="button"
        key={doc.id}
        className={`docs-list-item${selectedDoc?.id === doc.id ? ' docs-list-item--active' : ''}`}
        aria-current={selectedDoc?.id === doc.id ? 'true' : undefined}
        onClick={() => { onSelect(doc.id); }}
      >
        <span className="docs-list-item__top">
          <span className="docs-list-item__title">{doc.title}</span>
          <span className="docs-type-badge">{TYPE_LABEL[doc.type]}</span>
        </span>
        <span className="docs-list-item__location" title={location}>{location}</span>
        <span className="docs-list-item__meta">
          {doc.localPath !== undefined && <span className="docs-local-badge" title={doc.localPath}>Local</span>}
          <span className="docs-list-item__size">{doc.size < 1024 ? `${doc.size} B` : `${(doc.size / 1024).toFixed(1)} KB`}</span>
        </span>
      </button>
    );
  }

  return (
    <>
      <p className="docs-list-summary" role="status">
        Showing {window.displayedCount.toLocaleString()} of {matches.length.toLocaleString()} documents
        {window.selectedOutsideFilters && ' · selected document outside filters'}
      </p>
      <div className="docs-list" id="docs-results" aria-label="Documents">
        {window.pinnedDoc !== null && (
          <div className="docs-group docs-group--selected">
            <p className="docs-group__label">
              {window.selectedOutsideFilters ? 'Selected · outside filters' : 'Selected · beyond current batch'}
            </p>
            {row(window.pinnedDoc)}
          </div>
        )}
        {matches.length === 0 && !pending && !failed && (
          <p className="docs-empty">No documents found. Try another search or clear the filters.</p>
        )}
        {groups.map(([label, docs]) => (
          <div key={label} className="docs-group">
            <p className="docs-group__label">{label}</p>
            {docs.map(row)}
          </div>
        ))}
        {window.remainingCount > 0 && (
          <button
            type="button"
            className="docs-list-more"
            aria-controls="docs-results"
            onClick={() => { setLimit((current) => current + DOCUMENT_BATCH_SIZE); }}
          >
            Show more documents ({window.remainingCount.toLocaleString()} remaining)
          </button>
        )}
      </div>
    </>
  );
}
