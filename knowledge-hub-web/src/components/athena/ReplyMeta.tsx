/**
 * components/athena/ReplyMeta.tsx — small line under an Athena reply showing
 * which persona answered and which of the user's data it drew on, so a
 * data-backed answer can be told apart from a general one.
 */
import React from 'react';
import type { AthenaPersona } from '../../types';
import { getPersona } from './personas';
import { sourceLabels } from './sources';

interface ReplyMetaProps {
  persona?: AthenaPersona | undefined;
  sources?: string[] | undefined;
}

export const ReplyMeta: React.FC<ReplyMetaProps> = ({ persona, sources }) => {
  const labels = sourceLabels(sources);
  // General is the default — only name the persona when it's a specialist,
  // so ordinary replies aren't all stamped "General".
  const p = persona !== undefined && persona !== 'general' ? getPersona(persona) : undefined;
  if (p === undefined && labels.length === 0) return null;
  return (
    <div className="ai-reply-meta">
      {p !== undefined && (
        <span className="ai-reply-meta__persona" title={p.description}>
          <p.Icon size={12} aria-hidden="true" />
          {p.label}
        </span>
      )}
      {labels.length > 0 && (
        <span className="ai-reply-meta__sources">From: {labels.join(' · ')}</span>
      )}
    </div>
  );
};
