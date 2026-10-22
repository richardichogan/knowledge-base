import { PROJECT_IMAGINE, SECRET_CANARY, stableUuid } from './constants.js';
import type { CorpusRecord, Provenance } from './corpus.js';

/** Fixture family kinds mirror src/ai/knowledge/manifest.ts; the fixtures test asserts the two stay in step. */
export const FAMILY_KINDS = [
  'project', 'note', 'library-document', 'discover-article', 'youtube', 'connected-activity', 'task', 'person', 'spark', 'canvas',
  'graph', 'watchlist', 'chat', 'output-decision', 'memory', 'use-case', 'build', 'governance', 'podcast-content', 'cfp-practice',
  'knowledge-health',
] as const;

/** Mirrors every member of the ContentSource union in src/types/contentItem.ts. */
export const CONTENT_SOURCES: readonly { source: string; family: string; provenance: Provenance }[] = [
  { source: 'cms-blog', family: 'connected-activity', provenance: 'imported' },
  { source: 'cms-newsletter', family: 'connected-activity', provenance: 'imported' },
  { source: 'cms-podcast-show-notes', family: 'podcast-content', provenance: 'imported' },
  { source: 'cms-session-summary', family: 'connected-activity', provenance: 'imported' },
  { source: 'gitlab-commit', family: 'connected-activity', provenance: 'imported' },
  { source: 'gitlab-mr', family: 'connected-activity', provenance: 'imported' },
  { source: 'gitlab-issue', family: 'connected-activity', provenance: 'imported' },
  { source: 'gitlab-pipeline', family: 'connected-activity', provenance: 'imported' },
  { source: 'github-commit', family: 'connected-activity', provenance: 'imported' },
  { source: 'github-pr', family: 'connected-activity', provenance: 'imported' },
  { source: 'github-issue', family: 'connected-activity', provenance: 'imported' },
  { source: 'github-content-store', family: 'library-document', provenance: 'imported' },
  { source: 'github-doc', family: 'library-document', provenance: 'imported' },
  { source: 'graph-calendar', family: 'connected-activity', provenance: 'imported' },
  { source: 'graph-todo', family: 'connected-activity', provenance: 'imported' },
  { source: 'podcast-episode', family: 'podcast-content', provenance: 'imported' },
  { source: 'ai-session', family: 'chat', provenance: 'ai-generated' },
  { source: 'email', family: 'connected-activity', provenance: 'imported' },
  { source: 'github-action', family: 'connected-activity', provenance: 'imported' },
  { source: 'github-release', family: 'connected-activity', provenance: 'imported' },
  { source: 'github-deployment', family: 'connected-activity', provenance: 'imported' },
  { source: 'github-pr-review', family: 'connected-activity', provenance: 'imported' },
  { source: 'gitlab-release', family: 'connected-activity', provenance: 'imported' },
  { source: 'gitlab-deployment', family: 'connected-activity', provenance: 'imported' },
  { source: 'note', family: 'note', provenance: 'human' },
  { source: 'task', family: 'task', provenance: 'human' },
  { source: 'discovered-article', family: 'discover-article', provenance: 'imported' },
  { source: 'ica-document', family: 'library-document', provenance: 'imported' },
  { source: 'user-upload', family: 'library-document', provenance: 'imported' },
  { source: 'onedrive-document', family: 'library-document', provenance: 'imported' },
];

const FAMILY_PROVENANCE: Record<string, Provenance> = {
  project: 'human', note: 'human', 'library-document': 'imported', 'discover-article': 'imported', youtube: 'imported',
  'connected-activity': 'imported', task: 'human', person: 'human', spark: 'human', canvas: 'human', graph: 'derived', watchlist: 'ai-generated',
  chat: 'ai-generated', 'output-decision': 'human', memory: 'human', 'use-case': 'human', build: 'human', governance: 'human',
  'podcast-content': 'imported', 'cfp-practice': 'human', 'knowledge-health': 'derived',
};

/** A field the family deliberately does not project; the assertion is an explicit "unsupported", never a silent null. */
const FAMILY_UNSUPPORTED_FIELD: Record<string, string> = {
  project: 'integrationSecrets', note: 'noteHistory', 'library-document': 'binaryContent', 'discover-article': 'fullPublisherPage',
  youtube: 'transcript', 'connected-activity': 'remoteLiveState', task: 'calendarAttendees', person: 'unapprovedContactFields',
  spark: 'privateDraftBody', canvas: 'rasterisedImage', graph: 'rawEmbeddingVector', watchlist: 'rerunTrigger', chat: 'verbatimFromSummary',
  'output-decision': 'proposedActionsAsCompleted', memory: 'revokedMemoryText', 'use-case': 'buildEnvironment', build: 'rawExecutionEnvironment',
  governance: 'unreviewedPacketPayload', 'podcast-content': 'audioFile', 'cfp-practice': 'externalSubmissionPortal', 'knowledge-health': 'credentials',
};

/** Families whose records are derived or aggregate and so have no direct user update/delete path. */
const NO_UPDATE_DELETE = new Set(['graph', 'knowledge-health']);

export interface MinimalFixture {
  /** Family kind or ContentSource value. */
  key: string;
  level: 'family' | 'source';
  family: string;
  record: CorpusRecord;
  /** Unique token that only this fixture contains so discovery is unambiguous. */
  token: string;
  discovery: { query: string; expectId: string };
  read: { id: string; expectContains: string };
  update: { applicable: boolean; reason?: string; newText?: string; expectContains?: string };
  delete: { applicable: boolean; reason?: string; expectAbsentAfter?: string };
  exclusion: { excludeId: string; expectAbsentText: string; canaryField: { name: string; value: string } };
  provenance: { expected: Provenance; origin: string };
  unsupportedField: { field: string; expectedStatus: 'unsupported' };
}

function build(key: string, level: 'family' | 'source', family: string, provenance: Provenance): MinimalFixture {
  const slug = key.replace(/[^a-z0-9]+/gi, '');
  const token = `zq${level}${slug}fixturetoken`;
  const alias = `MIN-${level.toUpperCase()}-${key}`;
  const id = stableUuid(alias);
  const record: CorpusRecord = {
    alias, kind: family, ...(level === 'source' ? { source: key } : {}), id, projectId: PROJECT_IMAGINE,
    title: `Minimal ${key} fixture`, text: `Minimal ${key} fixture body with ${token}.`, provenance,
    role: 'minimal', createdAt: '2026-10-20T09:00:00Z', updatedAt: '2026-10-20T09:00:00Z',
    excludedField: { name: 'rawMetadata', value: SECRET_CANARY },
  };
  const noUpdate = NO_UPDATE_DELETE.has(family);
  return {
    key, level, family, record, token,
    discovery: { query: token, expectId: id },
    read: { id, expectContains: token },
    update: noUpdate
      ? { applicable: false, reason: `${family} is derived/aggregate; changes arrive via its authoritative sources` }
      : { applicable: true, newText: `${record.text} Updated revision zqupdated.`, expectContains: 'zqupdated' },
    delete: noUpdate
      ? { applicable: false, reason: `${family} is derived/aggregate; tombstones come from source deletion` }
      : { applicable: true, expectAbsentAfter: token },
    exclusion: { excludeId: id, expectAbsentText: token, canaryField: { name: 'rawMetadata', value: SECRET_CANARY } },
    provenance: { expected: provenance, origin: level === 'source' ? `content_items.source=${key}` : `family:${family}` },
    unsupportedField: { field: FAMILY_UNSUPPORTED_FIELD[family] ?? 'unsupportedField', expectedStatus: 'unsupported' },
  };
}

export const FAMILY_FIXTURES: readonly MinimalFixture[] = FAMILY_KINDS.map((k) => build(k, 'family', k, FAMILY_PROVENANCE[k] ?? 'human'));
export const SOURCE_FIXTURES: readonly MinimalFixture[] = CONTENT_SOURCES.map((s) => build(s.source, 'source', s.family, s.provenance));
export const MINIMAL_FIXTURES: readonly MinimalFixture[] = [...FAMILY_FIXTURES, ...SOURCE_FIXTURES];
