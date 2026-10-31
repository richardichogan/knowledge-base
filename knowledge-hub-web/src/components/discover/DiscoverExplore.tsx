/**
 * Explore panel for a Discover item: understand it, connect it to your work,
 * then create from it. Production actions live here rather than on the card.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Close, Launch, Link, Checkmark, Diagram, Edit, Chat, Bookmark, Archive, Rocket, Renew, ArrowRight, OverflowMenuHorizontal } from '@carbon/icons-react';
import { DISCOVER_FORMATS, type DiscoverItem, type DiscoverWorkflowState } from '../../services/api';
import { SparkCaptureButton } from '../sparks/SparkCaptureButton';
import { ConnectionsPanel } from '../connections/ConnectionsPanel';
import { copyItemToCanvas } from '../../features/canvas/canvasClipboard';
import { useAthenaContext } from '../../context/AthenaContext';
import { IdentityChip, identitiesFor, useIdentity } from '../../identity';
import { BAND_LABEL, relevanceBand, whyPicked } from '../../features/discover/discoverInsights';
import { UseCaseLauncher } from '../../features/useCases/UseCaseLauncher';
import { launchFromRef } from '../../features/useCases/useCaseView';
import { DiscoverParkingAction } from './DiscoverParkingAction';
import { YouTubeEvidenceNotice } from './YouTubeEvidenceNotice';
import { DiscoverVote } from './DiscoverVote';

interface DiscoverExploreProps {
  item: DiscoverItem;
  tagNames: string[];
  isUpdating: boolean;
  onClose: () => void;
  onStateChange: (id: string, state: DiscoverWorkflowState) => void;
  onLinkedIn: (item: DiscoverItem) => void;
  onBlog: (item: DiscoverItem, length?: 'short' | 'long') => void;
  embedded?: boolean;
  publishedUrlEditor?: React.ReactNode;
}

const FIT_LABEL = ['', 'Possible fit', 'Good fit', 'Strong fit'];

function anglePrompt(item: DiscoverItem): string {
  return [
    `Help me find my angle on “${item.title}” (${item.sourceTitle}).`,
    'Connect it to what I have written recently and to my active projects. Tell me what I could argue that most coverage will miss,',
    'whether it is worth a standalone piece or better as supporting evidence, and which format suits it best.',
  ].join(' ');
}

export const DiscoverExplore: React.FC<DiscoverExploreProps> = ({ item, tagNames, isUpdating, onClose, onStateChange, onLinkedIn, onBlog, embedded = false, publishedUrlEditor }) => {
  const exploreTags = identitiesFor(useIdentity(), item.taxonomyTagIds ?? []);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const [sentToCanvas, setSentToCanvas] = useState(false);
  const [useCaseOpen, setUseCaseOpen] = useState(false);
  const useCaseOpenRef = useRef(false);
  useCaseOpenRef.current = useCaseOpen;
  const useCaseLaunch = launchFromRef('discover_item', item.id, item.title);
  const { openAthena } = useAthenaContext();
  const reasons = whyPicked(item);
  const formats = DISCOVER_FORMATS
    .filter((f) => (item.formatFit?.[f.id] ?? 0) > 0)
    .sort((a, b) => item.formatFit[b.id] - item.formatFit[a.id]);
  const fits = [...(item.projectFit ?? [])].sort((a, b) => b.fit - a.fit);
  const band = relevanceBand(item);
  const verdict = item.platform?.trim() || (band ? BAND_LABEL[band] : 'Not assessed');
  const isToReview = item.workflowState === 'to-review' || item.workflowState === 'shelved';
  const workflowLabel = item.workflowState === 'to-review' ? 'For you' : item.workflowState === 'blog' ? 'Planned for blog'
    : item.workflowState.charAt(0).toUpperCase() + item.workflowState.slice(1);

  useEffect(() => {
    if (embedded) return;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent): void { if (e.key === 'Escape' && !useCaseOpenRef.current) onClose(); }
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [onClose, embedded]);

  function copyUrl(): void {
    if (item.url === null) return;
    void navigator.clipboard.writeText(item.url).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 2000);
    });
  }

  const content = <>
    <div className={embedded ? 'dc-explore-inline' : 'dc-explore'} role="presentation" onClick={embedded ? undefined : onClose}>
      <aside className="dc-explore__panel" role={embedded ? undefined : 'dialog'} aria-modal={embedded ? undefined : true} aria-labelledby="dc-explore-title"
        onClick={(e) => { e.stopPropagation(); }}>
        <header className="dc-article-heading">
          <div className="dc-explore__meta">
            <span className="dc-article-heading__source">{item.sourceTitle}</span>
            <span aria-hidden>·</span>
            <span>{new Date(item.publishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
            <span className="dc-article-status">{workflowLabel}</span>
            {item.relevanceScore !== null && <span className="dc-article-heading__relevance">{Math.round(item.relevanceScore * 100)}% relevant</span>}
          </div>
          <p className="dc-article-verdict"><span>Athena assessment</span><strong>{verdict}</strong></p>
          <h2 id="dc-explore-title" className="dc-explore__title">{item.title}</h2>
          <p className="dc-article-heading__assessment">{item.relevanceExplanation ?? 'Athena has not assessed this article yet.'}</p>
          <YouTubeEvidenceNotice item={item} />
          {!embedded && <button ref={closeRef} type="button" className="dc-explore__close" onClick={onClose} aria-label="Close">
            <Close size={20} />
          </button>}
        </header>
        <div className="dc-article-toolbar" role="group" aria-label="Article toolbar">
          <div className="dc-article-toolbar__triage">
            <DiscoverVote key={`${item.id}:${item.feedbackVote ?? 'none'}`} itemId={item.id} vote={item.feedbackVote ?? null} disabled={isUpdating} />
            {isToReview && <>
              <button type="button" className="dc-explore__primary" disabled={isUpdating}
                onClick={() => { onStateChange(item.id, 'saved'); }}>
                <Bookmark size={16} /> Save
              </button>
            </>}
            {(item.workflowState === 'saved' || item.workflowState === 'blog') && <>
              <button type="button" className="dc-explore__action" disabled={isUpdating}
                onClick={() => { onStateChange(item.id, item.workflowState === 'blog' ? 'saved' : 'to-review'); }}>
                <Renew size={16} /> {item.workflowState === 'blog' ? 'Back to Saved' : 'Unsave'}
              </button>
              <button type="button" className="dc-explore__action" disabled={isUpdating}
                onClick={() => { onStateChange(item.id, 'archived'); }}><Archive size={16} /> Archive</button>
            </>}
            {(item.workflowState === 'archived' || item.workflowState === 'shelved') &&
              <button type="button" className="dc-explore__action" disabled={isUpdating}
                onClick={() => { onStateChange(item.id, 'to-review'); }}><ArrowRight size={16} /> Restore</button>}
            {item.workflowState === 'published' &&
              <button type="button" className="dc-explore__action" disabled={isUpdating}
                onClick={() => { onStateChange(item.id, 'to-review'); }}><Renew size={16} /> Unpublish</button>}
          </div>
          <details className="dc-article-toolbar__more"
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.currentTarget.open = false;
                event.currentTarget.querySelector('summary')?.focus();
                event.stopPropagation();
              }
            }}
            onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
            }}>
            <summary aria-label="More article actions" title="More article actions">
              <OverflowMenuHorizontal size={20} /><span>More</span>
            </summary>
            <div className="dc-article-toolbar__create" aria-label="More article actions">
            <button type="button" className="dc-explore__action" onClick={() => { onLinkedIn(item); }}>
              <Edit size={16} /> Social post
            </button>
            <button type="button" className="dc-explore__action" onClick={() => { onBlog(item); }}>
              <Launch size={16} /> Publish to blog
            </button>
            {item.workflowState !== 'blog' && (
              <button type="button" className="dc-explore__action" disabled={isUpdating}
                onClick={() => { onStateChange(item.id, 'blog'); }}><Edit size={16} /> Plan as blog</button>
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
            }}><Diagram size={16} /> {sentToCanvas ? 'Copied' : 'Canvas'}</button>
            <button type="button" className="dc-explore__action" onClick={() => { setUseCaseOpen(true); }}>
              <Rocket size={16} /> Use case
            </button>
            {item.url !== null && (
              <button type="button" className="dc-explore__action" onClick={copyUrl}>
                {copied ? <Checkmark size={16} /> : <Link size={16} />} {copied ? 'Copied' : 'Copy link'}
              </button>
            )}
            {item.url !== null && item.workflowState !== 'published' && (
              <button type="button" className="dc-explore__action" disabled={isUpdating}
                onClick={() => { onStateChange(item.id, 'published'); }}><Checkmark size={16} /> Mark published</button>
            )}
            </div>
          </details>
        </div>
        <section className="dc-article-recommendation" aria-label="Article assessment and recommendations">
          <div className="dc-article-recommendation__formats">
            <h3>Turn into</h3>
            <DiscoverParkingAction key={item.id} item={item} renderRecommendations={(openFor, parkingBusy) => formats.length > 0 ? (
              <div className="dc-format-actions" role="group" aria-label="Recommended format actions">
                {formats.map(format => {
                  const fit = item.formatFit[format.id];
                  const label = format.id === 'podcast' ? 'Park for a podcast'
                    : format.id === 'newsletter' ? 'Park for a newsletter'
                      : format.id === 'social' ? 'Prepare a social post' : `Prepare a ${format.id === 'quickBlog' ? 'quick' : 'full'} blog post`;
                  return <button key={format.id} type="button"
                    className={`dc-format-action${fit === 3 ? ' dc-format-action--strong' : ''}`}
                    disabled={isUpdating || parkingBusy}
                    onClick={() => {
                      if (format.id === 'podcast' || format.id === 'newsletter') openFor(format.id);
                      else if (format.id === 'social') onLinkedIn(item);
                      else onBlog(item, format.id === 'quickBlog' ? 'short' : 'long');
                    }}>
                    <span>{label}</span><span className="dc-format-action__fit">{FIT_LABEL[fit]}</span>
                  </button>;
                })}
              </div>
            ) : <p>No format recommendation has been saved.</p>} />
          </div>
          <div className="dc-article-recommendation__projects">
            <h3>Project fit</h3>
            {fits.length ? <dl className="dc-project-fits">
              {fits.map(fit => <div key={fit.projectId}>
                <dt>{fit.name}</dt><dd><strong>{fit.fit === 2 ? 'Direct' : 'Background'}.</strong> {fit.why}</dd>
              </div>)}
            </dl> : <p>No direct link to an active project.</p>}
          </div>
        </section>
        <div className="dc-article-information">
          <dl className="dc-article-information__facts">
            {item.relevanceScore === null && <div><dt>Relevance</dt><dd>Not assessed</dd></div>}
            {item.articleType && <div><dt>Article type</dt><dd>{item.articleType}</dd></div>}
            {item.sourceAuthorityTier && <div><dt>Source authority</dt><dd>{item.sourceAuthorityTier}</dd></div>}
          </dl>
          {exploreTags.length > 0 && <div className="dc-explore__tags kh-chip-row" aria-label="Article topics">
            {exploreTags.map(tag => <IdentityChip key={tag.tagId} identity={tag} size="md" />)}
          </div>}
        </div>
        {item.url !== null && (
          <a className="dc-explore__source-link" href={item.url} target="_blank" rel="noreferrer">
            {item.contentBasis ? 'Watch the video' : 'Read the original'} <Launch size={16} />
          </a>
        )}
        {publishedUrlEditor}

        <section className="dc-explore__section">
          <h3>Your angle</h3>
          {item.alreadyCovered === 2 && item.coveredBy && <p>You’ve already made this argument in <em>{item.coveredBy}</em>. Only pick it up if there’s something new to add.</p>}
          {item.alreadyCovered === 1 && item.coveredBy && <p>This is a fresh angle on your piece <em>{item.coveredBy}</em>.</p>}
          <p className="dc-explore__hint">Athena can read this against your recent writing and projects and suggest what you would argue.</p>
          <button type="button" className="dc-explore__primary" onClick={() => {
            openAthena(anglePrompt(item), {
              type: 'discover item',
              title: item.title,
              detail: [item.sourceTitle, item.contentBasis === 'description-only' ? 'YouTube description only; no transcript. Do not infer spoken claims, quotes or timestamps. Use attributed secondary research to explain unfamiliar subjects; keep it separate from video claims.' : item.contentBasis === 'captions' ? 'YouTube public captions available; may be automatic or incomplete. Do not invent speech.' : '', item.relevanceExplanation ?? '', item.sparkReason ?? '', item.url ?? '', ...(item.relatedArticles ?? []).map(article => `Secondary background: ${article.title} ${article.url}`)].filter(Boolean).join(' | '),
            });
            if (!embedded) onClose();
          }}>
            <Chat size={16} /> Ask Athena for my angle
          </button>
        </section>

        <section className="dc-explore__section">
          <h3>Related to your work</h3>
          <ConnectionsPanel refId={item.id} refType="discover_item" />
        </section>

        {reasons.length > 0 && (
          <section className="dc-explore__section">
            <h3>Why Athena picked this</h3>
            <ul className="dc-explore__list">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          </section>
        )}

      </aside>
    </div>
    {useCaseOpen && useCaseLaunch !== null && <UseCaseLauncher launch={useCaseLaunch} onClose={() => { setUseCaseOpen(false); }} />}
  </>;
  return embedded ? content : createPortal(content, document.body);
};
