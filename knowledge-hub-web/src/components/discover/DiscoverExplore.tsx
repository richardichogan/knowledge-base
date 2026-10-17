/**
 * Explore panel for a Discover item: understand it, connect it to your work,
 * then create from it. Production actions live here rather than on the card.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Close, Launch, Link, Checkmark, Diagram, Edit, Microphone, Chat, Bookmark, Archive } from '@carbon/icons-react';
import { DISCOVER_FORMATS, type DiscoverItem, type DiscoverWorkflowState } from '../../services/api';
import { SparkCaptureButton } from '../sparks/SparkCaptureButton';
import { ConnectionsPanel } from '../connections/ConnectionsPanel';
import { copyItemToCanvas } from '../../features/canvas/canvasClipboard';
import { useAthenaContext } from '../../context/AthenaContext';
import { whyPicked } from '../../features/discover/discoverInsights';

interface DiscoverExploreProps {
  item: DiscoverItem;
  tagNames: string[];
  isUpdating: boolean;
  onClose: () => void;
  onStateChange: (id: string, state: DiscoverWorkflowState) => void;
  onLinkedIn: (item: DiscoverItem) => void;
  onBlog: (item: DiscoverItem) => void;
}

const FIT_LABEL = ['', 'Possible fit', 'Good fit', 'Strong fit'];

function anglePrompt(item: DiscoverItem): string {
  return [
    `Help me find my angle on “${item.title}” (${item.sourceTitle}).`,
    'Connect it to what I have written recently and to my active projects. Tell me what I could argue that most coverage will miss,',
    'whether it is worth a standalone piece or better as supporting evidence, and which format suits it best.',
  ].join(' ');
}

export const DiscoverExplore: React.FC<DiscoverExploreProps> = ({ item, tagNames, isUpdating, onClose, onStateChange, onLinkedIn, onBlog }) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const [sentToCanvas, setSentToCanvas] = useState(false);
  const { openAthena } = useAthenaContext();
  const reasons = whyPicked(item);
  const formats = DISCOVER_FORMATS
    .filter((f) => (item.formatFit?.[f.id] ?? 0) > 0)
    .sort((a, b) => item.formatFit[b.id] - item.formatFit[a.id]);
  const fits = [...(item.projectFit ?? [])].sort((a, b) => b.fit - a.fit);
  const isToReview = item.workflowState === 'to-review' || item.workflowState === 'shelved';

  useEffect(() => {
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent): void { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  function copyUrl(): void {
    if (item.url === null) return;
    void navigator.clipboard.writeText(item.url).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 2000);
    });
  }

  return createPortal(
    <div className="dc-explore" role="presentation" onClick={onClose}>
      <aside className="dc-explore__panel" role="dialog" aria-modal="true" aria-labelledby="dc-explore-title"
        onClick={(e) => { e.stopPropagation(); }}>
        <header className="dc-explore__header">
          <div className="dc-explore__meta">
            <span>{item.sourceTitle}</span>
            <span aria-hidden>·</span>
            <span>{new Date(item.publishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          </div>
          <button ref={closeRef} type="button" className="dc-explore__close" onClick={onClose} aria-label="Close">
            <Close size={20} />
          </button>
        </header>
        <h2 id="dc-explore-title" className="dc-explore__title">{item.title}</h2>
        {item.url !== null && (
          <a className="dc-explore__source-link" href={item.url} target="_blank" rel="noreferrer">
            Read the original <Launch size={16} />
          </a>
        )}

        <section className="dc-explore__section">
          <h3>Why it matters</h3>
          <p>{item.relevanceExplanation ?? 'Athena has not assessed this article yet.'}</p>
          {tagNames.length > 0 && <p className="dc-explore__tags">{tagNames.join(' · ')}</p>}
        </section>

        <section className="dc-explore__section">
          <h3>Your angle</h3>
          {item.alreadyCovered === 2 && item.coveredBy && <p>You’ve already made this argument in <em>{item.coveredBy}</em>. Only pick it up if there’s something new to add.</p>}
          {item.alreadyCovered === 1 && item.coveredBy && <p>This is a fresh angle on your piece <em>{item.coveredBy}</em>.</p>}
          <p className="dc-explore__hint">Athena can read this against your recent writing and projects and suggest what you would argue.</p>
          <button type="button" className="dc-explore__primary" onClick={() => {
            openAthena(anglePrompt(item), {
              type: 'discover item',
              title: item.title,
              detail: [item.sourceTitle, item.relevanceExplanation ?? '', item.sparkReason ?? '', item.url ?? ''].filter(Boolean).join(' | '),
            });
            onClose();
          }}>
            <Chat size={16} /> Ask Athena for my angle
          </button>
        </section>

        <section className="dc-explore__section">
          <h3>Related to your work</h3>
          {fits.length === 0
            ? <p className="dc-explore__hint">No direct link to an active project.</p>
            : <ul className="dc-explore__list">
              {fits.map((fit) => (
                <li key={fit.projectId}><strong>{fit.name}</strong>{fit.fit === 2 ? ' · direct' : ' · background'} — {fit.why}</li>
              ))}
            </ul>}
          <ConnectionsPanel refId={item.id} refType="discover_item" />
        </section>

        {reasons.length > 0 && (
          <section className="dc-explore__section">
            <h3>Why Athena picked this</h3>
            <ul className="dc-explore__list">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          </section>
        )}

        <section className="dc-explore__section">
          <h3>Create from this</h3>
          {formats.length > 0 && (
            <ul className="dc-explore__formats" aria-label="Format suitability">
              {formats.map((f) => (
                <li key={f.id}>
                  {f.id === 'podcast' && <Microphone size={16} aria-hidden="true" />}
                  <span>{f.label}</span>
                  <span className={`dc-explore__fit dc-explore__fit--${item.formatFit[f.id].toString()}`}>{FIT_LABEL[item.formatFit[f.id]]}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="dc-explore__actions">
            <button type="button" className="dc-explore__action" onClick={() => { onLinkedIn(item); }}>
              <Edit size={16} /> Social post
            </button>
            <button type="button" className="dc-explore__action" onClick={() => { onBlog(item); }}>
              <Launch size={16} /> Publish to blog
            </button>
            {item.workflowState !== 'blog' && (
              <button type="button" className="dc-explore__action" disabled={isUpdating}
                onClick={() => { onStateChange(item.id, 'blog'); }}>
                <Edit size={16} /> Plan as blog
              </button>
            )}
            <SparkCaptureButton sourceId={item.id} initialTags={tagNames} />
            <button type="button" className="dc-explore__action" onClick={() => {
              void copyItemToCanvas({
                id: item.id, refType: 'discover_item', label: item.title,
                ...(item.relevanceExplanation ? { body: item.relevanceExplanation } : {}),
                ...(item.url ? { url: item.url } : {}),
                ...(tagNames.length > 0 ? { tags: tagNames } : {}),
              });
              setSentToCanvas(true);
              setTimeout(() => { setSentToCanvas(false); }, 2000);
            }}>
              <Diagram size={16} /> {sentToCanvas ? 'Copied' : 'Canvas'}
            </button>
            {item.url !== null && (
              <button type="button" className="dc-explore__action" onClick={copyUrl}>
                {copied ? <Checkmark size={16} /> : <Link size={16} />} {copied ? 'Copied' : 'Copy link'}
              </button>
            )}
            {item.url !== null && item.workflowState !== 'published' && (
              <button type="button" className="dc-explore__action" disabled={isUpdating}
                onClick={() => { onStateChange(item.id, 'published'); }}>
                <Checkmark size={16} /> Mark published
              </button>
            )}
          </div>
        </section>

        {isToReview && (
          <footer className="dc-explore__footer">
            <button type="button" className="dc-explore__primary" disabled={isUpdating}
              onClick={() => { onStateChange(item.id, 'saved'); onClose(); }}>
              <Bookmark size={16} /> Save
            </button>
            <button type="button" className="dc-explore__action" disabled={isUpdating}
              onClick={() => { onStateChange(item.id, 'archived'); onClose(); }}>
              <Archive size={16} /> Not interested
            </button>
          </footer>
        )}
      </aside>
    </div>,
    document.body,
  );
};
