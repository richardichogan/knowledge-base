/**
 * components/athena/UsedLine.tsx — "Used: …" under a reply: what Athena drew
 * on (project, standing instructions, the document in view, what her
 * searches found, background items, the chat's panels). Expand to see each
 * item, open it, or say "Don't use this" for the rest of the chat.
 */
import React, { useState } from 'react';
import { ChevronDown, ChevronUp } from '@carbon/icons-react';
import type { ContextUsedApi, UsedSourceApi } from '../../types';

interface UsedLineProps {
  used: ContextUsedApi;
  /** Ids excluded in this chat ("Don't use this"). */
  excluded: Set<string>;
  onExclude: (source: UsedSourceApi) => void;
  onInclude: (sourceId: string) => void;
}

const KIND_LABEL: Record<string, string> = { note: 'Think note', document: 'Library', item: 'Synced', node: 'Graph' };

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toString()} ${n === 1 ? one : many}`;
}

export const UsedLine: React.FC<UsedLineProps> = ({ used, excluded, onExclude, onInclude }) => {
  const [open, setOpen] = useState(false);
  const background = used.auto.filter((a) => !used.found.some((f) => f.id === a.id));
  const sources = [...used.found, ...background];
  const summary = [
    used.project,
    used.instructions > 0 ? plural(used.instructions, 'instruction') : null,
    used.inView,
    sources.length > 0 ? plural(sources.length, 'source') : null,
    used.decisions > 0 ? 'Decisions' : null,
    used.outputs > 0 ? 'Outputs' : null,
    used.screens > 0 ? 'Screens' : null,
  ].filter((x): x is string => x !== null && x !== '');
  if (summary.length === 0) return null;

  const row = (s: UsedSourceApi): React.ReactNode => {
    const isOut = excluded.has(s.id);
    return (
      <li key={s.id} className={`ai-used__item${isOut ? ' ai-used__item--out' : ''}`}>
        <span className="ai-used__kind">{KIND_LABEL[s.kind] ?? s.kind}</span>
        {s.url !== undefined && s.url !== null && s.url !== ''
          ? <a href={s.url} target={/^https?:\/\/[^/]*athena/i.test(s.url) ? undefined : '_blank'} rel="noreferrer" className="ai-used__title">{s.title}</a>
          : <span className="ai-used__title">{s.title}</span>}
        <button
          type="button"
          className="ai-used__toggle"
          onClick={() => { if (isOut) onInclude(s.id); else onExclude(s); }}
          title={isOut ? 'Use it again in this chat' : 'Leave this out of searches for the rest of this chat'}
        >
          {isOut ? 'Use again' : 'Don’t use this'}
        </button>
      </li>
    );
  };

  return (
    <div className="ai-used">
      <button type="button" className="ai-used__line" aria-expanded={open} onClick={() => { setOpen((o) => !o); }}>
        Used: {summary.join(' · ')}
        {open ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button>
      {open && (
        <div className="ai-used__detail">
          <ul className="ai-used__facts">
            {used.project !== null && <li>Project: <strong>{used.project}</strong></li>}
            {used.instructions > 0 && <li>{plural(used.instructions, 'standing instruction')} and liked examples (see Memory)</li>}
            {used.inView !== null && <li>In view: <strong>{used.inView}</strong></li>}
            {(used.decisions > 0 || used.outputs > 0 || used.screens > 0) && (
              <li>
                This chat’s panels: {[
                  used.decisions > 0 ? plural(used.decisions, 'decision') : null,
                  used.outputs > 0 ? plural(used.outputs, 'output') : null,
                  used.screens > 0 ? plural(used.screens, 'screen') : null,
                ].filter(Boolean).join(', ')}
              </li>
            )}
          </ul>
          {used.found.length > 0 && (
            <>
              <div className="ai-used__group">Found by searching</div>
              <ul className="ai-used__list">{used.found.map(row)}</ul>
            </>
          )}
          {background.length > 0 && (
            <>
              <div className="ai-used__group">Background (retrieved automatically)</div>
              <ul className="ai-used__list">{background.map(row)}</ul>
            </>
          )}
        </div>
      )}
    </div>
  );
};
