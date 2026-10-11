import React, { useMemo } from 'react';
import type { DiagramDocument } from './diagramTypes';
import { elementInfo, footnotesOf, textIssues, type TextIssue } from './diagramAnnotations';

const FIELD: Record<TextIssue['field'], string> = { label: 'title', description: 'description', footnote: 'footnote' };

/** Likely misspellings, repeated words and stray spaces across titles, descriptions and footnotes. */
export function DiagramTextCheck({ doc, onFix, onSelect }: {
  doc: DiagramDocument;
  onFix: (issues: TextIssue[]) => void;
  onSelect: (targetId: string) => void;
}): React.ReactElement {
  const issues = useMemo(() => textIssues(doc), [doc]);
  const owner = (issue: TextIssue): string => {
    const id = issue.field === 'footnote' ? footnotesOf(doc).find((f) => f.id === issue.targetId)?.targetId ?? issue.targetId : issue.targetId;
    return elementInfo(doc, id)?.label ?? '';
  };
  const target = (issue: TextIssue): string => issue.field === 'footnote' ? footnotesOf(doc).find((f) => f.id === issue.targetId)?.targetId ?? issue.targetId : issue.targetId;
  return <div className="dg-textcheck">
    {issues.length === 0
      ? <p className="dg-popover__hint">No likely typos or stray spaces found. Browser spell-check also underlines words while you type.</p>
      : <>
          <div className="dg-textcheck__head">
            <span>{issues.length} thing{issues.length === 1 ? '' : 's'} to tidy</span>
            <button type="button" className="dg-text-btn" onClick={() => { onFix(issues); }}>Fix all</button>
          </div>
          <ul className="dg-textcheck__list">
            {issues.map((issue) => <li key={issue.key} className="dg-textcheck__row">
              <button type="button" className="dg-textcheck__where" onClick={() => { onSelect(target(issue)); }}>
                <strong>{issue.message}</strong>
                <small>in the {FIELD[issue.field]} of “{owner(issue).slice(0, 60)}”</small>
              </button>
              <button type="button" className="dg-text-btn" onClick={() => { onFix([issue]); }}>{issue.kind === 'spacing' ? 'Trim' : 'Fix'}</button>
            </li>)}
          </ul>
        </>}
  </div>;
}
