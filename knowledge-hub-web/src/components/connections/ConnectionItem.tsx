/**
 * components/connections/ConnectionItem.tsx
 * A single connection row: title, type pill, optional reason + confidence dots.
 */
import React from 'react';
import type { ConnectionEdge } from '../../services/api';

interface ConnectionItemProps {
  edge: ConnectionEdge;
  onClick: () => void;
}

/** Maps confidence [0,1] to 1–3 filled dots. */
function confidenceDots(confidence: number): [boolean, boolean, boolean] {
  if (confidence >= 0.8) return [true, true, true];
  if (confidence >= 0.5) return [true, true, false];
  return [true, false, false];
}

const TYPE_LABELS: Record<string, string> = {
  discover_item: 'Article',
  note: 'Note',
  task: 'Task',
  document: 'Doc',
  spark: 'Spark',
  commit: 'Commit',
  pull_request: 'PR',
  blog_post: 'Blog',
  podcast_episode: 'Pod',
  cfp_item: 'CFP',
};

export const ConnectionItem: React.FC<ConnectionItemProps> = ({ edge, onClick }) => {
  const label = TYPE_LABELS[edge.connectedNode.refType] ?? edge.connectedNode.refType;
  const isInferred = edge.edgeType === 'thematically_related';
  const dots = isInferred ? confidenceDots(edge.confidence) : null;
  const reason = isInferred ? (edge.metadata?.['reason'] as string | undefined) : undefined;
  const title = edge.connectedNode.title.length > 60
    ? edge.connectedNode.title.slice(0, 60) + '…'
    : edge.connectedNode.title;

  return (
    <button className="conn-item" onClick={onClick}>
      <div className="conn-item__row">
        <span className="conn-item__title">{title}</span>
        <span className={`conn-item__type conn-item__type--${edge.connectedNode.refType}`}>{label}</span>
      </div>
      {reason !== undefined && (
        <p className="conn-item__reason">{reason}</p>
      )}
      {dots !== null && (
        <div className="conn-item__dots" aria-label={`Confidence: ${Math.round(edge.confidence * 100)}%`}>
          {dots.map((filled, i) => (
            <span key={i} className={`conn-item__dot${filled ? ' conn-item__dot--filled' : ''}`} />
          ))}
        </div>
      )}
    </button>
  );
};
