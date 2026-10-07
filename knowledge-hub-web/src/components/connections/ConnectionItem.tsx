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
  issue: 'Issue',
  github_item: 'GitHub',
  canvas: 'Canvas',
  blog_post: 'Blog',
  podcast_episode: 'Pod',
  cfp_item: 'CFP',
};

export const ConnectionItem: React.FC<ConnectionItemProps> = ({ edge, onClick }) => {
  const label = TYPE_LABELS[edge.connectedNode.refType] ?? edge.connectedNode.refType;
  const isInferred = edge.edgeType === 'thematically_related';
  const dots = isInferred ? confidenceDots(edge.confidence) : null;
  const storedReason = edge.metadata?.['reason'];
  const sharedTags = edge.metadata?.['shared_tags'];
  const reason = typeof storedReason === 'string' && storedReason.trim()
    ? storedReason
    : edge.edgeType === 'tag_overlap' && Array.isArray(sharedTags)
      ? `Shared topics: ${sharedTags.filter((tag): tag is string => typeof tag === 'string').join(', ')}`
      : edge.edgeType === 'has_spark' ? 'This Spark was attached to this item.'
        : edge.edgeType === 'references' ? 'Explicitly linked to this item.'
          : edge.edgeType === 'on_map' ? 'Included on this canvas.'
            : undefined;
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
            <p className="conn-item__reason" title={reason}>{reason}</p>
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
