/**
 * components/athena/UsedLine.tsx — "Used: …" under a reply: what Athena drew
 * on (project, standing instructions, the document in view, what her
 * searches found, background items, the chat's panels). Expand to see each
 * item, open it, or say "Don't use this" for the rest of the chat.
 */
import React, { useId, useState } from 'react';
import { ChevronDown, ChevronUp } from '@carbon/icons-react';
import type { ContextUsedApi, SourceLifecycle, UsedSourceApi } from '../../types';
import { groupSources, LIFECYCLE_LABEL, scopeWarnings, sourceTarget } from './usedSources';

interface UsedLineProps {
  used: ContextUsedApi;
  /** Ids excluded in this chat ("Don't use this"). */
  excluded: Set<string>;
  onExclude: (source: UsedSourceApi) => void;
  onInclude: (sourceId: string) => void;
}

const KIND_LABEL: Record<string, string> = { note: 'Think note', document: 'Library', item: 'Synced', node: 'Graph', chat: 'Chat' };

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toString()} ${n === 1 ? one : many}`;
}

export const UsedLine: React.FC<UsedLineProps> = ({ used, excluded, onExclude, onInclude }) => {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const groups = groupSources(used);
  const sourceCount = groups.reduce((total, group) => total + group.sources.length, 0);
  const { reply: replyWarnings, bySource: sourceWarnings } = scopeWarnings(used.warnings);
  const warningCount = (used.warnings ?? []).length;
  const summary = [
    used.project,
    used.instructions > 0 ? plural(used.instructions, 'instruction') : null,
    used.inView,
    sourceCount > 0 ? plural(sourceCount, 'source') : null,
    used.decisions > 0 ? 'Decisions' : null,
    used.outputs > 0 ? 'Outputs' : null,
    used.screens > 0 ? 'Screens' : null,
    warningCount > 0 ? plural(warningCount, 'notice') : null,
  ].filter((x): x is string => x !== null && x !== '');
  if (summary.length === 0) return null;
  const counts = [
    sourceCount > 0 ? plural(sourceCount, 'source') : null,
    used.instructions > 0 ? plural(used.instructions, 'instruction') : null,
  ].filter(Boolean).join(' · ');

  const row = (s: UsedSourceApi, lifecycle: SourceLifecycle): React.ReactNode => {
    const isOut = excluded.has(s.id);
    const target = sourceTarget(s);
    const warnings = sourceWarnings.get(s.id) ?? [];
    return (
      <li key={s.id} className={`ai-used__item${isOut ? ' ai-used__item--out' : ''}${target.kind === 'unavailable' ? ' ai-used__item--unavailable' : ''}`}>
        <div className="ai-used__source">
          {target.kind === 'internal' || target.kind === 'external'
            ? <a href={target.href} target={target.kind === 'external' ? '_blank' : undefined} rel="noreferrer" className="ai-used__title">{s.title}</a>
            : <span className="ai-used__title">{s.title}</span>}
          <div className="ai-used__source-meta">
            <span className={`ai-used__state ai-used__state--${lifecycle}`}>{LIFECYCLE_LABEL[lifecycle]}</span>
            <span className="ai-used__kind">{KIND_LABEL[s.kind] ?? s.kind}</span>
            {target.kind === 'unavailable' && <span className="ai-used__unavailable">No longer available</span>}
          </div>
        </div>
        <button
          type="button"
          className="ai-used__toggle"
          onClick={() => { if (isOut) onInclude(s.id); else onExclude(s); }}
          title={isOut ? 'Use it again in this chat' : 'Leave this out of searches for the rest of this chat'}
        >
          {isOut ? 'Use again' : 'Don’t use this'}
        </button>
        {warnings.map((w) => <span key={w.message} className="ai-used__item-warning" role="note">{w.message}</span>)}
      </li>
    );
  };

  return (
    <div className="ai-used">
      <button type="button" className="ai-used__line" aria-expanded={open} aria-controls={detailId} onClick={() => { setOpen((o) => !o); }}>
        <span className="ai-used__summary">
          <span className="ai-used__label">Context &amp; references</span>
          {counts !== '' && <span className="ai-used__counts">{counts}</span>}
          {warningCount > 0 && <span className="ai-used__notices">{plural(warningCount, 'notice')}</span>}
        </span>
        {open ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button>
      {open && (
        <div id={detailId} className="ai-used__detail">
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
          {replyWarnings.map((w) => <p key={w.message} className="ai-used__warning" role="note">{w.message}</p>)}
          {groups.map((group) => (
            <React.Fragment key={group.lifecycle}>
              <div className="ai-used__group"><span>{group.label}</span><span className="ai-used__hint">{group.hint}</span></div>
              <ul className="ai-used__list">{group.sources.map((s) => row(s, group.lifecycle))}</ul>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};
