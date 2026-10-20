import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@carbon/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AthenaContextProvider } from '../src/context/AthenaContext';
import { CollapsibleSection } from '../src/components/CollapsibleSection';
import { ConnectionsPanel } from '../src/components/connections/ConnectionsPanel';
import { DiscoverExplore } from '../src/components/discover/DiscoverExplore';
import { CanvasDetailsTab, CanvasPreviewTab, CanvasSuggestionsTab } from '../src/features/canvas/CanvasSidePanel';
import { GraphSelectionPanel } from '../src/components/graph/GraphSelectionPanel';
import { LinkPreviewContent } from '../src/notes/LinkPreviewPanel';
import { NoteWriting } from '../src/notes/NotePopout';
import { projectPickerProjects } from './projectPickerFixtures';
import { api, type CanvasNodeApi, type DiscoverItem, type GraphNode } from '../src/services/api';
import type { ApiResponse } from '../src/types/apiResponse';
import '../src/styles/global.scss';
import '../src/styles/discoverWatchlists.scss';
import '../src/features/diagram/diagram.scss';
import './panel-typography.scss';

const success = <T,>(data: T): ApiResponse<T> => ({ success: true, data });
const prose = 'A GitHub Copilot model change matters to enterprise governance. This explanation wraps across several lines without moving the text edge.';
const now = '2026-10-20T08:00:00Z';
const card: CanvasNodeApi = {
  id: 'card', canvasId: 'map', nodeType: 'reference', refType: 'note', refId: 'note',
  label: 'Selected note', body: prose, url: null, tags: [], x: 0, y: 0, placed: true, createdAt: now,
};
const graphNodes: GraphNode[] = ['first', 'second'].map(id => ({
  id, refId: id, refType: 'note', title: id, tags: ['Governance'], createdAt: now, conceptParent: null,
}));
const item: DiscoverItem = {
  id: 'review', sourceId: 'source', title: 'GitHub Copilot model changes', sourceTitle: 'GitHub',
  url: null, description: prose, publishedAt: now, indexedAt: now, workflowState: 'saved',
  relevanceScore: 0.9, relevanceExplanation: prose, publishedUrl: null, taxonomyTagIds: [],
  articleType: null, platform: null, sourceType: null, spark: false, sparkReason: null, compositeScore: null,
  formatFit: { fullBlog: 0, quickBlog: 0, social: 1, newsletter: 1, podcast: 2 },
  projectFit: [{ projectId: 'ibm', name: 'IBM / MSFT Practice', fit: 2, why: prose }],
  pickReasons: [prose, 'Good match to your editorial priorities.'],
};
api.getProjects = async () => success([{
  ...projectPickerProjects[3]!, description: prose, goal: prose,
  role: 'Architect', startDate: '2026-10-19', targetEndDate: '2026-11-30',
  expectedOutputs: [prose, 'An implementation specification with measurable acceptance criteria.'],
}]);
api.getNoteSummaries = async () => success({ items: [], total: 0, page: 1, pageSize: 6, hasMore: false });
api.getEntityBacklinks = async () => success({ items: [], hasMore: false });
api.getTaxonomy = async () => success([]);
api.getConnections = async () => success({
  thematically_related: ['Cloudy: Episode 44', 'Governance implementation specification'].map((title, index) => ({
    edgeId: `edge-${index}`, edgeType: 'thematically_related', confidence: 0.9, metadata: { reason: prose },
    connectedNode: { id: `node-${index}`, refId: `note-${index}`, refType: 'note', title }, createdAt: now,
  })),
});
api.getCanvasSuggestions = async () => success([{
  kind: 'note', refType: 'note', refId: 'suggestion', title: 'Related note', excerpt: prose,
  date: null, url: null, via: 'graph',
}]);
api.getCanvasCardContent = async () => success({ kind: 'note', title: 'Selected note', text: `### Summary\n\n${prose}`, url: null, date: now });

function Sample({ id, children }: { id: string; children: React.ReactNode }): React.ReactElement {
  return <section id={id} className="panel-review__sample"><header className="panel-review__label">{id}</header>{children}</section>;
}

function Fixture(): React.ReactElement {
  const [explore, setExplore] = useState(false);
  return <main className="panel-review">
    <button className="kb-import-btn" id="open-explore" onClick={() => { setExplore(true); }}>Open Explore</button>
    <div className="panel-review__grid">
      <Sample id="metadata"><CollapsibleSection label="Details">
        <p className="notes-meta-section-label">Description</p><p className="notes-meta-section-value">{prose}</p>
      </CollapsibleSection></Sample>
      <Sample id="connections"><ConnectionsPanel refId="review" refType="discover_item" /></Sample>
      <Sample id="canvas-details"><CanvasDetailsTab map={{
        id: 'map', title: 'Review', canvasType: 'brainstorm', description: null, project: null,
        createdAt: now, updatedAt: now, linkedNotes: [], nodes: [], edges: [], nodeCount: 0, viewport: { x: 0, y: 0, zoom: 1 },
      }} node={undefined} onUpdate={() => {}} onDelete={() => {}} onSelect={() => {}}
        onRetype={() => {}} onUnlink={() => {}} onOpen={() => {}} onToNote={async () => {}} onDeleteCanvas={() => {}} /></Sample>
      <Sample id="canvas-preview"><CanvasPreviewTab canvasId="map" node={card} onOpen={() => {}} /></Sample>
      <Sample id="canvas-suggestions"><CanvasSuggestionsTab canvasId="map" node={undefined} contextLabels=""
        onCanvas={new Set()} onAdd={() => {}} /></Sample>
      <Sample id="library"><div className="docs-info-panel docs-info-panel--embedded">
        <div className="docs-info-panel__section"><p className="docs-info-panel__label">Title</p><p className="docs-info-panel__value">{prose}</p></div>
      </div></Sample>
      <Sample id="link-preview"><LinkPreviewContent target={{ type: 'project', id: 'imagine', title: 'IMAGINE', href: '/projects?projectId=imagine' }} onClose={() => {}} /></Sample>
      <Sample id="headerless-connections"><ConnectionsPanel refId="note" refType="note" headerless /></Sample>
      <Sample id="task"><section className="tp-section"><h3 className="tp-section__heading">Activity</h3>
        <div className="tp-log"><div className="tp-log__entry"><span className="tp-log__time">Today</span><p className="tp-log__body">{prose}</p></div></div>
      </section></Sample>
      <Sample id="history"><section className="note-history"><p className="note-history__intro">{prose}</p>
        <ol className="note-history__list"><li><button className="note-history__entry"><strong>Automatic checkpoint</strong><span>{prose}</span></button></li></ol>
      </section></Sample>
      <Sample id="use-case"><div className="kh-uc-panel"><section className="kh-uc-section"><h3 className="kh-uc-section__title">Spec</h3><p className="kh-uc-hint">{prose}</p></section></div></Sample>
      <Sample id="graph"><GraphSelectionPanel nodes={graphNodes} onClose={() => {}} /></Sample>
      <Sample id="sparks"><section className="spark-panel__section"><h2 className="spark-panel__heading">Themes</h2><p className="spark-panel__empty">{prose}</p></section></Sample>
      <Sample id="people"><div className="people-page"><section className="people-page__panel"><h2>Contact</h2><p>{prose}</p>
        <dl className="people-page__details"><dt>About</dt><dd>{prose}</dd></dl>
      </section></div></Sample>
      <Sample id="watchlists"><div className="dw"><section className="dw-project-insights__item"><h6>Project insight</h6><p className="dw-summary">{prose}</p></section></div></Sample>
      <Sample id="build"><section className="build-panel"><h3 className="build-section__title">Plan notes</h3><p className="build-plan-notes">{prose}</p></section></Sample>
      <Sample id="chat-output"><div className="ai-output"><h3 className="ai-output__title">Output</h3><div className="ai-bubble-text--md"><h3>Summary</h3><p>{prose}</p><blockquote><p>{prose}</p></blockquote>
        <ul><li>{prose}<ul><li>Nested bullet</li></ul></li></ul><ol><li>{prose}</li></ol><pre><code>{'  preserve code indentation'}</code></pre>
      </div></div></Sample>
      <Sample id="document"><div className="docs-viewer__content"><h3>Summary</h3><p>{prose}</p><blockquote><p>{prose}</p></blockquote>
        <ul><li>{prose}<ul><li>Nested document bullet</li></ul></li></ul><ol><li>{prose}</li></ol>
      </div></Sample>
      <Sample id="authored-note"><div className="link-preview"><NoteWriting contentJson={JSON.stringify([
        { type: 'paragraph', content: prose },
        { type: 'bulletListItem', content: prose, children: [{ type: 'bulletListItem', content: 'Nested authored bullet' }] },
        { type: 'numberedListItem', content: prose },
      ])} /></div></Sample>
      <Sample id="diagram"><section className="dg-ai-props"><h3 className="dg-ai-props__heading">Governance</h3><p className="dg-ai-props__note">{prose}</p></section></Sample>
      <Sample id="maps"><div className="mm-note-maps"><h4 className="mm-note-maps__title">Maps</h4><span className="mm-note-maps__elements">{prose}</span></div></Sample>
      <Sample id="priority">{(['urgent', 'high', 'normal', 'low'] as const).map(priority =>
        <div key={priority} className={`kb-card kh-priority--${priority}`}>{priority}</div>)}
        <div className="kb-card kh-priority--urgent kb-card--done">Done</div>
      </Sample>
    </div>
    {explore && <DiscoverExplore item={item} tagNames={[]} isUpdating={false} onClose={() => { setExplore(false); }}
      onStateChange={() => {}} onLinkedIn={() => {}} onBlog={() => {}} />}
  </main>;
}

createRoot(document.getElementById('root')!).render(<Theme theme="g100"><QueryClientProvider client={new QueryClient()}>
  <MemoryRouter><AthenaContextProvider><Fixture /></AthenaContextProvider></MemoryRouter>
</QueryClientProvider></Theme>);

function el(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
function check(ok: boolean, message: string): void { if (!ok) throw new Error(message); }
function textLeft(element: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  return range.getBoundingClientRect().left;
}
function firstTextRect(element: HTMLElement): DOMRect {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (!node?.textContent?.length) throw new Error('Expected visible list text');
  const range = document.createRange();
  range.selectNodeContents(node);
  return range.getBoundingClientRect();
}
function indentedList(selector: string): void {
  const list = el(selector), item = list.querySelector<HTMLElement>(':scope > li')!;
  const style = getComputedStyle(list);
  check(style.listStyleType !== 'none' && style.listStylePosition === 'outside', `${selector}: visible outside markers`);
  const inset = firstTextRect(item).left - list.getBoundingClientRect().left;
  check(inset >= 31, `${selector}: list text must be visibly inset, including room for an inset marker (${inset}px)`);
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT), text = walker.nextNode()!;
  const range = document.createRange();
  range.selectNodeContents(text);
  const lines = [...range.getClientRects()];
  if (text.textContent!.length > 100) check(lines.length > 1, `${selector}: fixture must exercise a wrapped list item`);
  for (const line of lines) check(Math.abs(line.left - lines[0]!.left) < 1, `${selector}: wrapped text hangs under the first line`);
}
function aligned(a: string, b: string): void {
  const leftA = textLeft(el(a)), leftB = textLeft(el(b));
  check(Math.abs(leftA - leftB) < 1, `${a} (${leftA}px) and ${b} (${leftB}px) must share their text edge`);
}
async function waitFor(test: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Panel fixture timed out');
}
Object.assign(window, { runPanelTypographyChecks: async () => {
  await waitFor(() => document.querySelector('#connections .conn-item__reason') !== null &&
    document.querySelector('#canvas-preview .cv-preview__body p') !== null &&
    document.querySelector('#canvas-suggestions .mm-suggest__excerpt') !== null &&
    document.querySelector('#link-preview .link-preview__outputs') !== null &&
    document.querySelector('#authored-note [data-content-type="bulletListItem"]') !== null);
  const pairs = [
    ['#metadata .collapsible-section__label', '#metadata .notes-meta-section-value'],
    ['#connections .conn-panel__title', '#connections .conn-panel__intro'],
    ['#connections .conn-panel__title', '#connections .conn-group__label'],
    ['#connections .conn-panel__title', '#connections .conn-item__title'],
    ['#connections .conn-item__title', '#connections .conn-item__reason'],
    ['#canvas-details dt', '#canvas-details dd'],
    ['#canvas-preview .cv-preview__title', '#canvas-preview .cv-preview__annotation'],
    ['#canvas-preview .cv-preview__title', '#canvas-preview .cv-preview__body p'],
    ['#canvas-suggestions .mm-suggest__for', '#canvas-suggestions .mm-suggest__excerpt'],
    ['#graph .graph-detail-panel__section-label', '#graph .graph-detail-panel__edge-type'],
    ['#library .docs-info-panel__label', '#library .docs-info-panel__value'],
    ['#link-preview h3', '#link-preview .link-preview__text'],
    ['#link-preview dt', '#link-preview dd'],
    ['#task h3', '#task .tp-log__body'],
    ['#use-case h3', '#use-case p'],
    ['#sparks h2', '#sparks p'],
    ['#people h2', '#people p'],
    ['#people dt', '#people dd'],
    ['#watchlists h6', '#watchlists p'],
    ['#build h3', '#build p'],
    ['#chat-output .ai-bubble-text--md h3', '#chat-output .ai-bubble-text--md > p'],
    ['#chat-output .ai-bubble-text--md h3', '#chat-output blockquote p'],
    ['#document h3', '#document > div > p'],
    ['#document h3', '#document blockquote p'],
    ['#diagram h3', '#diagram p'],
    ['#maps h4', '#maps .mm-note-maps__elements'],
  ];
  for (const [a, b] of pairs) aligned(a!, b!);
  for (const selector of [
    '#metadata .notes-meta-section-value', '#connections .conn-item__reason', '#canvas-preview .cv-preview__body p',
    '#canvas-suggestions .mm-suggest__excerpt', '#library .docs-info-panel__value', '#link-preview .link-preview__text',
    '#task .tp-log__body', '#history .note-history__intro', '#use-case .kh-uc-hint', '#sparks .spark-panel__empty',
    '#people dd', '#diagram .dg-ai-props__note',
  ]) {
    check(getComputedStyle(el(selector)).fontSize === '14px', `${selector}: expected Athena 14px body text, found ${getComputedStyle(el(selector)).fontSize}`);
  }
  for (const selector of ['#canvas-details .mm-details', '#canvas-suggestions .mm-suggest', '#history .note-history', '#use-case .kh-uc-panel']) {
    const style = getComputedStyle(el(selector));
    check(parseFloat(style.paddingLeft) === 0 && parseFloat(style.paddingRight) === 0, `${selector} must not add a second gutter`);
  }
  for (const selector of ['#chat-output ul', '#chat-output ul ul', '#chat-output ol',
    '#document ul', '#document ul ul', '#document ol', '#link-preview .link-preview__outputs']) {
    indentedList(selector);
  }
  check(firstTextRect(el('#chat-output ul ul > li')).left - firstTextRect(el('#chat-output ul > li')).left >= 31,
    'Nested markdown bullets must advance another indent');
  for (const type of ['bulletListItem', 'numberedListItem']) {
    const list = el(`#authored-note [data-content-type="${type}"]`);
    const text = list.querySelector<HTMLElement>('.bn-inline-content')!;
    const paragraph = el('#authored-note [data-content-type="paragraph"] .bn-inline-content');
    check(firstTextRect(text).left - firstTextRect(paragraph).left >= 32, 'Authored editor list text and marker gutter remain inset');
  }
  const authoredBullets = document.querySelectorAll<HTMLElement>('#authored-note [data-content-type="bulletListItem"] .bn-inline-content');
  check(firstTextRect(authoredBullets[1]!).left - firstTextRect(authoredBullets[0]!).left >= 24, 'Authored nested list hierarchy preserved');
  for (const selector of ['#metadata .collapsible-section__label', '#link-preview h3', '#connections .conn-group__label',
    '#task h3', '#use-case h3', '#sparks h2', '#graph .graph-detail-panel__section-label', '#diagram h3', '#maps h4']) {
    const style = getComputedStyle(el(selector));
    check(parseFloat(style.fontSize) >= 15 && Number(style.fontWeight) >= 600, `${selector}: section headings must stand above ordinary 14px prose`);
  }
  check(parseFloat(getComputedStyle(el('#link-preview h2')).fontSize) >= 18, 'Link preview has a distinct panel title');
  check(parseFloat(getComputedStyle(el('#headerless-connections h2')).fontSize) >= 18, 'Headerless Connections retains a clear title');
  check(Number(getComputedStyle(el('#connections .conn-item__title')).fontWeight) > Number(getComputedStyle(el('#connections .conn-item__reason')).fontWeight),
    'Connection titles must be stronger than their explanations');
  const entries = document.querySelectorAll<HTMLElement>('#connections .conn-item');
  check(parseFloat(getComputedStyle(entries[1]!).borderTopWidth) >= 1, 'Connection entries have a visible separator');
  check(getComputedStyle(el('#chat-output pre code')).whiteSpace === 'pre', 'Code whitespace preserved');
  for (const [priority, colour] of Object.entries({
    urgent: 'rgb(250, 77, 86)', high: 'rgb(241, 194, 27)', normal: 'rgb(69, 137, 255)', low: 'rgb(111, 111, 111)',
  })) {
    check(getComputedStyle(el(`#priority .kh-priority--${priority}`)).borderLeftColor === colour, `${priority} priority colour preserved without inline styles`);
  }
  check(getComputedStyle(el('#priority .kb-card--done')).borderLeftColor === 'rgba(0, 0, 0, 0)', 'Done priority stripe remains transparent');
  for (const panel of document.querySelectorAll<HTMLElement>('.panel-review__sample')) {
    check(panel.scrollWidth <= panel.clientWidth + 1, `${panel.id}: no horizontal overflow at ${innerWidth}px`);
  }
  el('#metadata .collapsible-section__header').click();
  await waitFor(() => !document.querySelector('#metadata .collapsible-section__body'));
  el('#metadata .collapsible-section__header').click();
  await waitFor(() => !!document.querySelector('#metadata .collapsible-section__body'));
  el('#open-explore').click();
  await waitFor(() => !!document.querySelector('.dc-explore .conn-item__reason'));
  for (const section of document.querySelectorAll<HTMLElement>('.dc-explore__section')) {
    const heading = section.querySelector<HTMLElement>('h3');
    for (const body of section.querySelectorAll<HTMLElement>(':scope > p')) {
      check(heading !== null && Math.abs(textLeft(heading) - textLeft(body)) < 1, 'Explore prose aligns beneath headings');
    }
  }
  for (const list of document.querySelectorAll<HTMLElement>('.dc-explore__list')) {
    const heading = list.parentElement!.querySelector<HTMLElement>('h3')!;
    check(firstTextRect(list.querySelector<HTMLElement>('li')!).left - textLeft(heading) >= 31,
      'Explore explanations retain real, clearly indented bullets');
    check(getComputedStyle(list).listStyleType === 'disc', 'Explore explanation bullets must not be removed');
  }
  aligned('.dc-explore .conn-panel__title', '.dc-explore .conn-item__reason');
  for (const selector of ['.dc-explore__section > p', '.dc-explore__list', '.dc-explore .conn-item__reason']) {
    check(getComputedStyle(el(selector)).fontSize === '14px', `${selector}: Athena body typography`);
  }
  const panel = el('.dc-explore__panel');
  check(panel.scrollWidth <= panel.clientWidth + 1 && panel.getBoundingClientRect().right <= innerWidth + 1, 'Explore fits the viewport');
  return [`${pairs.length} measured heading/body alignment pairs`, 'Panel/content gallery; no horizontal overflow',
    'Distinct panel titles, section headings and connection item hierarchy', 'No nested panel gutters',
    'Rendered project, Explore, markdown and authored lists visibly indented with hanging wraps and nested levels',
    'Code whitespace preserved', 'Disclosure controls still work', 'Consistent Athena body typography'];
} });
