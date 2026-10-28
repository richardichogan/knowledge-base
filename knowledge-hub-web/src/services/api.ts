/**
 * Typed API client for the Knowledge Hub backend.
 * Base URL and token come from Vite env vars (VITE_* prefix).
 */

import axios, { type AxiosInstance } from 'axios';
import type { Design, DesignAsset, DesignDetail, DesignArtifact, DesignFeedback, DesignCollaboration, DesignProposal, DesignPackage, DesignPublication } from '../types/designs';
import type {
  ApiResponse,
  PaginatedList,
  ContentItemSummary,
  ChatRequest,
  ChatResponse,
  ChatTurnEvent,
  SessionTurnState,
  ChatOutputSummary,
  ChatOutput,
  ChatDecision,
  DecisionTracking,
  ChatScreen,
  ModelChoiceApi,
  ChatAlternate,
  UsedSourceApi,
  ChatMessage,
  ChatSessionSummary,
  AthenaPersona,
  ExportToThinkResponse,
  CreateTaskInput,
  PlanTask,
  CreateNoteInput,
  Note,
  NoteSummary,
  WriteActionProposal,
  AthenaMemory,
  MemoryScopeType,
} from '../types';
import { getApiToken } from './auth';
import type { AgentHandOffResult, AgentJob } from '../types/agentJobs';
import { requireApiData } from './apiError';
import type { DecisionLinkCandidate, DecisionLinkInput, DecisionSemantics } from '../types/semanticDecision';
import { normaliseTask } from '../types/task';
import type { TaskPriority, AtRiskTask, DayCheckin, CheckinAction } from '../types/task';
import type { DiagramAsset, DiagramDocument, DiagramDrilldownLink, DiagramSnapshot } from '../features/diagram/diagramTypes';
import type { GitHubPublication, GitHubPushPayload } from '../notes/types';
import type {
  CreateUseCaseInput, DraftSpecResult, HandoffInput, HandoffResult, UseCase, UseCaseDetail, UseCasePatch, UseCaseSourceRef,
} from '../types/useCases';
import type { PodcastPrepStatus } from '../types/podcastPrep';
import type { DiscoverFormat, DiscoverParking, ParkingSelection } from '../types/discover';
import type { WatchlistInput, Watchlist, WatchRun, WatchBaselineVersion, InterestWeight, WatchCompanyKnowledge } from '../types/watchlists';
import type { BacklinkPage, EntityLinkTarget, EntityLinkType } from '../notes/entityLinks';
import type { Person, PersonInput } from '../types/people';
import type { Company, CompanyInput, CompanyPerson, PersonRelationships } from '../types/companies';

export { DISCOVER_FORMATS, type DiscoverFormat } from '../types/discover';

export interface MuralStatus {
  clientId: string; configured: boolean; connected: boolean; boardUrl: string; redirectUrl: string;
}
export interface MuralBoardOption {
  id: string; title: string; url: string; workspace: string; archived: boolean;
}
export interface MuralRoomOption { id: number; name: string; workspace: string }
export interface MuralList<T> { items: T[]; warnings: string[] }

export type ProjectRegisterKind = 'question' | 'risk' | 'issue';
export interface ProjectRegisterItem {
  id: string; projectId: string; kind: ProjectRegisterKind; title: string; detail: string;
  status: 'open' | 'resolved'; resolution: string; owner: string; dueDate: string | null; taskId: string | null;
  sourceType: 'manual' | 'chat_decision'; sourceId: string | null; createdAt: string; updatedAt: string; resolvedAt: string | null;
}

export interface ProjectRegisterPage { items: ProjectRegisterItem[]; total: number; limit: number; offset: number }

export type PacketSourceType = 'note' | 'output' | 'decision';
export interface PacketCandidate { sourceType: PacketSourceType; sourceId: string; label: string; identity: string; updatedAt: string | null }
export interface ReviewPacketItem {
  position: number; sourceType: PacketSourceType; sourceId: string; label: string; capturedIdentity: string;
  capturedContent: string; checked: boolean; state: 'current' | 'changed' | 'missing'; currentIdentity: string | null; href: string;
}
export interface ReviewPacketSummary { id: string; title: string; status: 'draft' | 'approved'; approvedAt: string | null; createdAt: string; itemCount: number }
export interface ReviewPacket {
  id: string; projectId: string; title: string; status: 'draft' | 'approved'; approvedAt: string | null; createdAt: string;
  items: ReviewPacketItem[]; staleCount: number;
}
export interface ProjectRegisterInput {
  kind?: ProjectRegisterKind; title?: string; detail?: string; status?: 'open' | 'resolved'; resolution?: string;
  owner?: string; dueDate?: string | null; taskId?: string | null;
}
export type CockpitSection<T> = { available: true; data: T; truncated: boolean; total: number } | { available: false; error: string };
export interface CockpitLink { label: string; href: string; at: string | null; meta?: string; sourceId?: string }
export interface ProjectCockpit {
  projectId: string; generatedAt: string;
  outcome: CockpitSection<{ goal: string; expectedOutputs: string[]; lifecycleState: string; targetEndDate: string | null }>;
  commitments: CockpitSection<CockpitLink[]>;
  blockers: CockpitSection<CockpitLink[]>;
  register: CockpitSection<{ open: number; resolved: number; openByKind: Record<ProjectRegisterKind, number> }>;
  decisions: CockpitSection<CockpitLink[]>;
  notes: CockpitSection<CockpitLink[]>;
  outputs: CockpitSection<CockpitLink[]>;
}

// Use relative base URL so all requests go through the Vite dev proxy.
const BASE_URL = import.meta.env['VITE_API_URL'] as string | undefined ?? '';
/** Backend origin ('' in dev, where Vite proxies /api and /auth). */
export const API_BASE_URL = BASE_URL;
const TOKEN = import.meta.env['VITE_API_TOKEN'] as string | undefined ?? '';

const TIMEOUT_MS = 8_000;
const AGENT_STREAM_SILENCE_MS = 45_000;
const AGENT_STREAM_CHECK_MS = 5_000;
// Blob upload + OCR polling on the backend can take up to ~40s; give image
// uploads a much longer client-side timeout than regular API calls.
const IMAGE_UPLOAD_TIMEOUT_MS = 60_000;
// AI chat turns can chain several tool calls (KG search, Library search, task
// writes) plus an LLM generation pass — this routinely exceeds the default
// 8s timeout, which was silently killing the request with no visible error.
// Kept just above the backend's own AI_CONVERSATION_TURN_BUDGET_MS (110s,
// see constants.ts) so a reasoning-model (gpt-5.4) turn that legitimately
// needs the full backend budget still gets a chance to finish before the
// client gives up on it.
const CHAT_TIMEOUT_MS = 120_000;
const DAILY_INSIGHTS_TIMEOUT_MS = 240_000;

function makeClient(baseURL: string, token: string): AxiosInstance {
  const client = axios.create({
    baseURL,
    timeout: TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      ...(token !== '' && { Authorization: `Bearer ${token}` }),
    },
  });
  // Microsoft sign-in token (production) takes precedence over the static one.
  client.interceptors.request.use(async (config) => {
    const signedIn = await getApiToken();
    if (signedIn !== '') config.headers.set('Authorization', `Bearer ${signedIn}`);
    return config;
  });
  return client;
}

/**
 * Reads a chat turn's live events (server-sent events over fetch, so the
 * sign-in header can be sent). Resolves when the stream ends; the caller
 * decides whether to reconnect.
 */
export async function readChatTurnEvents(
  turnId: string,
  onEvent: (e: ChatTurnEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const signedIn = await getApiToken();
  const auth = signedIn !== '' ? signedIn : TOKEN;
  const response = await fetch(`${BASE_URL}/api/ai/chat/turns/${turnId}/events`, {
    headers: auth !== '' ? { Authorization: `Bearer ${auth}` } : {},
    signal,
  });
  if (!response.ok || response.body === null) throw new Error(`Turn events failed: ${response.status.toString()}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data !== '') onEvent(JSON.parse(data) as ChatTurnEvent);
    }
  }
}

export interface NoteVersionSummary {
  id: string; revision: number; writing_updated_at: string; created_at: string;
  reason: 'automatic' | 'before_athena' | 'before_restore' | 'before_github'; restored_from: string | null;
}
export interface NoteVersion extends NoteVersionSummary {
  writing: { title: string; contentType: string; contentJson: string };
}

export interface TimelineQuery {
  rangeStart?: string;
  rangeEnd?: string;
  since?: string; // Recent activity by source update time, excluding future events
  page?: number;
  pageSize?: number;
  source?: string;
  projectContext?: string;
  before?: string; // ISO date cursor for day-boundary pagination
}

export interface SearchQuery {
  q: string;
  page?: number;
  pageSize?: number;
}

export type HealthSection<T> = { available: true; data: T } | { available: false; message: string };
export interface HealthUsageTotals {
  calls: number; failures: number; measuredCalls: number; unmeasuredCalls: number;
  promptTokens: number; cachedPromptTokens: number; completionTokens: number; reasoningCompletionTokens: number;
  totalTokens: number; avgLatencyMs: number | null;
}
export interface KnowledgeHealth {
  generatedAt: string;
  filters: { from: string; to: string; environment: 'prod' | 'dev'; feature: string | null; persona: string | null; deployment: string | null };
  windowStart: string;
  windowEnd: string;
  usage: HealthSection<{
    totals: HealthUsageTotals;
    rows: Array<HealthUsageTotals & { feature: string; persona: string | null; deployment: string }>;
    rowsTruncated: boolean;
    facets: { features: string[]; personas: string[]; deployments: string[] };
    firstRecordedAt: string | null;
  }>;
  syncRuns: HealthSection<{
    runs: Array<{ id: string; status: string; startedAt: string; finishedAt: string | null; sources: Array<{ source: string; indexed: number; errors: number }> }>;
    jobs: Array<{ job: string; period: string; status: string; startedAt: string; finishedAt: string | null }>;
  }>;
  index: HealthSection<{
    sources: Array<{ source: string; items: number; lastIndexedAt: string | null }>;
    scoring: { discoveredArticles: number; unscored: number };
  }>;
  /** Optional so an older server that lacks per-family coverage still renders. */
  families?: HealthSection<HealthFamilies>;
  retrievalQuality?: HealthSection<HealthRetrievalQuality>;
}
export interface HealthRetrievalQuality {
  auditedTurns: number; scopeMeasuredTurns: number; legacyUnattributedTurns: number;
  scopedTurns: number; blockedScopeTurns: number; temporalTurns: number; defaultWindowTurns: number;
  inheritedScopeTurns: number; deferredRecoveryTurns: number; foundNotRead: number; quoteWarningTurns: number; toolErrorTurns: number;
  documentReviews: number; documentReadChars: number; documentCheckpoints: number;
  budgetHitTurns: number; noRetrievalTurns: number;
  categories: Array<{ category: string; turns: number }>;
  legacyCategories: Array<{ category: string; turns: number }>;
  note: string;
}
export type HealthFamilyState = 'up-to-date' | 'partial' | 'unsupported-extraction' | 'not-configured' | 'temporarily-unavailable' | 'excluded';
export type HealthSemanticState = 'not-configured' | 'coverage-not-measured' | 'pending-work' | 'temporarily-unavailable' | 'up-to-date';
export interface HealthFamily {
  kind: string;
  availability: 'supported' | 'partial' | 'unavailable' | 'excluded';
  state: HealthFamilyState;
  capabilities: string[];
  entryPoint: string;
  reason: string;
  sources: string[];
  /** A null count is not measured, never zero. */
  counts: { eligible: number | null; indexed: number | null; pending: number | null; failed: number | null };
  extraction: { fullText: number; metadataOnly: number; atIngestionCap: number } | null;
  lastIndexedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  errorCategories: Array<'sync-errors' | 'sync-run-failed'>;
}
export interface HealthFamilies {
  families: HealthFamily[];
  semantic: {
    state: HealthSemanticState; providerConfigured: boolean; message: string;
    work: { measured: boolean; pending: number | null; failed: number | null; done: number | null };
  };
  orchestrationEnabled: boolean;
  decisionTablesMeasured: boolean;
  lastSuccessfulSyncAt: string | null;
}
export interface KnowledgeHealthParams { from?: string; to?: string; environment?: 'prod' | 'dev'; feature?: string; persona?: string; deployment?: string }

export interface SourceStatus {
  source: string;
  lastSyncAt: string | null;
  itemCount: number;
  lastError: string | null;
  syncCadenceMinutes: number | null;
  status: 'ok' | 'error' | 'never-synced';
}

export interface ConnectionCredential {
  id: string;
  name: string;
  detail: string;
  helpUrl?: string;
  configured: boolean;
  /** Set when no dedicated key is saved and the named shared key is used instead. */
  usingFallback: string | null;
  updatedAt: string | null;
}

export interface EmailAccountConnection {
  id: string;
  email: string;
  provider: 'Microsoft 365' | 'Outlook.com' | 'Gmail';
  status: 'configured' | 'not-connected';
  detail: string;
}

export type DocType = 'blog-draft' | 'spec' | 'newsletter' | 'readme' | 'doc';

export interface DocEntry {
  id: string;
  /** Database id — the document's knowledge-graph node id; absent for live GitHub listings. */
  contentItemId?: string;
  title: string;
  type: DocType;
  repo: string;
  path: string;
  sourceLabel: string;
  projectId: string;
  htmlUrl: string;
  size: number;
  tags: string[];
  taxonomyTagIds?: string[];
  /** Files indexed by Athena Desktop: where the file lives on the PC. */
  localPath?: string;
  deviceName?: string;
}

/** One file Athena Desktop has indexed from a PC. */
export interface LocalIndexEntry {
  localKey: string;
  localPath: string;
  localHash: string;
  contentItemId: string;
  blobPath: string | null;
}

export interface AllianceStatus {
  configured: boolean;
  connected: boolean;
  account: string | null;
  connectedAt: string | null;
  lastError: string | null;
  root: string;
  syncRunning: boolean;
  sync: { lastSyncAt: string | null; fileCount: number; documentCount: number; lastError: string | null };
}

export interface DocumentContent {
  path: string;
  content: string;
  sha: string;
  /** True when GitHub was unreachable and this is the indexed (plain-text) copy. */
  fromIndex?: boolean;
}

export type DiscoverWorkflowState = 'to-review' | 'saved' | 'blog' | 'archived' | 'published' | 'shelved';
export type DiscoverFeedbackVote = 'up' | 'down' | null;

/** Workflow states for CFP items (separate from article workflow) */
export type CfpWorkflowState = 'to_review' | 'saved' | 'submitted' | 'archived';

export interface SyncRun {
  id: string;
  status: 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  results: { source: string; indexed: number; errors: number; durationMs: number }[];
}

export interface CfpItem {
  id: string;
  source: 'callingallpapers' | 'adatosystems';
  conferenceName: string;
  description: string | null;
  tags: string[];
  eventUri: string | null;
  cfpUri: string;
  cfpDeadline: string;
  eventStart: string | null;
  eventEnd: string | null;
  location: string | null;
  isVirtual: boolean;
  relevanceScore: number | null;
  relevanceReason: string | null;
  workflowState: CfpWorkflowState;
  discoveredAt: string;
}

export type ProjectColour =
  | 'blue' | 'cyan' | 'teal' | 'green' | 'lime' | 'yellow' | 'orange'
  | 'red' | 'magenta' | 'purple' | 'indigo' | 'warm-gray' | 'gray';
export type ProjectCategory = 'work' | 'personal' | 'side-hustle';
export type ProjectPriority = 'low' | 'medium' | 'high';
export type ProjectType = 'standard' | 'formal-client';
export type ProjectLifecycleState = 'active' | 'paused' | 'completed' | 'archived';
export type ProjectImportance = 'critical' | 'high' | 'normal' | 'low';

export interface ProjectLink { label: string; url: string; }

export interface Project {
  id: string;
  name: string;
  colour: ProjectColour;
  /** Identity icon key (see src/identity/icons.tsx). */
  icon: string;
  /** The tag that stands for this project wherever tags appear. Read-only. */
  tagId?: string | null;
  /** Project group / parent (IBM, Nelfin or Personal). Send null to ungroup. */
  groupId?: string | null;
  groupName?: string | null;
  category: ProjectCategory;
  priority: ProjectPriority;
  projectType: ProjectType;
  description: string;
  goal: string;
  role: string;
  ownership: string;
  lifecycleState: ProjectLifecycleState;
  startDate: string | null;
  targetEndDate: string | null;
  importance: ProjectImportance;
  expectedOutputs: string[];
  gitlabPaths: string[];
  githubRepos: string[];
  hasIcaDocumentCollection: boolean;
  icaDocumentCollectionName: string;
  icaDocumentCollectionId: string;
  links: ProjectLink[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RepoTagMapping {
  id: string;
  tagId: string;
  tagName: string;
  tagColour: string | null;
  githubRepos: string[];
  gitlabPaths: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TaxonomyTag {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  colour: string | null;
  role: 'filing' | 'concept';
  /** Set when this tag stands for a project. */
  projectId?: string | null;
  usageCount: number;
  children?: TaxonomyTag[];
}

export interface PendingSuggestion {
  id: string;
  suggestedName: string;
  suggestedCount: number;
  exampleContent: string[];
  status: 'pending' | 'accepted' | 'rejected' | 'merged';
  mergedToId: string | null;
  createdAt: string;
  likelyMatch?: { id: string; name: string } | null;
}

export interface Spark {
  id: string;
  sourceId: string | null;
  sourceType: string | null;
  body: string;
  tags: string[];
  clusterId: string | null;
  createdAt: string;
  /** Title of the note / article the spark was captured from, when known. */
  sourceTitle: string | null;
  usedAt: string | null;
  usedType: SparkOutputType | null;
  usedRef: string | null;
  usedTitle: string | null;
}

export type PlanReviewAction = 'reschedule' | 'complete' | 'archive' | 'split';
export interface PlanReviewProposal {
  taskId: string;
  title: string;
  projectId: string;
  priority: TaskPriority;
  action: PlanReviewAction;
  reason: string;
  dueDate?: string;
  subtasks?: string[];
}
export interface PlanReview { proposals: PlanReviewProposal[]; source: 'athena' | 'rules'; reviewed: number }

export type SparkOutputType = 'note' | 'blog' | 'canvas' | 'project' | 'tasks';
export type SparkThemeStatus = 'active' | 'developed' | 'dismissed';

/** What a theme (or spark) became. */
export interface SparkOutput {
  type: SparkOutputType;
  ref: string;
  title: string;
  url?: string | null;
}

/** A Spark theme: a living cluster of related sparks that can grow and graduate. */
export interface SparkCluster {
  id: string;
  theme: string;
  status: SparkThemeStatus;
  sparkCount: number;
  /** True once the user has seen the theme on the Sparks page. */
  surfaced: boolean;
  dismissed: boolean;
  outputType: SparkOutputType | null;
  outputRef: string | null;
  outputTitle: string | null;
  outputUrl: string | null;
  developedAt: string | null;
  lastGrownAt: string | null;
  createdAt: string;
  updatedAt: string;
  newSinceDeveloped: number;
  sparks: Spark[];
}

export { MIN_THEME_SIZE } from './sparkConstants';

export interface ConnectionEdge {
  edgeId: string;
  edgeType: string;
  confidence: number;
  metadata: Record<string, unknown> | null;
  connectedNode: { id: string; refId: string; refType: string; title: string; url?: string | null };
  createdAt: string;
}

export type ConnectionsResponse = Record<string, ConnectionEdge[]>;

export interface GraphNode {
  id: string;
  refId: string;
  refType: string;
  title: string;
  tags: string[];
  createdAt: string;
  conceptParent: string | null;
  updatedAt?: string;
  projectIds?: string[];
  timestampBasis?: 'source' | 'index';
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  edgeType: string;
  confidence: number;
  metadata: Record<string, unknown> | null;
  createdAt?: string | null;
  origin?: 'explicit' | 'user_confirmed' | 'inferred';
}

export interface GraphResponse {
  rootId?: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    totalNodes: number;
    totalEdges: number;
    filteredNodes: number;
    filteredEdges: number;
    truncated: boolean;
  };
}

export type DiscoverSort = 'weighted' | 'editorial' | 'latest';

/** Counts behind the header tab badges. */
export interface NavAttention { think: number; discover: number; plan: number; build: number; jobs?: number }


export interface DiscoverItem {
  contentBasis?: 'description-only' | 'captions';
  relatedArticles?: Array<{ title: string; url: string }>;
  parking?: DiscoverParking;
  pickReasons?: string[];
  filteredReason?: string | null;
  id: string;
  sourceId: string;
  title: string;
  url: string | null;
  description: string | null;
  publishedAt: string;
  indexedAt: string;
  sourceTitle: string;
  workflowState: DiscoverWorkflowState;
  relevanceScore: number | null;
  relevanceExplanation: string | null;
  /** Live weighted score used by the backend to order articles; may exceed 1. */
  rankScore?: number | null;
  rankFactors?: {
    editorial: number | null; recency: number | null; authority: number; articleType: number;
    project: number; halfLifeDays: number; computedAt: string;
    interests?: number; diversity?: number;
  };
  /** URL of the user's own blog post written about this article */
  publishedUrl: string | null;
  /** Taxonomy tag UUIDs from discover_item_tags */
  taxonomyTagIds: string[];
  /** AI-classified article type */
  articleType: string | null;
  /** Treatment plan: Full Blog Post, LinkedIn Standalone, Newsletter Candidate, Archive, Podcast */
  platform: string | null;
  /** 0-3 fit per publishing format. */
  formatFit: Record<DiscoverFormat, number>;
  /** Source type: Formal, Community, Case Study, Advertorial */
  sourceType: string | null;
  /** Spark flag indicating high value */
  spark: boolean | null;
  /** Reason for spark flag */
  sparkReason: string | null;
  feedbackVote?: DiscoverFeedbackVote;
  /** Composite relevance score 0-10 */
  compositeScore: number | null;
  /** Authority tier of the source, e.g. "Microsoft/GitHub Official" */
  sourceAuthorityTier?: string | null;
  /** 0 = not covered, 1 = same story from another angle, 2 = he has already made this argument */
  alreadyCovered?: number | null;
  /** Title of his own piece that covers it */
  coveredBy?: string | null;
  /** Vendor group of the feed it came from */
  sourceGroup?: string | null;
  /** When it was shelved */
  shelvedAt?: string | null;
  /** Why: 'low' = scored as not worth content, 'stale' = unactioned for its time in To Review */
  shelvedReason?: string | null;
  /** Live projects this article is useful to (fit 2 = directly, 1 = background), strongest first */
  projectFit?: DiscoverProjectFit[];
}

export interface DiscoverProjectFit {
  projectId: string;
  name: string;
  fit: 1 | 2;
  why: string;
}

/** A feed Athena reads for article discovery. */
export interface DiscoveryFeed {
  id: string;
  title: string;
  feedUrl: string;
  groupName: string;
  isActive: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastNewCount: number;
  articlesFound: number;
}

export type NoteExtractionAction = 'spark' | 'task' | 'canvas' | 'note' | 'athena';
export interface NoteExtraction {
  id: string; quote: string; action: NoteExtractionAction;
  targetType: string | null; targetId: string | null; targetLabel: string; createdAt: string;
}

export interface SocialDraft {
  post: string;
  sourceUrl: string | null;
  sourceKind: 'email' | 'discovered-article';
  /** Whether the backend has a Bluesky app password configured. */
  blueskyConfigured?: boolean;
  /** Link to the Bluesky post when this article has already been posted. */
  blueskyPostUrl?: string | null;
  linkedinConfigured?: boolean;
  linkedinPostUrl?: string | null;
  linkedinPostStatus?: string | null;
}

export interface BlogDraft {
  title: string; excerpt: string; summary: string; content: string; keyTakeaways: string[]; categories: string[]; tags: string[];
  postType: 'article' | 'weekly' | 'newsletter' | 'podcast' | 'quick'; sourceUrl: string | null;
}

export interface BlogJobResult {
  url: string;
  subjectId: string;
  draft: BlogDraft;
  verification: { verified: boolean; issues: string[] };
  workflow?: {
    originalAvailable: boolean;
    remediationUsed: boolean;
    stages: Array<{ stage: string; result: unknown; at: string }>;
  };
  verifiedSignature?: string;
}

export class KnowledgeHubApi {
  async jobs<T>(path = '', method: 'GET' | 'POST' | 'PUT' = 'GET', data?: unknown): Promise<T> {
    const response = await this.client.request<ApiResponse<T>>({ url: `/api/jobs${path}`, method, data, timeout: 120_000 });
    return requireApiData(response.data);
  }
  async publishing<T>(path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', data?: unknown): Promise<T> {
    const response = await this.client.request<ApiResponse<T>>({ url: `/api/publishing${path}`, method, data, timeout: 120_000 });
    return requireApiData(response.data);
  }
  async exportMuralDiagram(diagram: import('../types/mural').MuralDiagramExport): Promise<ApiResponse<{ boardUrl: string; objects: number; connectors: number }>> {
    return (await this.client.post<ApiResponse<{ boardUrl: string; objects: number; connectors: number }>>(
      '/api/integrations/mural/export-diagram', diagram, { timeout: 600_000 })).data;
  }
  async getMuralStatus(): Promise<ApiResponse<MuralStatus>> {
    return (await this.client.get<ApiResponse<MuralStatus>>('/api/integrations/mural')).data;
  }
  async getMuralBoards(): Promise<ApiResponse<MuralList<MuralBoardOption>>> {
    return (await this.client.get<ApiResponse<MuralList<MuralBoardOption>>>('/api/integrations/mural/boards?includeWarnings=1')).data;
  }
  async getMuralRooms(): Promise<ApiResponse<MuralList<MuralRoomOption>>> {
    return (await this.client.get<ApiResponse<MuralList<MuralRoomOption>>>('/api/integrations/mural/rooms?includeWarnings=1')).data;
  }
  async createMuralBoard(input: { roomId: number; title: string }): Promise<ApiResponse<MuralBoardOption>> {
    return (await this.client.post<ApiResponse<MuralBoardOption>>('/api/integrations/mural/boards', input)).data;
  }
  async getShareEmailStatus(): Promise<ApiResponse<import('../types/shareEmail').ShareEmailStatus>> {
    return (await this.client.get<ApiResponse<import('../types/shareEmail').ShareEmailStatus>>('/api/integrations/share-email')).data;
  }
  async saveShareEmailConfig(input: { username: string; password: string; replyTo: string }): Promise<ApiResponse<import('../types/shareEmail').ShareEmailStatus>> {
    return (await this.client.put<ApiResponse<import('../types/shareEmail').ShareEmailStatus>>('/api/integrations/share-email', input)).data;
  }
  async verifyShareEmailConfig(): Promise<ApiResponse<{ verified: true }>> {
    return (await this.client.post<ApiResponse<{ verified: true }>>('/api/integrations/share-email/verify', {}, { timeout: 120_000 })).data;
  }
  async sendShareEmail(input: import('../types/shareEmail').ShareEmailInput): Promise<ApiResponse<import('../types/shareEmail').ShareEmailResult>> {
    return (await this.client.post<ApiResponse<import('../types/shareEmail').ShareEmailResult>>('/api/integrations/share-email/send', input, { timeout: 120_000 })).data;
  }
  async saveMuralConfig(input: { clientId: string; secret: string; boardUrl: string }): Promise<ApiResponse<MuralStatus>> {
    return (await this.client.put<ApiResponse<MuralStatus>>('/api/integrations/mural', input)).data;
  }
  async connectMural(): Promise<ApiResponse<{ url: string }>> {
    return (await this.client.post<ApiResponse<{ url: string }>>('/api/integrations/mural/connect')).data;
  }
  async finishMuralAuth(input: { code: string; state: string }): Promise<ApiResponse<{ connected: boolean }>> {
    return (await this.client.post<ApiResponse<{ connected: boolean }>>('/api/integrations/mural/callback', input, { timeout: 60_000 })).data;
  }
  async disconnectMural(): Promise<ApiResponse<{ connected: boolean }>> {
    return (await this.client.delete<ApiResponse<{ connected: boolean }>>('/api/integrations/mural/connection')).data;
  }
  async exportMuralImage(image: Blob, boardUrl: string, title: string): Promise<ApiResponse<{ boardUrl: string }>> {
    return (await this.client.post<ApiResponse<{ boardUrl: string }>>('/api/integrations/mural/export', image, {
      params: { boardUrl, title }, headers: { 'Content-Type': 'image/png' }, timeout: 150_000,
    })).data;
  }
  private readonly client: AxiosInstance;

  constructor(baseURL = BASE_URL) {
    this.client = makeClient(baseURL, TOKEN);
  }

  // ─── Timeline ────────────────────────────────────────────────────────────

  async getTimeline(
    query: TimelineQuery = {},
  ): Promise<ApiResponse<PaginatedList<ContentItemSummary>>> {
    const r = await this.client.get<
      ApiResponse<PaginatedList<ContentItemSummary>>
    >('/api/timeline', { params: query });
    return r.data;
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  async getChatMentionTargets(q = ''): Promise<ApiResponse<import('../chat/mentions').ChatMentionTarget[]>> {
    return (await this.client.get<ApiResponse<import('../chat/mentions').ChatMentionTarget[]>>('/api/ai/mention-targets', { params: { q } })).data;
  }

  async getPeople(q = ''): Promise<ApiResponse<Person[]>> {
    return (await this.client.get<ApiResponse<Person[]>>('/api/people', { params: { q } })).data;
  }

  async getCompanies(q = ''): Promise<ApiResponse<Company[]>> {
    return (await this.client.get<ApiResponse<Company[]>>('/api/companies', { params: { q } })).data;
  }
  async getCompany(id: string): Promise<ApiResponse<Company>> {
    return (await this.client.get<ApiResponse<Company>>(`/api/companies/${encodeURIComponent(id)}`)).data;
  }
  async getCompanyPeople(id: string): Promise<ApiResponse<CompanyPerson[]>> {
    return (await this.client.get<ApiResponse<CompanyPerson[]>>(`/api/companies/${encodeURIComponent(id)}/people`)).data;
  }
  async saveCompany(input: CompanyInput, id?: string): Promise<ApiResponse<Company>> {
    return id
      ? (await this.client.put<ApiResponse<Company>>(`/api/companies/${encodeURIComponent(id)}`, input)).data
      : (await this.client.post<ApiResponse<Company>>('/api/companies', input)).data;
  }
  async getPersonRelationships(id: string): Promise<ApiResponse<PersonRelationships>> {
    return (await this.client.get<ApiResponse<PersonRelationships>>(`/api/people/${encodeURIComponent(id)}/relationships`)).data;
  }
  async savePersonRelationships(id: string, input: PersonRelationships): Promise<ApiResponse<PersonRelationships>> {
    return (await this.client.put<ApiResponse<PersonRelationships>>(`/api/people/${encodeURIComponent(id)}/relationships`, input)).data;
  }

  async getPerson(id: string): Promise<ApiResponse<Person>> {
    return (await this.client.get<ApiResponse<Person>>(`/api/people/${encodeURIComponent(id)}`)).data;
  }

  async savePerson(input: PersonInput, id?: string): Promise<ApiResponse<Person>> {
    return id
      ? (await this.client.put<ApiResponse<Person>>(`/api/people/${encodeURIComponent(id)}`, input)).data
      : (await this.client.post<ApiResponse<Person>>('/api/people', input)).data;
  }

  async importPeople(people: PersonInput[]): Promise<ApiResponse<{ created: number; updated: number }>> {
    return (await this.client.post<ApiResponse<{ created: number; updated: number }>>('/api/people/import', { people })).data;
  }

  async deletePerson(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return (await this.client.delete<ApiResponse<{ deleted: boolean }>>(`/api/people/${encodeURIComponent(id)}`)).data;
  }

  async getLinkTargets(q = '', type?: EntityLinkType, id?: string, exclude?: string, signal?: AbortSignal): Promise<ApiResponse<EntityLinkTarget[]>> {
    const result = await this.client.get<ApiResponse<EntityLinkTarget[]>>('/api/notes/link-targets', { params: { q, type, id, exclude }, ...(signal && { signal }) });
    return result.data;
  }

  async suggestLinkTargets(text: string, exclude: string): Promise<ApiResponse<EntityLinkTarget[]>> {
    const result = await this.client.post<ApiResponse<EntityLinkTarget[]>>('/api/notes/link-suggestions', { text, exclude });
    return result.data;
  }

  async getEntityBacklinks(type: EntityLinkType, id: string, page = 1): Promise<ApiResponse<BacklinkPage>> {
    const result = await this.client.get<ApiResponse<BacklinkPage>>('/api/notes/entity-backlinks', { params: { type, id, page } });
    return result.data;
  }

  async getLinkPreview(type: EntityLinkType, id: string): Promise<ApiResponse<{ summary: string; details: { label: string; value: string }[] }>> {
    const result = await this.client.get<ApiResponse<{ summary: string; details: { label: string; value: string }[] }>>('/api/notes/link-preview', { params: { type, id } });
    return result.data;
  }

  async getNoteBacklinks(id: string, page = 1): Promise<ApiResponse<BacklinkPage>> {
    const result = await this.client.get<ApiResponse<BacklinkPage>>(`/api/notes/${id}/backlinks`, { params: { page } });
    return result.data;
  }

  async getUnlinkedNoteMentions(id: string, page = 1): Promise<ApiResponse<BacklinkPage>> {
    return (await this.client.get<ApiResponse<BacklinkPage>>(`/api/notes/${encodeURIComponent(id)}/unlinked-mentions`, { params: { page } })).data;
  }

  async search(
    query: SearchQuery,
    signal?: AbortSignal,
  ): Promise<ApiResponse<PaginatedList<ContentItemSummary>>> {
    const r = await this.client.get<
      ApiResponse<PaginatedList<ContentItemSummary>>
    >('/api/search', { params: query, ...(signal && { signal }) });
    return r.data;
  }

  // ─── Sources ──────────────────────────────────────────────────────────────

  async getKnowledgeHealth(params: KnowledgeHealthParams): Promise<ApiResponse<KnowledgeHealth>> {
    const r = await this.client.get<ApiResponse<KnowledgeHealth>>('/api/health/knowledge', { params });
    return r.data;
  }

  async getSources(): Promise<ApiResponse<SourceStatus[]>> {
    const r = await this.client.get<ApiResponse<SourceStatus[]>>('/api/sources');
    return r.data;
  }

  async getConnectionCredentials(): Promise<ApiResponse<ConnectionCredential[]>> {
    return (await this.client.get<ApiResponse<ConnectionCredential[]>>('/api/sources/credentials')).data;
  }

  async updateConnectionCredential(id: string, token: string): Promise<ApiResponse<{ verified: boolean }>> {
    return (await this.client.put<ApiResponse<{ verified: boolean }>>(`/api/sources/credentials/${encodeURIComponent(id)}`, { token })).data;
  }

  async getEmailAccountConnections(): Promise<ApiResponse<EmailAccountConnection[]>> {
    return (await this.client.get<ApiResponse<EmailAccountConnection[]>>('/api/sources/email-accounts')).data;
  }

  async triggerSync(): Promise<ApiResponse<SyncRun>> {
    const r = await this.client.post<ApiResponse<SyncRun>>('/api/sources/sync');
    return r.data;
  }
  async getSyncRun(id: string, signal?: AbortSignal): Promise<ApiResponse<SyncRun>> {
    const r = await this.client.get<ApiResponse<SyncRun>>(`/api/sources/runs/${encodeURIComponent(id)}`, signal === undefined ? {} : { signal });
    return r.data;
  }
  async getLatestSyncRun(): Promise<ApiResponse<SyncRun | null>> {
    const r = await this.client.get<ApiResponse<SyncRun | null>>('/api/sources/runs/latest');
    return r.data;
  }

  // ─── Notes (Change 002) ───────────────────────────────────────────────────

  async getNotes(
    page = 1,
    pageSize = 20,
  ): Promise<ApiResponse<PaginatedList<Note>>> {
    const r = await this.client.get<ApiResponse<PaginatedList<Note>>>(
      '/api/notes',
      { params: { page, pageSize } },
    );
    return r.data;
  }

  /** Lightweight note list for the Think sidebar: titles/previews only, no bodies. */
  async getNoteSummaries(page = 1, pageSize = 100, filters?: {
    q?: string; contentType?: string; excludeContentType?: string; projectId?: string; tagIds?: string; projectTagIds?: string;
    sort?: 'modified' | 'created' | 'title';
    status?: 'active' | 'archived';
    structure?: 'flat' | 'designs';
  }): Promise<ApiResponse<PaginatedList<NoteSummary>>> {
    const r = await this.client.get<ApiResponse<PaginatedList<NoteSummary>>>(
      '/api/notes',
      { params: { page, pageSize, view: 'summary', ...filters } },
    );
    return r.data;
  }

  /** One note with its full body. */
  async getNote(id: string, status: 'active' | 'archived' = 'active'): Promise<ApiResponse<Note>> {
    const r = await this.client.get<ApiResponse<Note>>(`/api/notes/${encodeURIComponent(id)}`, { params: { status } });
    return r.data;
  }

  async searchNotePassages(q: string, signal?: AbortSignal): Promise<ApiResponse<{
    items: Array<{ id: string; kind: 'important' | 'followUp' | 'question' | 'risk' | 'issue'; label: string; text: string; noteId: string; noteTitle: string }>;
    hasMore: boolean;
  }>> {
    return (await this.client.get('/api/notes/passage-tags/search', { params: { q }, ...(signal && { signal }) })).data;
  }

  async getPassageFollowups(noteId: string): Promise<ApiResponse<Array<{
    tagId: string; taskId: string | null; state: 'pending' | 'created'; taskTitle: string | null;
  }>>> {
    return (await this.client.get(`/api/notes/${encodeURIComponent(noteId)}/passage-followups`)).data;
  }

  async savePassageFollowup(noteId: string, tagId: string, task?: { title: string; body: string; projectId: string; passageText: string }): Promise<ApiResponse<{
    taskId: string | null; state: 'pending' | 'created';
  }>> {
    return (await this.client.post(`/api/notes/${encodeURIComponent(noteId)}/passage-followups/${encodeURIComponent(tagId)}`, task ?? {})).data;
  }

  async draftPassageFollowup(noteId: string, tagId: string): Promise<ApiResponse<{
    title: string; body: string; projectId: string; passageText: string;
  }>> {
    return (await this.client.post(`/api/notes/${encodeURIComponent(noteId)}/passage-followups/${encodeURIComponent(tagId)}/draft`,
      {}, { timeout: CHAT_TIMEOUT_MS })).data;
  }

  async removePassageFollowup(noteId: string, tagId: string, deleteTask: boolean, expectedTaskId: string | null): Promise<ApiResponse<{ removed: boolean }>> {
    return (await this.client.delete(`/api/notes/${encodeURIComponent(noteId)}/passage-followups/${encodeURIComponent(tagId)}`, {
      params: { deleteTask, expectedTaskId: expectedTaskId ?? '' },
    })).data;
  }

  async restoreArchivedNote(id: string, expectedRevision: number): Promise<ApiResponse<{ note: Note; restored: boolean }>> {
    return (await this.client.post<ApiResponse<{ note: Note; restored: boolean }>>(`/api/notes/${encodeURIComponent(id)}/restore-archive`, { expectedRevision })).data;
  }

  async recoverNoteDraft(id: string, writing: { title: string; contentType: string; contentJson: string }, expectedRevision: number): Promise<ApiResponse<Note>> {
    return (await this.client.post<ApiResponse<Note>>(`/api/notes/${encodeURIComponent(id)}/recover-draft`, { writing, expectedRevision })).data;
  }

  async getNoteGitHub(id: string, check = false): Promise<ApiResponse<GitHubPublication | null>> {
    return (await this.client.get<ApiResponse<GitHubPublication | null>>(`/api/notes/${encodeURIComponent(id)}/github`, {
      params: { check }, timeout: 60_000,
    })).data;
  }

  async getNoteGitHubRepositories(page = 1): Promise<ApiResponse<{ items: { name: string; defaultBranch: string; private: boolean }[]; hasMore: boolean }>> {
    return (await this.client.get<ApiResponse<{ items: { name: string; defaultBranch: string; private: boolean }[]; hasMore: boolean }>>('/api/notes/github/repositories', { params: { page }, timeout: 60_000 })).data;
  }

  async getNoteGitHubFolders(repo: string, folder: string): Promise<ApiResponse<{ folders: string[]; branch: string }>> {
    return (await this.client.get<ApiResponse<{ folders: string[]; branch: string }>>('/api/notes/github/folders', { params: { repo, folder }, timeout: 60_000 })).data;
  }

  async publishNoteToGitHub(payload: GitHubPushPayload): Promise<ApiResponse<GitHubPublication>> {
    return (await this.client.post<ApiResponse<GitHubPublication>>(`/api/notes/${encodeURIComponent(payload.noteId)}/github`, payload, { timeout: 120_000 })).data;
  }

  async getNoteGitHubRemote(id: string): Promise<ApiResponse<{ sha: string | null; markdown: string | null }>> {
    return (await this.client.get<ApiResponse<{ sha: string | null; markdown: string | null }>>(`/api/notes/${encodeURIComponent(id)}/github/remote`, { timeout: 60_000 })).data;
  }

  async resolveNoteGitHub(id: string, choice: 'think' | 'github', remoteSha: string | null, expectedRevision: number): Promise<ApiResponse<GitHubPublication>> {
    return (await this.client.post<ApiResponse<GitHubPublication>>(`/api/notes/${encodeURIComponent(id)}/github/resolve`,
      { choice, remoteSha, expectedRevision }, { timeout: 120_000 })).data;
  }

  async createNote(input: CreateNoteInput): Promise<ApiResponse<Note>> {
    const r = await this.client.post<ApiResponse<Note>>('/api/notes', input);
    return r.data;
  }

  async deleteNote(id: string): Promise<ApiResponse<void>> {
    const r = await this.client.delete<ApiResponse<void>>(`/api/notes/${id}`);
    return r.data;
  }

  /** Updates a note. `tags` is only sent when given — omitting it leaves the stored tags untouched. */
  async patchNote(id: string, content: string, tags?: string[], projectId?: string | null, expectedRevision?: number, passageTagsSupported = false): Promise<ApiResponse<Note>> {
    const body: Record<string, unknown> = { content, expectedRevision, passageTagsSupported };
    if (tags !== undefined) body['tags'] = tags;
    if (projectId !== undefined) body['projectId'] = projectId;
    const r = await this.client.patch<ApiResponse<Note>>(`/api/notes/${id}`, body);
    return r.data;
  }

  async getNoteHistory(id: string): Promise<ApiResponse<NoteVersionSummary[]>> {
    return (await this.client.get<ApiResponse<NoteVersionSummary[]>>(`/api/notes/${encodeURIComponent(id)}/history`)).data;
  }

  async getNoteVersion(id: string, versionId: string): Promise<ApiResponse<NoteVersion>> {
    return (await this.client.get<ApiResponse<NoteVersion>>(`/api/notes/${encodeURIComponent(id)}/history/${encodeURIComponent(versionId)}`)).data;
  }

  async checkpointNote(id: string, content: string, expectedRevision: number): Promise<ApiResponse<Note>> {
    return (await this.client.post<ApiResponse<Note>>(`/api/notes/${encodeURIComponent(id)}/checkpoint`, { content, expectedRevision })).data;
  }

  async restoreNoteVersion(id: string, versionId: string, expectedRevision: number, content?: string): Promise<ApiResponse<Note>> {
    return (await this.client.post<ApiResponse<Note>>(`/api/notes/${encodeURIComponent(id)}/history/${encodeURIComponent(versionId)}/restore`, { expectedRevision, content })).data;
  }

  // ─── Images (Change 003) ──────────────────────────────────────────────────

  async uploadImage(
    file: File,
    caption?: string,
  ): Promise<ApiResponse<{ id: string; blobUrl: string }>> {
    // Backend expects a raw binary body (express.raw), not multipart/form-data.
    // The response returns as soon as the blob upload completes — OCR/vision
    // analysis run afterwards in the background on the server, so this is
    // fast even though the blob upload itself can still take a moment.
    const buffer = await file.arrayBuffer();
    const r = await this.client.post<
      ApiResponse<{ id: string; blobUrl: string }>
    >('/api/images', buffer, {
      headers: { 'Content-Type': file.type !== '' ? file.type : 'application/octet-stream' },
      params: caption !== undefined && caption !== '' ? { caption } : undefined,
      timeout: IMAGE_UPLOAD_TIMEOUT_MS,
    });
    return r.data;
  }

  /** Analyzes an ephemeral image for Athena without storing it in the image library. */
  async analyzeChatImage(
    file: File,
    question?: string,
    persona?: string,
  ): Promise<ApiResponse<{ analysis: string }>> {
    const buffer = await file.arrayBuffer();
    const r = await this.client.post<ApiResponse<{ analysis: string }>>(
      '/api/images/analyze-chat',
      buffer,
      {
        headers: { 'Content-Type': file.type },
        params: { ...(question?.trim() && { question: question.trim() }), ...(persona !== undefined && { persona }) },
        // Demo Designer's detailed screen read uses the slower reasoning model.
        timeout: persona === 'demo_designer' || persona === 'web_designer' ? 2 * IMAGE_UPLOAD_TIMEOUT_MS : IMAGE_UPLOAD_TIMEOUT_MS,
      },
    );
    return r.data;
  }

  /**
   * Look up stored vision analysis / OCR text for image blobs already embedded
   * in a note or canvas (matched by the blob name in each URL). Used to prime
   * Athena with what a pasted screenshot/diagram actually shows, instead of
   * just its filename.
   */
  async lookupImages(
    blobUrls: string[],
  ): Promise<ApiResponse<{ items: Array<{ id: string; visionAnalysis?: string; ocrText?: string; caption?: string }> }>> {
    // The /api/images mount uses express.raw() for every content-type, so send
    // JSON as a raw buffer rather than relying on axios's default JSON headers.
    const r = await this.client.post<
      ApiResponse<{ items: Array<{ id: string; visionAnalysis?: string; ocrText?: string; caption?: string }> }>
    >('/api/images/lookup', JSON.stringify({ blobUrls }), {
      headers: { 'Content-Type': 'application/json' },
    });
    return r.data;
  }

  // ─── AI Chat ──────────────────────────────────────────────────────────────

  /** Starts a chat turn that runs on the server in the background (see services/chatTurns.ts). */
  async startChatTurn(request: ChatRequest): Promise<ApiResponse<{ turnId: string; sessionId: string }>> {
    const r = await this.client.post<ApiResponse<{ turnId: string; sessionId: string }>>('/api/ai/chat/turns', request);
    return r.data;
  }

  /** Stops a running chat turn (the Stop button). */
  async cancelChatTurn(turnId: string): Promise<void> {
    await this.client.post(`/api/ai/chat/turns/${turnId}/cancel`);
  }

  /** A turn still running for this chat (to reattach to) or one interrupted by a restart. */
  async getSessionTurn(sessionId: string): Promise<ApiResponse<SessionTurnState>> {
    const r = await this.client.get<ApiResponse<SessionTurnState>>(`/api/ai/session/${sessionId}/turn`);
    return r.data;
  }

  async dismissSessionTurn(sessionId: string): Promise<void> {
    await this.client.delete(`/api/ai/session/${sessionId}/turn`);
  }

  // ─── Chat side panel: Outputs and Decisions ─────────────────────────────────

  async listChatOutputs(sessionId: string): Promise<ApiResponse<ChatOutputSummary[]>> {
    const r = await this.client.get<ApiResponse<ChatOutputSummary[]>>(`/api/ai/session/${sessionId}/outputs`);
    return r.data;
  }

  async getChatOutput(outputId: string): Promise<ApiResponse<ChatOutput>> {
    const r = await this.client.get<ApiResponse<ChatOutput>>(`/api/ai/outputs/${outputId}`);
    return r.data;
  }

  /** Saves the user's edit as a new version. */
  async addChatOutputVersion(outputId: string, content: string): Promise<ApiResponse<{ id: string; version: number }>> {
    const r = await this.client.post<ApiResponse<{ id: string; version: number }>>(`/api/ai/outputs/${outputId}/versions`, { content });
    return r.data;
  }

  async renameChatOutput(outputId: string, title: string): Promise<void> {
    await this.client.patch(`/api/ai/outputs/${outputId}`, { title });
  }

  async deleteChatOutput(outputId: string): Promise<void> {
    await this.client.delete(`/api/ai/outputs/${outputId}`);
  }

  async saveChatOutputToThink(outputId: string, version: number): Promise<ApiResponse<{ noteId: string; title: string; url: string }>> {
    const r = await this.client.post<ApiResponse<{ noteId: string; title: string; url: string }>>(`/api/ai/outputs/${outputId}/save-to-think`, { version });
    return r.data;
  }

  async getChatDecisions(sessionId: string): Promise<ApiResponse<{ tracking: DecisionTracking; decisions: ChatDecision[] }>> {
    const r = await this.client.get<ApiResponse<{ tracking: DecisionTracking; decisions: ChatDecision[] }>>(`/api/ai/session/${sessionId}/decisions`);
    return r.data;
  }

  async addChatDecision(sessionId: string, status: ChatDecision['status'], text: string): Promise<void> {
    await this.client.post(`/api/ai/session/${sessionId}/decisions`, { status, text });
  }

  async updateChatDecision(decisionId: string, patch: { status?: ChatDecision['status']; text?: string }): Promise<void> {
    await this.client.patch(`/api/ai/decisions/${decisionId}`, patch);
  }

  async deleteChatDecision(decisionId: string): Promise<void> {
    await this.client.delete(`/api/ai/decisions/${decisionId}`);
  }

  async setDecisionTracking(sessionId: string, enabled: boolean | null): Promise<void> {
    await this.client.put(`/api/ai/session/${sessionId}/decision-tracking`, { enabled });
  }

  async getDecisionSemantics(decisionId: string): Promise<DecisionSemantics> {
    const r = await this.client.get<ApiResponse<DecisionSemantics>>(`/api/semantic/decisions/${encodeURIComponent(decisionId)}/semantics`);
    return requireApiData(r.data);
  }

  async getDecisionLinkCandidates(decisionId: string, kind: 'task' | 'decision', q: string, limit = 10): Promise<DecisionLinkCandidate[]> {
    const r = await this.client.get<ApiResponse<{ items: DecisionLinkCandidate[] }>>(
      `/api/semantic/decisions/${encodeURIComponent(decisionId)}/candidates`, { params: { kind, q, limit } });
    return requireApiData(r.data).items;
  }

  async confirmDecisionAcceptance(decisionId: string): Promise<DecisionSemantics> {
    const r = await this.client.post<ApiResponse<DecisionSemantics>>(`/api/semantic/decisions/${encodeURIComponent(decisionId)}/accept`, { confirmed: true });
    return requireApiData(r.data);
  }

  async setDecisionReviewDate(decisionId: string, reviewDate: string | null): Promise<DecisionSemantics> {
    const r = await this.client.put<ApiResponse<DecisionSemantics>>(`/api/semantic/decisions/${encodeURIComponent(decisionId)}/review-date`, { reviewDate });
    return requireApiData(r.data);
  }

  async recordDecisionLink(decisionId: string, link: DecisionLinkInput): Promise<DecisionSemantics> {
    const r = await this.client.post<ApiResponse<DecisionSemantics>>(`/api/semantic/decisions/${encodeURIComponent(decisionId)}/links`, link);
    return requireApiData(r.data);
  }

  /** Stores a screenshot with a chat and reads it (a detailed read for Demo Designer). */
  async uploadChatScreen(sessionId: string, file: File, persona: string, question?: string): Promise<ApiResponse<{ screen: ChatScreen; reading: string }>> {
    const r = await this.client.post<ApiResponse<{ screen: ChatScreen; reading: string }>>(
      `/api/ai/session/${sessionId}/screens`,
      await file.arrayBuffer(),
      {
        headers: { 'Content-Type': file.type },
        params: { name: file.name.replace(/\.[a-z0-9]+$/i, ''), persona, ...(question?.trim() && { question: question.trim() }) },
        timeout: 2 * IMAGE_UPLOAD_TIMEOUT_MS,
      },
    );
    return r.data;
  }

  async listChatScreens(sessionId: string): Promise<ApiResponse<ChatScreen[]>> {
    const r = await this.client.get<ApiResponse<ChatScreen[]>>(`/api/ai/session/${sessionId}/screens`);
    return r.data;
  }

  /** The screenshot (or its marked-up copy) as a blob, fetched with sign-in. */
  async fetchChatScreenImage(screenId: string, annotated: boolean): Promise<Blob> {
    const r = await this.client.get<Blob>(`/api/ai/screens/${screenId}/image`, {
      params: annotated ? { annotated: 1 } : {}, responseType: 'blob', timeout: IMAGE_UPLOAD_TIMEOUT_MS,
    });
    return r.data;
  }

  async updateChatScreen(screenId: string, patch: { name?: string; inJourney?: boolean }): Promise<void> {
    await this.client.patch(`/api/ai/screens/${screenId}`, patch);
  }

  async reorderChatScreens(sessionId: string, ids: string[]): Promise<void> {
    await this.client.put(`/api/ai/session/${sessionId}/screens/order`, { ids });
  }

  async saveScreenAnnotation(screenId: string, png: Blob, note: string): Promise<void> {
    await this.client.put(`/api/ai/screens/${screenId}/annotation`, png, {
      headers: { 'Content-Type': 'image/png' }, params: { note }, timeout: IMAGE_UPLOAD_TIMEOUT_MS,
    });
  }

  async clearScreenAnnotation(screenId: string): Promise<void> {
    await this.client.delete(`/api/ai/screens/${screenId}/annotation`);
  }

  async deleteChatScreen(screenId: string): Promise<void> {
    await this.client.delete(`/api/ai/screens/${screenId}`);
  }

  // ─── Second opinions: "Ask another model" ──────────────────────────────────

  async listModelChoices(persona?: string): Promise<ApiResponse<ModelChoiceApi[]>> {
    const r = await this.client.get<ApiResponse<ModelChoiceApi[]>>('/api/ai/models', { params: persona !== undefined ? { persona } : undefined });
    return r.data;
  }

  /** Re-answers a reply with another model, in the background; follow it with followChatTurn. */
  async askAnotherModel(sessionId: string, messageId: string, model: string): Promise<ApiResponse<{ turnId: string }>> {
    const r = await this.client.post<ApiResponse<{ turnId: string }>>(`/api/ai/session/${sessionId}/messages/${messageId}/alternates`, { model });
    return r.data;
  }

  async listAlternates(sessionId: string): Promise<ApiResponse<ChatAlternate[]>> {
    const r = await this.client.get<ApiResponse<ChatAlternate[]>>(`/api/ai/session/${sessionId}/alternates`);
    return r.data;
  }

  /** Makes an alternative the answer the chat continues from. */
  async useAlternate(alternateId: string): Promise<ApiResponse<{ messageId: string; content: string }>> {
    const r = await this.client.post<ApiResponse<{ messageId: string; content: string }>>(`/api/ai/alternates/${alternateId}/use`);
    return r.data;
  }

  // ─── "Don't use this" (per chat) ────────────────────────────────────────────

  async listExclusions(sessionId: string): Promise<ApiResponse<UsedSourceApi[]>> {
    const r = await this.client.get<ApiResponse<UsedSourceApi[]>>(`/api/ai/session/${sessionId}/exclusions`);
    return r.data;
  }

  async excludeSource(sessionId: string, source: UsedSourceApi): Promise<ApiResponse<UsedSourceApi[]>> {
    const r = await this.client.post<ApiResponse<UsedSourceApi[]>>(`/api/ai/session/${sessionId}/exclusions`, source);
    return r.data;
  }

  async includeSource(sessionId: string, sourceId: string): Promise<ApiResponse<UsedSourceApi[]>> {
    const r = await this.client.delete<ApiResponse<UsedSourceApi[]>>(`/api/ai/session/${sessionId}/exclusions/${sourceId}`);
    return r.data;
  }

  /** A table (rows of text) as an .xlsx download. */
  async exportXlsx(filename: string, sheets: Array<{ name: string; rows: string[][] }>): Promise<Blob> {
    const r = await this.client.post<Blob>('/api/ai/export/xlsx', { filename, sheets }, { responseType: 'blob', timeout: IMAGE_UPLOAD_TIMEOUT_MS });
    return r.data;
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ApiResponse<ChatResponse>> {
    const r = await this.client.post<ApiResponse<ChatResponse>>(
      '/api/ai/chat',
      request,
      { timeout: CHAT_TIMEOUT_MS, ...(signal && { signal }) },
    );
    return r.data;
  }

  // ─── Voice (Azure Speech, ported from client-demo's voiceRoutes.ts) ────────

  /** Transcribes base64-encoded audio (16kHz mono WAV) via /api/voice/transcribe. */
  async transcribeVoice(
    audioBase64: string,
    mimeType: string,
    language?: string,
    durationMilliseconds?: number,
  ): Promise<ApiResponse<{ text: string; provider: string; durationMilliseconds?: number }>> {
    const r = await this.client.post<ApiResponse<{ text: string; provider: string; durationMilliseconds?: number }>>(
      '/api/voice/transcribe',
      { audioBase64, mimeType, language: language ?? 'en-GB', durationMilliseconds },
      { timeout: CHAT_TIMEOUT_MS },
    );
    return r.data;
  }

  /** Synthesises speech for the given text via /api/voice/synthesize. Returns base64 audio. */
  async synthesizeVoice(
    text: string,
    voice?: string,
    signal?: AbortSignal,
  ): Promise<ApiResponse<{ audioBase64: string; mimeType: string; provider: string }>> {
    const r = await this.client.post<ApiResponse<{ audioBase64: string; mimeType: string; provider: string }>>(
      '/api/voice/synthesize',
      { text, voice },
      { timeout: CHAT_TIMEOUT_MS, ...(signal !== undefined && { signal }) },
    );
    return r.data;
  }

  /** Fetches (and lazily creates) a session's persisted message history, so a reload/reopen can restore it. */
  async getSessionHistory(
    sessionId: string,
  ): Promise<ApiResponse<{ sessionId: string; messages: ChatMessage[]; persona?: AthenaPersona; projectId: string | null }>> {
    const r = await this.client.get<ApiResponse<{ sessionId: string; messages: ChatMessage[]; persona?: AthenaPersona; projectId: string | null }>>(
      `/api/ai/session/${sessionId}/history`,
    );
    return r.data;
  }

  /** Lists past chat sessions for the sidebar, most recently active first — all chats, including Think-note ones. */
  async listChatSessions(): Promise<ApiResponse<{ sessions: ChatSessionSummary[] }>> {
    const r = await this.client.get<ApiResponse<{ sessions: ChatSessionSummary[] }>>('/api/ai/sessions');
    return r.data;
  }

  /** Deletes a chat session and its messages. */
  async deleteChatSession(sessionId: string): Promise<ApiResponse<{ deleted: true }>> {
    const r = await this.client.delete<ApiResponse<{ deleted: true }>>(`/api/ai/session/${sessionId}`);
    return r.data;
  }

  /** All of Athena's memories (instructions, examples, profile, suggestions). */
  async listMemories(): Promise<ApiResponse<{ memories: AthenaMemory[] }>> {
    const r = await this.client.get<ApiResponse<{ memories: AthenaMemory[] }>>('/api/memories');
    return r.data;
  }

  async createMemory(input: { content: string; scopeType: MemoryScopeType; scopeValue?: string | null }): Promise<ApiResponse<AthenaMemory>> {
    const r = await this.client.post<ApiResponse<AthenaMemory>>('/api/memories', input);
    return r.data;
  }

  async updateMemory(id: string, patch: Partial<Pick<AthenaMemory, 'content' | 'scopeType' | 'scopeValue' | 'status'>>): Promise<ApiResponse<AthenaMemory>> {
    const r = await this.client.patch<ApiResponse<AthenaMemory>>(`/api/memories/${id}`, patch);
    return r.data;
  }

  async deleteMemory(id: string): Promise<ApiResponse<{ deleted: true }>> {
    const r = await this.client.delete<ApiResponse<{ deleted: true }>>(`/api/memories/${id}`);
    return r.data;
  }

  /** 👍 saves the reply as an example; 👎 + note returns a suggested instruction. */
  async sendReplyFeedback(input: { sessionId: string | null; rating: 'up' | 'down'; comment?: string; replyContent: string; persona?: string }): Promise<ApiResponse<{ memory: AthenaMemory | null }>> {
    const r = await this.client.post<ApiResponse<{ memory: AthenaMemory | null }>>('/api/memories/feedback', input);
    return r.data;
  }

  /** Renames a chat (locks the title against automatic re-titling). */
  async renameChatSession(sessionId: string, title: string): Promise<ApiResponse<{ sessionId: string; title: string }>> {
    const r = await this.client.patch<ApiResponse<{ sessionId: string; title: string }>>(
      `/api/ai/session/${sessionId}/title`, { title },
    );
    return r.data;
  }

  /** Pins or unpins a chat in the sidebar. */
  async setChatSessionPinned(sessionId: string, pinned: boolean): Promise<ApiResponse<{ sessionId: string; pinned: boolean }>> {
    const r = await this.client.patch<ApiResponse<{ sessionId: string; pinned: boolean }>>(
      `/api/ai/session/${sessionId}/pinned`, { pinned },
    );
    return r.data;
  }

  /** Full-text search across all chat titles and message text; returns matching ids and summaries. */
  async searchChatSessions(query: string, signal?: AbortSignal): Promise<ApiResponse<{ ids: string[]; sessions?: ChatSessionSummary[] }>> {
    const r = await this.client.get<ApiResponse<{ ids: string[]; sessions?: ChatSessionSummary[] }>>('/api/ai/sessions/search', { params: { q: query }, ...(signal && { signal }) });
    return r.data;
  }

  /** Looks up the chat session already linked to a Think note, if any — used by the embedded Athena panel to restore the right conversation when the user switches notes. */
  async getSessionIdForNote(noteId: string): Promise<ApiResponse<{ sessionId: string | null }>> {
    const r = await this.client.get<ApiResponse<{ sessionId: string | null }>>(
      `/api/ai/sessions/note/${encodeURIComponent(noteId)}`,
    );
    return r.data;
  }

  /** Generates an on-demand summary of a note's content, shown when a note has no chat started yet. */
  async summarizeNote(title: string, content: string): Promise<ApiResponse<{ summary: string }>> {
    const r = await this.client.post<ApiResponse<{ summary: string }>>(
      '/api/ai/summarize-note',
      { title, content },
      { timeout: CHAT_TIMEOUT_MS },
    );
    return r.data;
  }

  /** Switches a session's persona (e.g. "general" <-> "brainstorming"). */
  async setSessionPersona(
    sessionId: string,
    persona: AthenaPersona,
  ): Promise<ApiResponse<{ sessionId: string; persona: AthenaPersona }>> {
    const r = await this.client.patch<ApiResponse<{ sessionId: string; persona: AthenaPersona }>>(
      `/api/ai/session/${sessionId}/persona`,
      { persona },
    );
    return r.data;
  }

  /** Assigns or clears the project associated with a chat session. */
  async setSessionProject(
    sessionId: string,
    projectId: string | null,
  ): Promise<ApiResponse<{ sessionId: string; projectId: string | null }>> {
    const r = await this.client.patch<ApiResponse<{ sessionId: string; projectId: string | null }>>(
      `/api/ai/session/${sessionId}/project`,
      { projectId },
    );
    return r.data;
  }

  /** Formats a session's conversation into a note and saves it to Think, returning a deep link. */
  /** A structured first draft of a spec note from the conversation (title + Markdown). */
  async draftSpecFromSession(sessionId: string): Promise<ApiResponse<{ title: string; markdown: string }>> {
    return (await this.client.post<ApiResponse<{ title: string; markdown: string }>>(`/api/ai/session/${sessionId}/spec-draft`, {}, { timeout: 2 * CHAT_TIMEOUT_MS })).data;
  }

  /** Moves the chat in alongside a note: Think shows this conversation for that note. */
  async linkSessionToNote(sessionId: string, noteId: string, title: string): Promise<ApiResponse<{ linkedTasks: number }>> {
    return (await this.client.post<ApiResponse<{ linkedTasks: number }>>(`/api/ai/session/${sessionId}/link-note`, { noteId, title })).data;
  }

  async exportSessionToThink(sessionId: string): Promise<ApiResponse<ExportToThinkResponse>> {
    const r = await this.client.post<ApiResponse<ExportToThinkResponse>>(
      `/api/ai/session/${sessionId}/export-to-think`,
      {},
      { timeout: CHAT_TIMEOUT_MS },
    );
    return r.data;
  }

  async endSession(
    sessionId: string,
  ): Promise<ApiResponse<{ summary: string }>> {
    const r = await this.client.post<ApiResponse<{ summary: string }>>(
      `/api/ai/session/${sessionId}/end`,
    );
    return r.data;
  }

  async confirmAction(
    proposalId: string,
  ): Promise<ApiResponse<WriteActionProposal>> {
    const r = await this.client.post<ApiResponse<WriteActionProposal>>(
      `/api/ai/actions/${proposalId}/confirm`,
    );
    return r.data;
  }

  async cancelAction(
    proposalId: string,
  ): Promise<ApiResponse<WriteActionProposal>> {
    const r = await this.client.post<ApiResponse<WriteActionProposal>>(
      `/api/ai/actions/${proposalId}/cancel`,
    );
    return r.data;
  }

  // ─── Taxonomy ─────────────────────────────────────────────────────────────

  async getTaxonomy(): Promise<ApiResponse<TaxonomyTag[]>> {
    const r = await this.client.get<ApiResponse<TaxonomyTag[]>>('/api/taxonomy');
    return r.data;
  }

  async createTag(input: { name: string; parentId?: string | null; colour?: string | null }): Promise<ApiResponse<TaxonomyTag>> {
    const r = await this.client.post<ApiResponse<TaxonomyTag>>('/api/taxonomy', input);
    return r.data;
  }

  async updateTag(id: string, input: { name?: string; colour?: string | null }): Promise<ApiResponse<{ id: string }>> {
    const r = await this.client.patch<ApiResponse<{ id: string }>>(`/api/taxonomy/${id}`, input);
    return r.data;
  }

  async deleteTag(id: string): Promise<ApiResponse<void>> {
    const r = await this.client.delete<ApiResponse<void>>(`/api/taxonomy/${id}`);
    return r.data;
  }

  async suggestTagSplit(id: string): Promise<ApiResponse<{ suggestions: string[] }>> {
    const r = await this.client.post<ApiResponse<{ suggestions: string[] }>>(`/api/tag-suggestions/${id}/split`, {});
    return r.data;
  }

  async getPendingTags(): Promise<ApiResponse<Array<{ suggestion: string; item_id: string; item_title: string }>>> {
    const r = await this.client.get<ApiResponse<Array<{ suggestion: string; item_id: string; item_title: string }>>>('/api/taxonomy/pending');
    return r.data;
  }

  async dismissPendingTag(suggestion: string): Promise<ApiResponse<void>> {
    const r = await this.client.post<ApiResponse<void>>('/api/taxonomy/pending/dismiss', { suggestion });
    return r.data;
  }

  async getTagSuggestions(all = false): Promise<ApiResponse<PendingSuggestion[]>> {
    const r = await this.client.get<ApiResponse<PendingSuggestion[]>>('/api/tag-suggestions', { params: all ? { all: 1 } : {} });
    return r.data;
  }

  async getTagSuggestionCounts(): Promise<ApiResponse<{ strong: number; weak: number }>> {
    const r = await this.client.get<ApiResponse<{ strong: number; weak: number }>>('/api/tag-suggestions/counts');
    return r.data;
  }

  async acceptTagSuggestion(id: string, parentId: string | null): Promise<ApiResponse<void>> {
    const r = await this.client.post<ApiResponse<void>>(`/api/tag-suggestions/${id}/accept`, { parentId });
    return r.data;
  }

  async rejectTagSuggestion(id: string): Promise<ApiResponse<void>> {
    const r = await this.client.post<ApiResponse<void>>(`/api/tag-suggestions/${id}/reject`, {});
    return r.data;
  }

  async rejectAllTagSuggestions(): Promise<ApiResponse<{ rejected: number }>> {
    const r = await this.client.post<ApiResponse<{ rejected: number }>>('/api/tag-suggestions/reject-all', {});
    return r.data;
  }

  async mergeTagSuggestion(id: string, mergeToId: string): Promise<ApiResponse<void>> {
    const r = await this.client.post<ApiResponse<void>>(`/api/tag-suggestions/${id}/merge`, { mergeToId });
    return r.data;
  }

  async getHealthReport(): Promise<ApiResponse<{ content: string; generatedAt: string | null }>> {
    const r = await this.client.get<ApiResponse<{ content: string; generatedAt: string | null }>>('/api/tag-suggestions/health');
    return r.data;
  }

  async triggerRetag(all = false): Promise<ApiResponse<{ queued: number; message: string }>> {
    const r = await this.client.post<ApiResponse<{ queued: number; message: string }>>(
      `/api/taxonomy/retag${all ? '?all=true' : ''}`,
      {},
    );
    return r.data;
  }

  async getRetagStatus(): Promise<ApiResponse<{ done: number; total: number; running: boolean; completedAt: string | null }>> {
    const r = await this.client.get<ApiResponse<{ done: number; total: number; running: boolean; completedAt: string | null }>>('/api/taxonomy/retag/status');
    return r.data;
  }

  async triggerDocRetag(extraRepos: string[] = []): Promise<ApiResponse<{ queued: number; message: string }>> {
    const r = await this.client.post<ApiResponse<{ queued: number; message: string }>>('/api/documents/retag', { repos: extraRepos });
    return r.data;
  }

  async getDocRetagStatus(): Promise<ApiResponse<{ done: number; total: number; running: boolean; completedAt: string | null }>> {
    const r = await this.client.get<ApiResponse<{ done: number; total: number; running: boolean; completedAt: string | null }>>('/api/documents/retag/status');
    return r.data;
  }

  async getNoteTags(noteId: string): Promise<ApiResponse<TaxonomyTag[]>> {
    const r = await this.client.get<ApiResponse<TaxonomyTag[]>>(`/api/notes/${noteId}/tags`);
    return r.data;
  }

  async retagNote(noteId: string): Promise<ApiResponse<{ applied: number; skipped?: string }>> {
    const r = await this.client.post<ApiResponse<{ applied: number; skipped?: string }>>(`/api/notes/${noteId}/tags/retag`, {});
    return r.data;
  }

  async setNoteTags(noteId: string, tagIds: string[]): Promise<ApiResponse<unknown>> {
    const r = await this.client.put<ApiResponse<unknown>>(`/api/notes/${noteId}/tags`, { tagIds });
    return r.data;
  }

  // ─── Tasks ────────────────────────────────────────────────────────────────

  async getTasks(params?: { status?: string; projectId?: string }): Promise<ApiResponse<PaginatedList<PlanTask>>> {
    const r = await this.client.get<ApiResponse<PaginatedList<PlanTask>>>('/api/tasks', { params });
    if (r.data.success && Array.isArray(r.data.data?.items)) {
      return { ...r.data, data: { ...r.data.data, items: r.data.data.items.map(normaliseTask) } };
    }
    return r.data;
  }

  async createTask(input: CreateTaskInput): Promise<ApiResponse<PlanTask>> {
    const r = await this.client.post<ApiResponse<PlanTask>>('/api/tasks', input);
    return r.data;
  }

  async updateTask(id: string, input: Record<string, unknown>): Promise<ApiResponse<PlanTask>> {
    const r = await this.client.patch<ApiResponse<PlanTask>>(`/api/tasks/${id}`, input);
    return r.data.success && r.data.data ? { ...r.data, data: normaliseTask(r.data.data) } : r.data;
  }

  async reviewPlan(today: string): Promise<ApiResponse<PlanReview>> {
    const r = await this.client.post<ApiResponse<PlanReview>>('/api/tasks/review', { today }, { timeout: CHAT_TIMEOUT_MS });
    return r.data;
  }

  async getAtRiskTasks(): Promise<ApiResponse<AtRiskTask[]>> {
    const r = await this.client.get<ApiResponse<AtRiskTask[]>>('/api/tasks/at-risk');
    return r.data;
  }

  async getDayCheckin(): Promise<ApiResponse<DayCheckin>> {
    const r = await this.client.get<ApiResponse<DayCheckin>>('/api/tasks/checkin');
    return r.data;
  }

  async saveDayCheckin(today: string, status: 'completed' | 'skipped', settled: Array<{ taskId: string; action: CheckinAction }> = []): Promise<ApiResponse<{ day: string; status: string }>> {
    const r = await this.client.post<ApiResponse<{ day: string; status: string }>>('/api/tasks/checkin', { today, status, settled });
    return r.data;
  }

  /** Removes a task from Plan without deleting it (used to dismiss Inbox suggestions). */
  async archiveTask(id: string): Promise<ApiResponse<unknown>> {
    const r = await this.client.post<ApiResponse<unknown>>(`/api/tasks/${id}/archive`);
    return r.data;
  }

  async deleteTask(id: string): Promise<ApiResponse<unknown>> {
    const r = await this.client.delete<ApiResponse<unknown>>(`/api/tasks/${id}`);
    return r.data;
  }

  async getTaskNotes(taskId: string): Promise<ApiResponse<unknown>> {
    const r = await this.client.get<ApiResponse<unknown>>(`/api/tasks/${taskId}/notes`);
    return r.data;
  }

  async addTaskNote(taskId: string, body: string): Promise<ApiResponse<unknown>> {
    const r = await this.client.post<ApiResponse<unknown>>(`/api/tasks/${taskId}/notes`, { body });
    return r.data;
  }

  async getTaskLinks(taskId: string): Promise<ApiResponse<unknown>> {
    const r = await this.client.get<ApiResponse<unknown>>(`/api/tasks/${taskId}/links`);
    return r.data;
  }

  async addTaskLink(taskId: string, link: { targetType: string; targetId: string; targetTitle: string; targetUrl?: string }): Promise<ApiResponse<unknown>> {
    const r = await this.client.post<ApiResponse<unknown>>(`/api/tasks/${taskId}/links`, link);
    return r.data;
  }

  async removeTaskLink(taskId: string, linkId: string): Promise<ApiResponse<unknown>> {
    const r = await this.client.delete<ApiResponse<unknown>>(`/api/tasks/${taskId}/links/${linkId}`);
    return r.data;
  }

  async importTasks(content: string, type: string): Promise<ApiResponse<unknown>> {
    const r = await this.client.post<ApiResponse<unknown>>('/api/tasks/import', { content, type });
    return r.data;
  }

  // ─── Projects ─────────────────────────────────────────────────────────────

  async getProjects(): Promise<ApiResponse<Project[]>> {
    const r = await this.client.get<ApiResponse<Project[]>>('/api/projects');
    return r.data;
  }

  async getProjectGroups(): Promise<ApiResponse<{ id: string; name: string }[]>> {
    const r = await this.client.get<ApiResponse<{ id: string; name: string }[]>>('/api/projects/groups');
    return r.data;
  }

  async createProject(input: Omit<Project, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<ApiResponse<Project>> {
    const r = await this.client.post<ApiResponse<Project>>('/api/projects', input);
    return r.data;
  }

  async updateProject(id: string, input: Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ApiResponse<Project>> {
    const r = await this.client.patch<ApiResponse<Project>>(`/api/projects/${id}`, input);
    return r.data;
  }

  async deleteProject(id: string): Promise<ApiResponse<void>> {
    const r = await this.client.delete<ApiResponse<void>>(`/api/projects/${id}`);
    return r.data;
  }

  async getProjectCockpit(id: string): Promise<ApiResponse<ProjectCockpit>> {
    const r = await this.client.get<ApiResponse<ProjectCockpit>>(`/api/projects/${encodeURIComponent(id)}/cockpit`);
    return r.data;
  }

  async getProjectRegister(id: string, params: { status?: string; kind?: string; limit?: number; offset?: number }): Promise<ApiResponse<ProjectRegisterPage>> {
    const r = await this.client.get<ApiResponse<ProjectRegisterPage>>(`/api/projects/${encodeURIComponent(id)}/register`, { params });
    return r.data;
  }

  async createProjectRegisterItem(id: string, input: ProjectRegisterInput): Promise<ApiResponse<ProjectRegisterItem>> {
    const r = await this.client.post<ApiResponse<ProjectRegisterItem>>(`/api/projects/${encodeURIComponent(id)}/register`, input);
    return r.data;
  }

  async updateProjectRegisterItem(id: string, itemId: string, input: ProjectRegisterInput): Promise<ApiResponse<ProjectRegisterItem>> {
    const r = await this.client.patch<ApiResponse<ProjectRegisterItem>>(`/api/projects/${encodeURIComponent(id)}/register/${encodeURIComponent(itemId)}`, input);
    return r.data;
  }

  async deleteProjectRegisterItem(id: string, itemId: string): Promise<void> {
    await this.client.delete(`/api/projects/${encodeURIComponent(id)}/register/${encodeURIComponent(itemId)}`);
  }

  async promoteProjectDecision(id: string, decisionId: string, kind: ProjectRegisterKind): Promise<ApiResponse<{ item: ProjectRegisterItem; created: boolean }>> {
    const r = await this.client.post<ApiResponse<{ item: ProjectRegisterItem; created: boolean }>>(`/api/projects/${encodeURIComponent(id)}/register/promote`, { decisionId, kind });
    return r.data;
  }

  // ─── Review packets ───────────────────────────────────────────────────────

  async getPacketCandidates(id: string): Promise<ApiResponse<{ items: PacketCandidate[]; limitPerType: number }>> {
    const r = await this.client.get<ApiResponse<{ items: PacketCandidate[]; limitPerType: number }>>(`/api/projects/${encodeURIComponent(id)}/packet-candidates`);
    return r.data;
  }

  async getReviewPackets(id: string): Promise<ApiResponse<ReviewPacketSummary[]>> {
    const r = await this.client.get<ApiResponse<ReviewPacketSummary[]>>(`/api/projects/${encodeURIComponent(id)}/packets`);
    return r.data;
  }

  async getReviewPacket(id: string, packetId: string): Promise<ApiResponse<ReviewPacket>> {
    const r = await this.client.get<ApiResponse<ReviewPacket>>(`/api/projects/${encodeURIComponent(id)}/packets/${encodeURIComponent(packetId)}`);
    return r.data;
  }

  async createReviewPacket(id: string, input: { title: string; items: Array<{ sourceType: PacketSourceType; sourceId: string }> }): Promise<ApiResponse<ReviewPacket>> {
    const r = await this.client.post<ApiResponse<ReviewPacket>>(`/api/projects/${encodeURIComponent(id)}/packets`, input);
    return r.data;
  }

  async setReviewPacketItemChecked(id: string, packetId: string, position: number, checked: boolean): Promise<ApiResponse<ReviewPacket>> {
    const r = await this.client.patch<ApiResponse<ReviewPacket>>(`/api/projects/${encodeURIComponent(id)}/packets/${encodeURIComponent(packetId)}/items/${position}`, { checked });
    return r.data;
  }

  async approveReviewPacket(id: string, packetId: string, acknowledgeStale: boolean): Promise<ApiResponse<ReviewPacket>> {
    const r = await this.client.post<ApiResponse<ReviewPacket>>(`/api/projects/${encodeURIComponent(id)}/packets/${encodeURIComponent(packetId)}/approve`, { acknowledgeStale });
    return r.data;
  }

  async exportReviewPacket(id: string, packetId: string): Promise<ApiResponse<{ filename: string; markdown: string }>> {
    const r = await this.client.get<ApiResponse<{ filename: string; markdown: string }>>(`/api/projects/${encodeURIComponent(id)}/packets/${encodeURIComponent(packetId)}/export`);
    return r.data;
  }

  async deleteReviewPacket(id: string, packetId: string): Promise<void> {
    await this.client.delete(`/api/projects/${encodeURIComponent(id)}/packets/${encodeURIComponent(packetId)}`);
  }

  // ─── Repo-Tag Mappings ────────────────────────────────────────────────────

  async getRepoMappings(): Promise<ApiResponse<RepoTagMapping[]>> {
    const r = await this.client.get<ApiResponse<RepoTagMapping[]>>('/api/repo-mappings');
    return r.data;
  }

  async createRepoMapping(input: { tagId: string; githubRepos: string[]; gitlabPaths: string[] }): Promise<ApiResponse<RepoTagMapping>> {
    const r = await this.client.post<ApiResponse<RepoTagMapping>>('/api/repo-mappings', input);
    return r.data;
  }

  async updateRepoMapping(id: string, input: { tagId?: string; githubRepos?: string[]; gitlabPaths?: string[] }): Promise<ApiResponse<RepoTagMapping>> {
    const r = await this.client.patch<ApiResponse<RepoTagMapping>>(`/api/repo-mappings/${id}`, input);
    return r.data;
  }

  async deleteRepoMapping(id: string): Promise<ApiResponse<void>> {
    const r = await this.client.delete<ApiResponse<void>>(`/api/repo-mappings/${id}`);
    return r.data;
  }

  // ─── Tags (Change 007) ────────────────────────────────────────────────────

  async getTags(q?: string): Promise<ApiResponse<string[]>> {
    const r = await this.client.get<ApiResponse<string[]>>('/api/tags', { params: q ? { q } : {} });
    return r.data;
  }

  // ─── IBM Calendar manual import (Change 004) ──────────────────────────────

  async importIbmCalendar(events: unknown[]): Promise<ApiResponse<{ imported: number }>> {
    const r = await this.client.post<ApiResponse<{ imported: number }>>(
      '/api/capture/ibm-calendar',
      { events },
    );
    return r.data;
  }

  // ─── Documents library ───────────────────────────────────────────────────

  async getDocumentLibrary(
    extraRepos: string[] = [],
    repoLabels: Record<string, string> = {},
  ): Promise<ApiResponse<DocEntry[]>> {    const params: Record<string, unknown> = {};
    if (extraRepos.length > 0) params['repos'] = extraRepos;
    if (Object.keys(repoLabels).length > 0) params['repoLabels'] = JSON.stringify(repoLabels);
    const r = await this.client.get<ApiResponse<DocEntry[]>>('/api/documents/library', { params });
    return r.data;
  }

  /** OneDrive (IBM Alliance tenant) connection + sync status. */
  async getAllianceStatus(): Promise<ApiResponse<AllianceStatus>> {
    const r = await this.client.get<ApiResponse<AllianceStatus>>('/api/integrations/alliance/status');
    return r.data;
  }

  /** Starts a OneDrive sync in the background. */
  async syncOneDrive(): Promise<ApiResponse<{ started: boolean }>> {
    const r = await this.client.post<ApiResponse<{ started: boolean }>>('/api/integrations/alliance/sync');
    return r.data;
  }

  async getDocumentContent(repo: string, path: string): Promise<ApiResponse<DocumentContent>> {
    const r = await this.client.get<ApiResponse<DocumentContent>>('/api/documents/content', { params: { repo, path } });
    return r.data;
  }

  async setDocumentTags(docId: string, tagIds: string[]): Promise<ApiResponse<string[]>> {
    const r = await this.client.put<ApiResponse<string[]>>('/api/documents/tags', { docId, tagIds });
    return r.data;
  }

  /**
   * Uploads a Word/Excel/PowerPoint/PDF/Markdown/text file: extracts plain
   * text, stores the original file in Azure Blob Storage, and persists it as
   * a searchable `user-upload` content item (visible in the Documents
   * library). Returns the extracted text too, so the caller can inject it as
   * immediate chat context without a second round trip.
   */
  async uploadDocument(
    file: File,
    projectId = 'personal',
    title?: string,
    projectName?: string,
    onProgress?: (percent: number) => void,
    /** Chat to link a spreadsheet to (for the calculator). */
    chatSessionId?: string,
  ): Promise<ApiResponse<{ contentItemId: string; filename: string; text: string; truncated: boolean; blobUrl: string; projectId: string; projectName: string }>> {
    const formData = new FormData();
    formData.append('file', file);
    if (chatSessionId !== undefined) formData.append('sessionId', chatSessionId);
    formData.append('projectId', projectId);
    if (projectName !== undefined && projectName.trim() !== '') formData.append('projectName', projectName.trim());
    if (title !== undefined && title.trim() !== '') formData.append('title', title.trim());
    const r = await this.client.post<
      ApiResponse<{ contentItemId: string; filename: string; text: string; truncated: boolean; blobUrl: string; projectId: string; projectName: string }>
    >('/api/documents/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: IMAGE_UPLOAD_TIMEOUT_MS,
      onUploadProgress: (evt) => {
        if (!onProgress || !evt.total) return;
        onProgress(Math.round((evt.loaded / evt.total) * 100));
      },
    });
    return r.data;
  }

  // ─── Athena Desktop: local folders ───────────────────────────────────────

  /** What has been indexed from one PC's folders. */
  async getLocalIndex(deviceId: string): Promise<ApiResponse<LocalIndexEntry[]>> {
    return (await this.client.get<ApiResponse<LocalIndexEntry[]>>('/api/documents/local-index', { params: { deviceId } })).data;
  }

  async captureDailyInsights(input: { filename: string; text: string; sourcePath: string; sourceModifiedAt: string }): Promise<ApiResponse<{
    date: string; knowledgeDate: string; tasksCreated: number; tasksUpdated: number;
    tasksPreserved: number; meetings: number; warnings: string[]; unchanged: boolean;
  }>> {
    return (await this.client.post<ApiResponse<{
      date: string; knowledgeDate: string; tasksCreated: number; tasksUpdated: number;
      tasksPreserved: number; meetings: number; warnings: string[]; unchanged: boolean;
    }>>('/api/capture/daily-insights', input, { timeout: DAILY_INSIGHTS_TIMEOUT_MS })).data;
  }

  /** Indexes (or re-indexes) one file from a folder on this PC; unchanged files are skipped by the server. */
  async uploadLocalDocument(
    file: File,
    local: { localKey: string; localPath: string; localHash: string; deviceName: string },
  ): Promise<ApiResponse<{ contentItemId: string; filename: string; unchanged?: true }>> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('projectId', 'personal');
    formData.append('localKey', local.localKey);
    formData.append('localPath', local.localPath);
    formData.append('localHash', local.localHash);
    formData.append('deviceName', local.deviceName);
    return (await this.client.post<ApiResponse<{ contentItemId: string; filename: string; unchanged?: true }>>(
      '/api/documents/upload', formData,
      { headers: { 'Content-Type': 'multipart/form-data' }, timeout: IMAGE_UPLOAD_TIMEOUT_MS },
    )).data;
  }

  /** Removes indexed copies of files deleted on the PC or in folders no longer used. */
  async removeLocalDocuments(localKeys: string[]): Promise<ApiResponse<{ removed: number }>> {
    return (await this.client.post<ApiResponse<{ removed: number }>>('/api/documents/local-index/remove', { localKeys })).data;
  }

  // ─── Discover ─────────────────────────────────────────────────────────────
  async getWatchlists(): Promise<ApiResponse<Watchlist[]>> {
    return (await this.client.get<ApiResponse<Watchlist[]>>('/api/discover/watchlists')).data;
  }
  async saveWatchlist(config: WatchlistInput, existing?: { id: string; revision: number }): Promise<ApiResponse<Watchlist>> {
    return existing
      ? (await this.client.put<ApiResponse<Watchlist>>(`/api/discover/watchlists/${existing.id}`, { ...config, revision: existing.revision })).data
      : (await this.client.post<ApiResponse<Watchlist>>('/api/discover/watchlists', config)).data;
  }
  async getWatchlistRuns(id: string, page = 1): Promise<ApiResponse<WatchRun[]>> {
    return (await this.client.get<ApiResponse<WatchRun[]>>(`/api/discover/watchlists/${id}/runs`, { params: { page } })).data;
  }
  async getWatchlistBaselines(id: string): Promise<ApiResponse<WatchBaselineVersion[]>> {
    return (await this.client.get<ApiResponse<WatchBaselineVersion[]>>(`/api/discover/watchlists/${id}/baselines`)).data;
  }
  async getWatchlistCompanies(id: string): Promise<ApiResponse<WatchCompanyKnowledge[]>> {
    return (await this.client.get<ApiResponse<WatchCompanyKnowledge[]>>(`/api/discover/watchlists/${id}/companies`)).data;
  }
  async runWatchlist(id: string): Promise<ApiResponse<WatchRun>> {
    return (await this.client.post<ApiResponse<WatchRun>>(`/api/discover/watchlists/${id}/run`, {}, { timeout: 2 * CHAT_TIMEOUT_MS })).data;
  }
  async getDiscoverInterests(): Promise<ApiResponse<InterestWeight[]>> {
    return (await this.client.get<ApiResponse<InterestWeight[]>>('/api/discover/interests')).data;
  }
  async saveDiscoverInterest(weight: InterestWeight): Promise<ApiResponse<InterestWeight[]>> {
    return (await this.client.put<ApiResponse<InterestWeight[]>>('/api/discover/interests', weight)).data;
  }
  async getFilteredDiscover(page = 1): Promise<ApiResponse<{ items: DiscoverItem[]; total: number }>> {
    return (await this.client.get<ApiResponse<{ items: DiscoverItem[]; total: number }>>('/api/discover', { params: { filtered: true, pageSize: 100, page } })).data;
  }

  async createLinkedInDraft(id: string, format: 'linkedin' | 'short' = 'linkedin'): Promise<ApiResponse<SocialDraft>> {
    return (await this.client.post<ApiResponse<SocialDraft>>(
      `/api/discover/${id}/linkedin-draft`,
      { format },
      { timeout: CHAT_TIMEOUT_MS },
    )).data;
  }

  /** Publishes the reviewed short post and original link to Bluesky; the article moves to Published. */
  async postDiscoverToBluesky(id: string, post: string): Promise<ApiResponse<{ uri: string; url: string }>> {
    return (await this.client.post<ApiResponse<{ uri: string; url: string }>>(`/api/discover/${id}/bluesky-post`, { post }, { timeout: CHAT_TIMEOUT_MS })).data;
  }

  async getLinkedInAccount(): Promise<ApiResponse<{ id: string; name: string }>> {
    return (await this.client.get<ApiResponse<{ id: string; name: string }>>('/api/discover/linkedin-account')).data;
  }

  async postDiscoverToLinkedIn(id: string, post: string, memberId: string): Promise<ApiResponse<{ urn: string; url: string; warning?: string }>> {
    return (await this.client.post<ApiResponse<{ urn: string; url: string; warning?: string }>>(
      `/api/discover/${id}/linkedin-post`, { post, memberId, confirmed: true }, { timeout: CHAT_TIMEOUT_MS },
    )).data;
  }

  async listNoteExtractions(noteId: string): Promise<ApiResponse<NoteExtraction[]>> {
    return (await this.client.get<ApiResponse<NoteExtraction[]>>(`/api/notes/${noteId}/extractions`)).data;
  }

  async addNoteExtraction(noteId: string, input: Pick<NoteExtraction, 'quote' | 'action'> & Partial<Pick<NoteExtraction, 'targetType' | 'targetId' | 'targetLabel'>>): Promise<ApiResponse<NoteExtraction>> {
    return (await this.client.post<ApiResponse<NoteExtraction>>(`/api/notes/${noteId}/extractions`, input)).data;
  }

  async deleteNoteExtraction(noteId: string, extractionId: string): Promise<ApiResponse<void>> {
    return (await this.client.delete<ApiResponse<void>>(`/api/notes/${noteId}/extractions/${extractionId}`)).data;
  }

  async createBlogDraft(id: string, length: 'short' | 'long'): Promise<ApiResponse<AgentHandOffResult>> {
    return (await this.client.post<ApiResponse<AgentHandOffResult>>(`/api/discover/${id}/blog-draft`, { length })).data;
  }

  async getBlogCategories(): Promise<ApiResponse<string[]>> {
    return (await this.client.get<ApiResponse<string[]>>('/api/discover/blog-categories')).data;
  }

  async publishBlogPost(id: string, post: Omit<BlogDraft, 'sourceUrl'> & { status: 'draft' | 'published'; jobId: string }): Promise<ApiResponse<{ editUrl: string | null; url: string | null; status: 'draft' | 'published' }>> {
    return (await this.client.post<ApiResponse<{ editUrl: string | null; url: string | null; status: 'draft' | 'published' }>>(`/api/discover/${id}/blog-publish`, post, { timeout: CHAT_TIMEOUT_MS })).data;
  }

  async getDiscoverFeed(
    state: DiscoverWorkflowState = 'to-review',
    source?: string,
    page = 1,
    pageSize = 50,
    title?: string,
    sort: DiscoverSort = 'weighted',
    format?: DiscoverFormat,
  ): Promise<ApiResponse<{ items: DiscoverItem[]; total: number; page: number; pageSize: number }>> {
    const r = await this.client.get<ApiResponse<{ items: DiscoverItem[]; total: number; page: number; pageSize: number }>>(
      '/api/discover',
      { params: { state, source, page, pageSize, title, sort, format } },
    );
    return r.data;
  }

  async getDiscoverSources(state?: string): Promise<ApiResponse<Array<{ title: string; count: number }>>> {
    const r = await this.client.get<ApiResponse<Array<{ title: string; count: number }>>>('/api/discover/sources', {
      params: state ? { state } : undefined,
    });
    return r.data;
  }

  async getDiscoverParkingLot(page = 1, pageSize = 25): Promise<ApiResponse<{ items: DiscoverItem[]; total: number; page: number; pageSize: number }>> {
    return (await this.client.get<ApiResponse<{ items: DiscoverItem[]; total: number; page: number; pageSize: number }>>(
      '/api/discover/parking-lot', { params: { page, pageSize } },
    )).data;
  }

  async getDiscoverParking(id: string): Promise<ApiResponse<DiscoverParking | null>> {
    return (await this.client.get<ApiResponse<DiscoverParking | null>>(`/api/discover/${id}/parking`)).data;
  }

  async saveDiscoverParking(id: string, selection: ParkingSelection): Promise<ApiResponse<DiscoverParking>> {
    return (await this.client.put<ApiResponse<DiscoverParking>>(`/api/discover/${id}/parking`, selection)).data;
  }

  async removeDiscoverParking(id: string): Promise<ApiResponse<null>> {
    return (await this.client.delete<ApiResponse<null>>(`/api/discover/${id}/parking`)).data;
  }

  async listDiscoveryFeeds(): Promise<ApiResponse<DiscoveryFeed[]>> {
    return (await this.client.get<ApiResponse<DiscoveryFeed[]>>('/api/discover/feeds')).data;
  }

  async addDiscoveryVideo(url: string): Promise<ApiResponse<{ id: string; title: string; isNew: boolean }>> {
    try {
      return (await this.client.post<ApiResponse<{ id: string; title: string; isNew: boolean }>>('/api/discover/videos', { url }, { timeout: 60_000 })).data;
    } catch (err) {
      const body = (err as { response?: { data?: ApiResponse<never> } }).response?.data;
      if (body !== undefined) return body;
      throw err;
    }
  }

  /** Adds a feed; the server checks the address first and says if it isn't a working feed. */
  async addDiscoveryFeed(feed: { title: string; feedUrl: string; groupName: string }): Promise<ApiResponse<DiscoveryFeed & { itemsInFeed: number }>> {
    try {
      return (await this.client.post<ApiResponse<DiscoveryFeed & { itemsInFeed: number }>>('/api/discover/feeds', feed, { timeout: 60_000 })).data;
    } catch (err) {
      const body = (err as { response?: { data?: ApiResponse<never> } }).response?.data;
      if (body !== undefined) return body;
      throw err;
    }
  }

  async updateDiscoveryFeed(id: string, patch: { isActive?: boolean; title?: string; groupName?: string }): Promise<ApiResponse<DiscoveryFeed>> {
    return (await this.client.patch<ApiResponse<DiscoveryFeed>>(`/api/discover/feeds/${id}`, patch)).data;
  }

  async deleteDiscoveryFeed(id: string): Promise<ApiResponse<unknown>> {
    return (await this.client.delete<ApiResponse<unknown>>(`/api/discover/feeds/${id}`)).data;
  }

  async checkDiscoveryFeeds(): Promise<ApiResponse<{ started: boolean }>> {
    return (await this.client.post<ApiResponse<{ started: boolean }>>('/api/discover/feeds/check')).data;
  }

  async updateDiscoverWorkflow(id: string, state: DiscoverWorkflowState): Promise<ApiResponse<unknown>> {
    const r = await this.client.patch<ApiResponse<unknown>>(`/api/discover/${id}/workflow`, { state });
    return r.data;
  }

  async setDiscoverFeedback(id: string, vote: DiscoverFeedbackVote): Promise<ApiResponse<{ feedbackVote: DiscoverFeedbackVote; workflowState: DiscoverWorkflowState }>> {
    const r = await this.client.put<ApiResponse<{ feedbackVote: DiscoverFeedbackVote; workflowState: DiscoverWorkflowState }>>(`/api/discover/${id}/feedback`, { vote });
    return r.data;
  }

  async updateDiscoverPublishedUrl(id: string, publishedUrl: string | null): Promise<ApiResponse<unknown>> {
    const r = await this.client.patch<ApiResponse<unknown>>(`/api/discover/${id}/published-url`, { publishedUrl });
    return r.data;
  }

  // ─── CFPs ─────────────────────────────────────────────────────────────────

  async getCfpItems(
    workflowState: CfpWorkflowState = 'to_review',
    limit = 50,
    offset = 0,
  ): Promise<ApiResponse<CfpItem[]>> {
    const r = await this.client.get<ApiResponse<CfpItem[]>>('/api/cfps', {
      params: { workflow_state: workflowState, limit, offset },
    });
    return r.data;
  }

  async updateCfpState(id: string, state: CfpWorkflowState): Promise<ApiResponse<unknown>> {
    const r = await this.client.put<ApiResponse<unknown>>(`/api/cfps/${id}/state`, { state });
    return r.data;
  }

  async triggerCfpSync(): Promise<ApiResponse<{ indexed: number; errors: number }>> {
    const r = await this.client.post<ApiResponse<{ indexed: number; errors: number }>>('/api/cfps/sync');
    return r.data;
  }

  // ─── Sparks ──────────────────────────────────────────────────────────────

  async createArticleSpark(sourceId: string, tags: string[] = []): Promise<ApiResponse<Spark>> {
    return (await this.client.post<ApiResponse<Spark>>('/api/sparks/from-article',
      { source_id: sourceId, tags }, { timeout: CHAT_TIMEOUT_MS })).data;
  }

  async createSpark(input: {
    body: string;
    tags?: string[];
    source_id?: string | null;
    source_type?: string | null;
  }): Promise<ApiResponse<Spark>> {
    const r = await this.client.post<ApiResponse<Spark>>('/api/sparks', input);
    return r.data;
  }

  async listSparks(params?: {
    id?: string;
    source_id?: string;
    source_type?: string;
    cluster_id?: string;
    attached?: boolean;
    clustered?: boolean;
    q?: string;
    limit?: number;
    offset?: number;
  }): Promise<ApiResponse<Spark[]>> {
    const r = await this.client.get<ApiResponse<Spark[]>>('/api/sparks', { params });
    return r.data;
  }

  /** Edits a spark: body text, theme (null = loose), or what it was used in (null = clear). */
  async updateSpark(id: string, patch: { body?: string; cluster_id?: string | null; used?: SparkOutput | null }): Promise<ApiResponse<Spark>> {
    return (await this.client.patch<ApiResponse<Spark>>(`/api/sparks/${id}`, patch)).data;
  }

  /** Sparks captured from, or connected to, a note / article. */
  async listRelatedSparks(refId: string, refType: string): Promise<ApiResponse<Array<Spark & { relation: 'captured' | 'connected' }>>> {
    return (await this.client.get<ApiResponse<Array<Spark & { relation: 'captured' | 'connected' }>>>('/api/sparks/related', { params: { ref_id: refId, ref_type: refType } })).data;
  }

  async deleteSpark(id: string): Promise<ApiResponse<unknown>> {
    const r = await this.client.delete<ApiResponse<unknown>>(`/api/sparks/${id}`);
    return r.data;
  }

  // ─── Spark clusters ───────────────────────────────────────────────────────

  /** Lists themes with their sparks. `status` is comma separated (active,developed,dismissed). */
  async listSparkClusters(params?: {
    status?: string;
    surfaced?: boolean;
    dismissed?: boolean;
  }): Promise<ApiResponse<SparkCluster[]>> {
    const r = await this.client.get<ApiResponse<SparkCluster[]>>('/api/spark-clusters', { params });
    return r.data;
  }

  async updateSparkCluster(id: string, patch: {
    theme?: string;
    status?: SparkThemeStatus;
    dismissed?: boolean;
    surfaced?: boolean;
    output?: SparkOutput | null;
    markSparksUsed?: boolean;
  }): Promise<ApiResponse<SparkCluster>> {
    const r = await this.client.patch<ApiResponse<SparkCluster>>(`/api/spark-clusters/${id}`, patch);
    return r.data;
  }

  async createSparkTheme(theme: string, sparkIds: string[]): Promise<ApiResponse<SparkCluster>> {
    return (await this.client.post<ApiResponse<SparkCluster>>('/api/spark-clusters', { theme, sparkIds })).data;
  }

  async mergeSparkThemes(fromId: string, intoId: string): Promise<ApiResponse<SparkCluster>> {
    return (await this.client.post<ApiResponse<SparkCluster>>(`/api/spark-clusters/${fromId}/merge`, { intoId })).data;
  }

  /** Turns a theme into a structured note, a canvas or a project and records what it became. */
  async graduateSparkTheme(id: string, target: 'note' | 'canvas' | 'project' | 'tasks'): Promise<ApiResponse<{ theme: SparkCluster; output: SparkOutput }>> {
    return (await this.client.post<ApiResponse<{ theme: SparkCluster; output: SparkOutput }>>(`/api/spark-clusters/${id}/graduate`, { target }, { timeout: CHAT_TIMEOUT_MS })).data;
  }

  async createSparkThemeBlogDraft(id: string, length: 'short' | 'long'): Promise<ApiResponse<AgentHandOffResult>> {
    return (await this.client.post<ApiResponse<AgentHandOffResult>>(`/api/spark-clusters/${id}/blog-draft`, { length })).data;
  }

  async publishSparkThemeBlogPost(id: string, post: Omit<BlogDraft, 'sourceUrl'> & { status: 'draft' | 'published'; jobId: string }): Promise<ApiResponse<{ editUrl: string | null; url: string | null; status: 'draft' | 'published' }>> {
    return (await this.client.post<ApiResponse<{ editUrl: string | null; url: string | null; status: 'draft' | 'published' }>>(`/api/spark-clusters/${id}/blog-publish`, post, { timeout: CHAT_TIMEOUT_MS })).data;
  }

  /** Returns count of themes (3+ sparks) the user hasn't seen yet. */
  async getNavAttention(discoverSince: string, today: string): Promise<ApiResponse<NavAttention>> {
    const r = await this.client.get<ApiResponse<NavAttention>>('/api/nav/attention', { params: { discoverSince, today } });
    return r.data;
  }

  async getUnsurfacedClusterCount(): Promise<ApiResponse<{ count: number }>> {
    const r = await this.client.get<ApiResponse<{ count: number }>>('/api/spark-clusters/unsurfaced-count');
    return r.data;
  }

  // ─── Connections ──────────────────────────────────────────────────────────

  async getConnections(refId: string, refType: string): Promise<ApiResponse<ConnectionsResponse>> {
    const r = await this.client.get<ApiResponse<ConnectionsResponse>>('/api/connections', {
      params: { ref_id: refId, ref_type: refType },
    });
    return r.data;
  }

  // ─── Certification Scores ─────────────────────────────────────────────────

  async postCertScore(payload: { cert_code: string; score: number; task_id?: string; notes?: string }): Promise<ApiResponse<Record<string, unknown>>> {
    const r = await this.client.post<ApiResponse<Record<string, unknown>>>('/api/cert-scores', payload);
    return r.data;
  }

  async getCertScores(certCode: string): Promise<ApiResponse<Record<string, unknown>[]>> {
    const r = await this.client.get<ApiResponse<Record<string, unknown>[]>>('/api/cert-scores', { params: { cert_code: certCode } });
    return r.data;
  }

  // ─── Graph ────────────────────────────────────────────────────────────────

  /** Fetches graph nodes and edges for the visualisation page. */
  async getGraph(params: {
    days?: number;
    seed?: string;
    depth?: number;
    edgeTypes?: string[];
    nodeTypes?: string[];
  }): Promise<ApiResponse<GraphResponse>> {
    const p: Record<string, string> = {};
    if (params.days !== undefined) p['days'] = String(params.days);
    if (params.seed !== undefined) p['seed'] = params.seed;
    if (params.depth !== undefined) p['depth'] = String(params.depth);
    if (params.edgeTypes?.length) p['edge_types'] = params.edgeTypes.join(',');
    if (params.nodeTypes?.length) p['node_types'] = params.nodeTypes.join(',');
    const r = await this.client.get<ApiResponse<GraphResponse>>('/api/graph', { params: p });
    return r.data;
  }

  /** Resolve a graph node by ref_id + ref_type. */
  async getGraphNodeByRef(refId: string, refType: string): Promise<ApiResponse<{ id: string; refId: string; refType: string; title: string; tags: string[] }>> {
    const r = await this.client.get<ApiResponse<{ id: string; refId: string; refType: string; title: string; tags: string[] }>>(
      '/api/connections/node-by-ref',
      { params: { ref_id: refId, ref_type: refType } },
    );
    return r.data;
  }

  // ── Morning briefing ────────────────────────────────────────────────────────

  async getPodcastPrep(): Promise<ApiResponse<PodcastPrepStatus>> {
    return (await this.client.get<ApiResponse<PodcastPrepStatus>>('/api/today/podcast-prep')).data;
  }

  async generatePodcastPrep(): Promise<ApiResponse<PodcastPrepStatus>> {
    return (await this.client.post<ApiResponse<PodcastPrepStatus>>('/api/today/podcast-prep')).data;
  }

  async acknowledgePodcastPrep(recordingDate: string, generatedAt: string): Promise<ApiResponse<null>> {
    return (await this.client.post<ApiResponse<null>>('/api/today/podcast-prep/acknowledge', { recordingDate, generatedAt })).data;
  }

  /** Today's morning briefing (null before 09:00 UK time, or if not made yet). */
  async getMorningBriefing(): Promise<ApiResponse<MorningBriefingApi | null>> {
    const r = await this.client.get<ApiResponse<MorningBriefingApi | null>>('/api/today/briefing');
    return r.data;
  }

  /** Makes (or remakes) today's briefing now. */
  async generateMorningBriefing(): Promise<ApiResponse<MorningBriefingApi>> {
    const r = await this.client.post<ApiResponse<MorningBriefingApi>>('/api/today/briefing', {}, { timeout: CHAT_TIMEOUT_MS });
    return r.data;
  }

  // ── Mind maps (Think → Canvas) ──────────────────────────────────────────────

  async listCanvases(noteId?: string): Promise<ApiResponse<CanvasSummaryApi[]>> {
    const r = await this.client.get<ApiResponse<CanvasSummaryApi[]>>('/api/canvases', { params: noteId !== undefined ? { noteId } : {} });
    return r.data;
  }

  async listDeletedCanvases(): Promise<ApiResponse<CanvasSummaryApi[]>> {
    return (await this.client.get<ApiResponse<CanvasSummaryApi[]>>('/api/canvases/recycle-bin')).data;
  }

  async createCanvas(input: { title?: string; rootLabel?: string; noteId?: string; project?: string; canvasType?: 'brainstorm' | 'diagram' } = {}): Promise<ApiResponse<CanvasFullApi>> {
    const r = await this.client.post<ApiResponse<CanvasFullApi>>('/api/canvases', input);
    return r.data;
  }

  async getCanvas(id: string): Promise<ApiResponse<CanvasFullApi>> {
    const r = await this.client.get<ApiResponse<CanvasFullApi>>(`/api/canvases/${id}`);
    return r.data;
  }

  async getDiagram(id: string): Promise<ApiResponse<DiagramSnapshot>> {
    return (await this.client.get<ApiResponse<DiagramSnapshot>>(`/api/canvases/${id}/diagram`)).data;
  }

  async listDiagramDrilldowns(id: string): Promise<ApiResponse<DiagramDrilldownLink[]>> {
    return (await this.client.get<ApiResponse<DiagramDrilldownLink[]>>(`/api/canvases/${id}/drilldowns`)).data;
  }

  async openDiagramDrilldown(id: string, nodeId: string, revision: number): Promise<ApiResponse<DiagramDrilldownLink>> {
    return (await this.client.post<ApiResponse<DiagramDrilldownLink>>(
      `/api/canvases/${id}/elements/${nodeId}/drilldown`, { revision })).data;
  }

  async saveDiagram(id: string, revision: number, document: DiagramDocument): Promise<ApiResponse<DiagramSnapshot>> {
    return (await this.client.put<ApiResponse<DiagramSnapshot>>(`/api/canvases/${id}/diagram`, { revision, document })).data;
  }

  async uploadDiagramAsset(id: string, file: Blob, name: string): Promise<ApiResponse<DiagramAsset>> {
    return (await this.client.post<ApiResponse<DiagramAsset>>(`/api/canvases/${id}/assets`, file, {
      headers: { 'Content-Type': file.type }, params: { name }, timeout: IMAGE_UPLOAD_TIMEOUT_MS,
    })).data;
  }

  async getDiagramAsset(id: string, assetId: string): Promise<Blob> {
    return (await this.client.get<Blob>(`/api/canvases/${id}/assets/${assetId}`, { responseType: 'blob' })).data;
  }

  async getImageFile(id: string): Promise<Blob> {
    return (await this.client.get<Blob>(`/api/images/${encodeURIComponent(id)}/file`, { responseType: 'blob' })).data;
  }

  async updateCanvas(id: string, patch: { title?: string; description?: string; project?: string | null; viewport?: object; brainstormSettings?: BrainstormSettings }): Promise<ApiResponse<CanvasSummaryApi>> {
    const r = await this.client.patch<ApiResponse<CanvasSummaryApi>>(`/api/canvases/${id}`, patch);
    return r.data;
  }

  async deleteCanvas(id: string): Promise<void> {
    await this.client.delete(`/api/canvases/${id}`);
  }

  async restoreCanvas(id: string): Promise<ApiResponse<{ canvas: CanvasSummaryApi; restored: boolean }>> {
    return (await this.client.post<ApiResponse<{ canvas: CanvasSummaryApi; restored: boolean }>>(`/api/canvases/${id}/restore`)).data;
  }

  async permanentlyDeleteCanvas(id: string): Promise<void> {
    await this.client.delete(`/api/canvases/${id}/permanent`);
  }

  /** Applies changes to a map (all-or-nothing); returns the updated map. */
  async applyCanvasOps(id: string, ops: MapOp[]): Promise<ApiResponse<CanvasFullApi>> {
    const r = await this.client.post<ApiResponse<CanvasFullApi>>(`/api/canvases/${id}/ops`, { ops });
    return r.data;
  }

  /** Adds an item to a canvas as a card ("Send to Canvas"); it's placed automatically when the canvas opens. */
  async addToCanvas(id: string, item: { label: string; body?: string; url?: string; refType?: string; refId?: string }): Promise<ApiResponse<CanvasFullApi>> {
    const refType = MAP_REF_TYPES.find((t) => t === item.refType);
    return this.applyCanvasOps(id, [{
      op: 'add', id: crypto.randomUUID(), label: item.label,
      ...(item.body !== undefined && { body: item.body }),
      ...(item.url !== undefined && { url: item.url }),
      ...(refType !== undefined && item.refId !== undefined && { refType, refId: item.refId }),
    }]);
  }

  /** The full content behind a card (Preview tab). */
  async getCanvasCardContent(id: string, nodeId: string): Promise<ApiResponse<CanvasCardContentApi>> {
    const r = await this.client.get<ApiResponse<CanvasCardContentApi>>(`/api/canvases/${id}/nodes/${nodeId}/content`, { timeout: CHAT_TIMEOUT_MS });
    return r.data;
  }

  async linkCanvasNote(id: string, noteId: string): Promise<ApiResponse<CanvasFullApi>> {
    const r = await this.client.post<ApiResponse<CanvasFullApi>>(`/api/canvases/${id}/notes`, { noteId });
    return r.data;
  }

  async unlinkCanvasNote(id: string, noteId: string): Promise<ApiResponse<CanvasFullApi>> {
    const r = await this.client.delete<ApiResponse<CanvasFullApi>>(`/api/canvases/${id}/notes/${noteId}`);
    return r.data;
  }

  /** Link a note to one diagram shape, connector or footnote. */
  async linkElementNote(id: string, elementId: string, noteId: string): Promise<ApiResponse<CanvasFullApi>> {
    const r = await this.client.post<ApiResponse<CanvasFullApi>>(`/api/canvases/${id}/elements/${elementId}/notes`, { noteId });
    return r.data;
  }

  async unlinkElementNote(id: string, elementId: string, noteId: string): Promise<ApiResponse<CanvasFullApi>> {
    const r = await this.client.delete<ApiResponse<CanvasFullApi>>(`/api/canvases/${id}/elements/${elementId}/notes/${encodeURIComponent(noteId)}`);
    return r.data;
  }

  async listDiagramVersions(id: string): Promise<ApiResponse<DiagramVersionSummaryApi[]>> {
    const r = await this.client.get<ApiResponse<DiagramVersionSummaryApi[]>>(`/api/canvases/${id}/versions`);
    return r.data;
  }

  /** Saves the last saved document (not unsaved edits) as a named version. */
  async createDiagramVersion(id: string, name: string): Promise<ApiResponse<DiagramVersionSummaryApi>> {
    const r = await this.client.post<ApiResponse<DiagramVersionSummaryApi>>(`/api/canvases/${id}/versions`, { name });
    return r.data;
  }

  async getDiagramVersion(id: string, versionId: string): Promise<ApiResponse<DiagramVersionApi>> {
    const r = await this.client.get<ApiResponse<DiagramVersionApi>>(`/api/canvases/${id}/versions/${versionId}`);
    return r.data;
  }

  async deleteDiagramVersion(id: string, versionId: string): Promise<void> {
    await this.client.delete(`/api/canvases/${id}/versions/${versionId}`);
  }

  /** Related content for an idea; its current text is sent so unsaved edits count. */
  async getCanvasSuggestions(id: string, idea: { nodeId?: string; label?: string; body?: string; contextLabels?: string } = {}): Promise<ApiResponse<MapSuggestionApi[]>> {
    const r = await this.client.get<ApiResponse<MapSuggestionApi[]>>(`/api/canvases/${id}/suggestions`, {
      params: idea, timeout: CHAT_TIMEOUT_MS,
    });
    return r.data;
  }

  /** A card and its connections as a new note (pinned to the canvas), or added to `noteId`. */
  async canvasBranchToNote(id: string, nodeId: string, noteId?: string): Promise<ApiResponse<{ noteId: string; created: boolean }>> {
    const r = await this.client.post<ApiResponse<{ noteId: string; created: boolean }>>(
      `/api/canvases/${id}/nodes/${nodeId}/to-note`, noteId !== undefined ? { noteId } : {});
    return r.data;
  }

  async getCanvasMarkdown(id: string): Promise<ApiResponse<{ markdown: string }>> {
    const r = await this.client.get<ApiResponse<{ markdown: string }>>(`/api/canvases/${id}/markdown`);
    return r.data;
  }

  // ─── Today dashboard ───────────────────────────────────────────────────────

  /** Fetches mapped GitHub commits/PRs for the Today card. */
  async getTodayGitHubActivity(): Promise<ApiResponse<TodayGitHubActivityResponse>> {
    const r = await this.client.get<ApiResponse<TodayGitHubActivityResponse>>('/api/today/github-activity');
    return r.data;
  }

  /** Fetches repo mapping config (connected repos + filing tags + current mappings). */
  async getRepoProjectMappingConfig(): Promise<ApiResponse<RepoProjectMappingConfig>> {
    const r = await this.client.get<ApiResponse<RepoProjectMappingConfig>>('/api/repo-project-mappings/config');
    return r.data;
  }

  /** Upserts one repo->project tag mapping row. Null projectTagId removes mapping. */
  async saveRepoProjectMapping(
    repoFullName: string,
    projectTagId: string | null,
  ): Promise<ApiResponse<{ repoFullName: string; projectTagId: string | null }>> {
    const r = await this.client.put<ApiResponse<{ repoFullName: string; projectTagId: string | null }>>(
      '/api/repo-project-mappings',
      { repoFullName, projectTagId },
    );
    return r.data;
  }

  // ─── Use cases (evidence → spec → handoff) ────────────────────────────────

  async listUseCases(): Promise<ApiResponse<UseCase[]>> {
    return (await this.client.get<ApiResponse<UseCase[]>>('/api/use-cases')).data;
  }

  async getUseCase(id: string): Promise<ApiResponse<UseCaseDetail>> {
    return (await this.client.get<ApiResponse<UseCaseDetail>>(`/api/use-cases/${encodeURIComponent(id)}`)).data;
  }

  async createUseCase(input: CreateUseCaseInput): Promise<ApiResponse<UseCaseDetail>> {
    return (await this.client.post<ApiResponse<UseCaseDetail>>('/api/use-cases', input)).data;
  }

  async updateUseCase(id: string, patch: UseCasePatch): Promise<ApiResponse<UseCaseDetail>> {
    return (await this.client.patch<ApiResponse<UseCaseDetail>>(`/api/use-cases/${encodeURIComponent(id)}`, patch)).data;
  }

  async deleteUseCase(id: string): Promise<void> {
    await this.client.delete(`/api/use-cases/${encodeURIComponent(id)}`);
  }

  async addUseCaseSources(id: string, sources: UseCaseSourceRef[]): Promise<ApiResponse<UseCaseDetail>> {
    return (await this.client.post<ApiResponse<UseCaseDetail>>(`/api/use-cases/${encodeURIComponent(id)}/sources`, { sources })).data;
  }

  async removeUseCaseSource(id: string, ref: UseCaseSourceRef): Promise<ApiResponse<UseCaseDetail>> {
    return (await this.client.delete<ApiResponse<UseCaseDetail>>(
      `/api/use-cases/${encodeURIComponent(id)}/sources/${ref.sourceType}/${encodeURIComponent(ref.sourceId)}`)).data;
  }

  async addUseCaseLink(id: string, url: string, title?: string): Promise<ApiResponse<UseCaseDetail>> {
    return (await this.client.post<ApiResponse<UseCaseDetail>>(`/api/use-cases/${encodeURIComponent(id)}/links`, { url, title })).data;
  }

  async removeUseCaseLink(id: string, linkId: string): Promise<ApiResponse<UseCaseDetail>> {
    return (await this.client.delete<ApiResponse<UseCaseDetail>>(
      `/api/use-cases/${encodeURIComponent(id)}/links/${encodeURIComponent(linkId)}`)).data;
  }

  /** Drafting runs a long model call; allow it the same budget as the backend. */
  async draftUseCaseSpec(id: string, replace = false): Promise<ApiResponse<DraftSpecResult>> {
    return (await this.client.post<ApiResponse<DraftSpecResult>>(
      `/api/use-cases/${encodeURIComponent(id)}/draft-spec`, { replace }, { timeout: 300_000 })).data;
  }

  async handoffUseCase(id: string, input: HandoffInput): Promise<ApiResponse<HandoffResult>> {
    return (await this.client.post<ApiResponse<HandoffResult>>(
      `/api/use-cases/${encodeURIComponent(id)}/handoff`, input, { timeout: 120_000 })).data;
  }

  async reviewDocument(input: { document: string; selection: string; instruction: string; matchMode: 'text' | 'markdown' }): Promise<ApiResponse<{ find: string; replacement: string; summary: string }>> {
    return (await this.client.post<ApiResponse<{ find: string; replacement: string; summary: string }>>(
      '/api/ai/document-review', input, { timeout: 120_000 })).data;
  }

  async listDesigns(): Promise<ApiResponse<{ items: Design[]; hasMore: boolean }>> {
    return (await this.client.get<ApiResponse<{ items: Design[]; hasMore: boolean }>>('/api/designs')).data;
  }
  async getDesign(id: string): Promise<ApiResponse<DesignDetail>> {
    return (await this.client.get<ApiResponse<DesignDetail>>(`/api/designs/${encodeURIComponent(id)}`)).data;
  }
  async designMembership(type: 'note' | 'canvas', sourceId: string): Promise<ApiResponse<Array<{ id: string; parentNoteId: string; title: string; role: string }>>> {
    return (await this.client.get<ApiResponse<Array<{ id: string; parentNoteId: string; title: string; role: string }>>>('/api/designs/membership', { params: { type, sourceId } })).data;
  }
  async selectDesignAsset(id: string, role: string, sourceId: string, expectedRevision: number): Promise<ApiResponse<DesignDetail>> {
    return (await this.client.post<ApiResponse<DesignDetail>>(`/api/designs/${encodeURIComponent(id)}/selection`, { role, sourceId, expectedRevision })).data;
  }
  async setDesignSpecificationType(id: string, specificationType: 'standard' | 'imagine', expectedRevision: number): Promise<ApiResponse<DesignDetail>> {
    return (await this.client.post<ApiResponse<DesignDetail>>(`/api/designs/${encodeURIComponent(id)}/specification-type`, { specificationType, expectedRevision })).data;
  }
  async designCollaboration(id: string): Promise<ApiResponse<DesignCollaboration>> {
    return (await this.client.get<ApiResponse<DesignCollaboration>>(`/api/designs/${encodeURIComponent(id)}/collaboration`)).data;
  }
  async generateDesignArtifact(id: string, instruction: string, onProgress?: (message: string) => void): Promise<ApiResponse<DesignArtifact>> {
    if (onProgress) {
      const signedIn = await getApiToken();
      const auth = signedIn !== '' ? signedIn : TOKEN;
      const response = await fetch(`${BASE_URL}/api/designs/${encodeURIComponent(id)}/artifacts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream',
          ...(auth !== '' ? { Authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify({ instruction }), signal: AbortSignal.timeout(600_000),
      });
      if (!response.ok || !response.body) throw new Error(`Could not start visual generation (${response.status}). Your documents are unchanged.`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // The page enforces its own deadline: a dropped proxy connection can leave read() pending even after the fetch signal fires.
      const deadline = Date.now() + 300_000;
      const read = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([reader.read(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => { reject(new Error('Lost the visual-generation connection before completion. Reopen HTML to check whether the visual was saved before retrying.')); }, Math.max(0, deadline - Date.now()));
          })]);
        } finally { clearTimeout(timer); }
      };
      try {
        for (;;) {
          const { done, value } = await read();
          if (done) throw new Error('Lost the visual-generation connection before completion. Reopen HTML to check whether the visual was saved before retrying.');
          buffer += decoder.decode(value, { stream: true });
          let separator: number;
          while ((separator = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, separator); buffer = buffer.slice(separator + 2);
            const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const event = JSON.parse(data) as { type: string; message?: string; data?: DesignArtifact };
            if (event.type === 'progress' && typeof event.message === 'string') onProgress(event.message);
            else if (event.type === 'error') throw new Error(event.message ?? 'Visual generation failed.');
            else if (event.type === 'done' && event.data) return { success: true, data: event.data };
          }
        }
      } finally { void reader.cancel().catch(() => undefined); }
    }
    return (await this.client.post<ApiResponse<DesignArtifact>>(`/api/designs/${encodeURIComponent(id)}/artifacts`, { instruction }, { timeout: 600_000 })).data;
  }
  async queueDesignFeedback(id: string, input: { requestId: string; artifactId: string; elementId: string; selection: string; instruction: string }): Promise<ApiResponse<DesignFeedback>> {
    return (await this.client.post<ApiResponse<DesignFeedback>>(`/api/designs/${encodeURIComponent(id)}/feedback`, input)).data;
  }
  async proposeDesignFeedback(id: string): Promise<ApiResponse<DesignProposal>> {
    return (await this.client.post<ApiResponse<DesignProposal>>(`/api/designs/${encodeURIComponent(id)}/proposals`, {}, { timeout: 300_000 })).data;
  }
  async applyDesignFeedback(id: string): Promise<ApiResponse<{ noteIds: string[]; remaining: number }>> {
    return (await this.client.post<ApiResponse<{ noteIds: string[]; remaining: number }>>(`/api/designs/${encodeURIComponent(id)}/apply`, {}, { timeout: 300_000 })).data;
  }
  async handOffToSpecialist(specialist: string, subjectId: string, input: Record<string, unknown> = {}, confirmed = false): Promise<ApiResponse<AgentHandOffResult>> {
    return (await this.client.post<ApiResponse<AgentHandOffResult>>('/api/agent-jobs', { specialist, subjectId, input, confirmed })).data;
  }
  async getAgentJob(id: string): Promise<ApiResponse<AgentJob>> {
    return (await this.client.get<ApiResponse<AgentJob>>(`/api/agent-jobs/${encodeURIComponent(id)}`)).data;
  }
  async recheckBlogJob(id: string, post: Omit<BlogDraft, 'sourceUrl'>): Promise<ApiResponse<AgentJob>> {
    return (await this.client.post<ApiResponse<AgentJob>>(`/api/agent-jobs/${encodeURIComponent(id)}/blog-recheck`, post, { timeout: CHAT_TIMEOUT_MS })).data;
  }
  async acknowledgeAgentJob(id: string): Promise<void> {
    await this.client.post(`/api/agent-jobs/${encodeURIComponent(id)}/ack`, {});
  }
  async listDesignAgentJobs(subjectId: string): Promise<ApiResponse<AgentJob[]>> {
    return (await this.client.get<ApiResponse<AgentJob[]>>('/api/agent-jobs', { params: { subjectType: 'design', subjectId, limit: 10 } })).data;
  }
  /** Streams every live specialist job, then each change, until the signal aborts or the connection drops. */
  async streamAgentJobs(onJob: (job: AgentJob) => void, signal: AbortSignal): Promise<void> {
    const signedIn = await getApiToken();
    const auth = signedIn !== '' ? signedIn : TOKEN;
    // The server sends a heartbeat every 15s; a silent stream (sleep, proxy, network change) is dropped so the caller reconnects.
    const stream = new AbortController();
    const stop = (): void => { stream.abort(); };
    signal.addEventListener('abort', stop, { once: true });
    let heard = Date.now();
    const watchdog = window.setInterval(() => { if (Date.now() - heard > AGENT_STREAM_SILENCE_MS) stream.abort(); }, AGENT_STREAM_CHECK_MS);
    try {
      await this.readAgentJobStream(auth, onJob, stream.signal, () => { heard = Date.now(); });
    } finally {
      window.clearInterval(watchdog);
      signal.removeEventListener('abort', stop);
    }
  }
  private async readAgentJobStream(auth: string, onJob: (job: AgentJob) => void, signal: AbortSignal, onActivity: () => void): Promise<void> {
    const response = await fetch(`${BASE_URL}/api/agent-jobs/stream`, {
      headers: { Accept: 'text/event-stream', ...(auth !== '' ? { Authorization: `Bearer ${auth}` } : {}) }, signal,
    });
    if (!response.ok || !response.body) throw new Error(`Could not follow specialist jobs (${response.status}).`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        onActivity();
        buffer += decoder.decode(value, { stream: true });
        let separator: number;
        while ((separator = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, separator); buffer = buffer.slice(separator + 2);
          const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const event = JSON.parse(data) as { type: string; job?: AgentJob };
          if (event.type === 'job' && event.job) onJob(event.job);
        }
      }
    } finally { void reader.cancel().catch(() => undefined); }
  }
  async writeDesignSpec(id: string, replace = false): Promise<ApiResponse<{ noteId: string; title: string; created: boolean }>> {
    return (await this.client.post<ApiResponse<{ noteId: string; title: string; created: boolean }>>(`/api/designs/${encodeURIComponent(id)}/spec`, { replace }, { timeout: 300_000 })).data;
  }
  async editDesignFeedback(id: string, feedbackId: string, instruction: string): Promise<ApiResponse<DesignFeedback>> {
    return (await this.client.patch<ApiResponse<DesignFeedback>>(`/api/designs/${encodeURIComponent(id)}/feedback/${encodeURIComponent(feedbackId)}`, { instruction })).data;
  }
  async discardDesignFeedback(id: string, feedbackId: string): Promise<ApiResponse<{ discarded: true }>> {
    return (await this.client.delete<ApiResponse<{ discarded: true }>>(`/api/designs/${encodeURIComponent(id)}/feedback/${encodeURIComponent(feedbackId)}`)).data;
  }
  async resolveDesignProposal(id: string, proposalId: string, accept: boolean): Promise<ApiResponse<{ noteIds: string[] }>> {
    return (await this.client.post<ApiResponse<{ noteIds: string[] }>>(`/api/designs/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}/resolve`, { accept })).data;
  }
  async createDesignPackage(id: string, input: { diagramId?: string; diagramRevision?: number; diagramSvg?: string }): Promise<ApiResponse<DesignPackage>> {
    return (await this.client.post<ApiResponse<DesignPackage>>(`/api/designs/${encodeURIComponent(id)}/packages`, input)).data;
  }
  async downloadDesignPackage(id: string, packageId: string): Promise<Blob> {
    return (await this.client.get<Blob>(`/api/designs/${encodeURIComponent(id)}/packages/${encodeURIComponent(packageId)}/download`, { responseType: 'blob' })).data;
  }
  async prepareDesignPublication(id: string, packageId: string, repo: string, folder: string): Promise<ApiResponse<DesignPublication>> {
    return (await this.client.post<ApiResponse<DesignPublication>>(`/api/designs/${encodeURIComponent(id)}/packages/${encodeURIComponent(packageId)}/prepare`, { repo, folder })).data;
  }
  async publishDesignPackage(id: string, packageId: string, publicationId: string): Promise<ApiResponse<{ commitUrl: string }>> {
    return (await this.client.post<ApiResponse<{ commitUrl: string }>>(`/api/designs/${encodeURIComponent(id)}/packages/${encodeURIComponent(packageId)}/publish`, { publicationId, confirmed: true }, { timeout: 120_000 })).data;
  }
  async searchDesignAssets(q: string, sourceType?: 'note' | 'canvas'): Promise<ApiResponse<DesignAsset[]>> {
    return (await this.client.get<ApiResponse<DesignAsset[]>>('/api/designs/assets/search', { params: { q, sourceType } })).data;
  }
  async linkDesignAsset(id: string, asset: Pick<DesignAsset, 'sourceType' | 'sourceId' | 'role'>, remove = false): Promise<ApiResponse<DesignDetail>> {
    const url = `/api/designs/${encodeURIComponent(id)}/assets`;
    return remove ? (await this.client.delete<ApiResponse<DesignDetail>>(url, { data: asset })).data
      : (await this.client.post<ApiResponse<DesignDetail>>(url, asset)).data;
  }

  // ─── Build pipeline (spec → tasks → cloud coding agents) ─────────────────

  async listBuildSpecs(): Promise<ApiResponse<BuildSpecSummary[]>> {
    const r = await this.client.get<ApiResponse<BuildSpecSummary[]>>('/api/build/specs');
    return r.data;
  }

  async getBuildSpec(id: string): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.get<ApiResponse<BuildSpecWithTasks>>(`/api/build/specs/${id}`);
    return r.data;
  }

  async createBuildSpec(input: { title: string; repo: string; specMarkdown?: string; baseBranch?: string; maxParallel?: number; autoMerge?: boolean; useWorkBranch?: boolean }): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.post<ApiResponse<BuildSpecWithTasks>>('/api/build/specs', input);
    return r.data;
  }

  async createBuildSpecFromNote(input: { noteId: string; repo: string; baseBranch?: string }): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.post<ApiResponse<BuildSpecWithTasks>>('/api/build/specs/from-note', input);
    return r.data;
  }

  async createBuildSpecFromOutput(input: { outputId: string; repo: string; baseBranch?: string }): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.post<ApiResponse<BuildSpecWithTasks>>('/api/build/specs/from-output', input);
    return r.data;
  }

  async updateBuildSpec(id: string, patch: Partial<Pick<BuildSpec, 'title' | 'specMarkdown' | 'repo' | 'baseBranch' | 'maxParallel' | 'autoMerge' | 'useWorkBranch'>> & { expectedSpecMarkdown?: string }): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.patch<ApiResponse<BuildSpecWithTasks>>(`/api/build/specs/${id}`, patch);
    return r.data;
  }

  async deleteBuildSpec(id: string): Promise<ApiResponse<{ id: string }>> {
    const r = await this.client.delete<ApiResponse<{ id: string }>>(`/api/build/specs/${id}`);
    return r.data;
  }

  /** start | pause | sync | decompose | merge-final (merge the integration branch into the target) */
  async buildSpecAction(id: string, action: 'decompose' | 'start' | 'pause' | 'sync' | 'merge-final'): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.post<ApiResponse<BuildSpecWithTasks>>(`/api/build/specs/${id}/${action}`, {});
    return r.data;
  }

  async listBuildEvents(id: string): Promise<ApiResponse<BuildEvent[]>> {
    const r = await this.client.get<ApiResponse<BuildEvent[]>>(`/api/build/specs/${id}/events`);
    return r.data;
  }

  async updateBuildTask(id: string, patch: Partial<Pick<BuildTask, 'title' | 'bodyMarkdown' | 'agent' | 'dependsOn'>>): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.patch<ApiResponse<BuildSpecWithTasks>>(`/api/build/tasks/${id}`, patch);
    return r.data;
  }

  async buildTaskAction(id: string, action: 'retry' | 'cancel' | 'merge'): Promise<ApiResponse<BuildSpecWithTasks>> {
    const r = await this.client.post<ApiResponse<BuildSpecWithTasks>>(`/api/build/tasks/${id}/${action}`, {});
    return r.data;
  }

  async listBuildAgents(repo: string): Promise<ApiResponse<BuildAgent[]>> {
    const r = await this.client.get<ApiResponse<BuildAgent[]>>('/api/build/agents', { params: { repo } });
    return r.data;
  }

  async listBuildBranches(repo: string): Promise<ApiResponse<{ defaultBranch: string; branches: string[] }>> {
    const r = await this.client.get<ApiResponse<{ defaultBranch: string; branches: string[] }>>('/api/build/branches', { params: { repo } });
    return r.data;
  }
}

export type BuildAgent = 'copilot' | 'claude';
export type BuildSpecStatus = 'draft' | 'decomposing' | 'decomposed' | 'running' | 'paused' | 'done' | 'failed';
export type BuildTaskStatus = 'pending' | 'dispatched' | 'pr_open' | 'awaiting_approval' | 'merged' | 'blocked' | 'failed' | 'cancelled';

export interface BuildSpec {
  id: string;
  projectId: string | null;
  noteId: string | null;
  chatOutputId: string | null;
  title: string;
  specMarkdown: string;
  repo: string;
  /** Target branch: the integration branch is cut from it and merged back into it. */
  baseBranch: string;
  useWorkBranch: boolean;
  /** build/<slug> integration branch the agents work on (set when the build starts). */
  workBranch: string | null;
  finalPrNumber: number | null;
  finalPrUrl: string | null;
  finalPrMergedAt: string | null;
  status: BuildSpecStatus;
  maxParallel: number;
  autoMerge: boolean;
  planNotes: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuildTask {
  id: string;
  specId: string;
  seq: number;
  title: string;
  bodyMarkdown: string;
  agent: BuildAgent;
  agentReason: string;
  size: 'S' | 'M' | 'L';
  dependsOn: string[];
  status: BuildTaskStatus;
  issueNumber: number | null;
  issueUrl: string | null;
  prNumber: number | null;
  prUrl: string | null;
  fixAttempts: number;
  lastError: string | null;
  dispatchedAt: string | null;
  mergedAt: string | null;
  updatedAt: string;
}

export interface BuildEvent {
  id: string;
  taskId: string | null;
  kind: string;
  message: string;
  createdAt: string;
}

export interface BuildSpecWithTasks extends BuildSpec { tasks: BuildTask[] }
export interface BuildSpecSummary extends BuildSpec { taskCounts: Partial<Record<BuildTaskStatus, number>>; taskTotal: number }

/** Singleton instance — used by all React Query hooks. */
export const api = new KnowledgeHubApi();

/** Athena's morning briefing (also saved as a pinned Athena chat). */
export interface MorningBriefingApi {
  date: string;
  sessionId: string;
  markdown: string;
  generatedAt: string;
}

// ── Mind map API types ────────────────────────────────────────────────────────

export const MAP_REF_TYPES = ['discover_item', 'spark', 'note', 'content_item', 'ai_session'] as const;
export type MapRefType = typeof MAP_REF_TYPES[number];

export interface CanvasSummaryApi {
  id: string; title: string; description: string | null;
  canvasType: 'brainstorm' | 'diagram';
  parentCanvasId?: string | null;
  parentShapeLabel?: string | null;
  deletedAt?: string | null;
  project: string | null; createdAt: string; updatedAt: string;
  linkedNotes: Array<{ id: string; title: string }>;
  nodeCount: number;
  /** Only when listed for a note: the diagram shapes/connectors/footnotes that note is linked to. */
  linkedElements?: Array<{ elementId: string; label: string; footnote: number | null }>;
}

export interface DiagramElementNoteApi { elementId: string; noteId: string; title: string }
export interface DiagramVersionSummaryApi { id: string; name: string; revision: number; createdAt: string }
export interface DiagramVersionApi extends DiagramVersionSummaryApi { document: DiagramDocument }

/** A card on a canvas: content (refType/refId) or your own idea. `body` is your annotation. */
export interface CanvasNodeApi {
  id: string; canvasId: string; nodeType: string;
  refType: MapRefType | null; refId: string | null;
  label: string | null; body: string | null;
  url: string | null; tags: string[] | null;
  /** Brainstorm card type for idea cards; null means the default (topic for the centre card, otherwise idea). */
  cardType: string | null;
  footnote: string | null;
  /** The card's children are hidden. */
  collapsed: boolean;
  x: number; y: number; placed: boolean;
  createdAt: string;
}

/** A typed connection between two cards. */
export interface CanvasEdgeApi {
  id: string; canvasId: string; sourceId: string; targetId: string;
  type: string; label: string | null; createdAt: string;
}

export interface CanvasCardContentApi {
  kind: string; title: string; text: string; url: string | null; date: string | null;
}

export interface BrainstormSettings {
  grid: boolean; snapToGrid: boolean; snapToShapes: boolean; gridSize: 5 | 10 | 20 | 40;
}

export interface CanvasFullApi extends CanvasSummaryApi {
  viewport: { x: number; y: number; zoom: number };
  brainstormSettings: BrainstormSettings;
  nodes: CanvasNodeApi[];
  edges: CanvasEdgeApi[];
  /** Diagram only: notes linked to individual shapes, connectors and footnotes. */
  elementNotes?: DiagramElementNoteApi[];
}

/** One change to a canvas (ids are client-generated UUIDs). */
export type MapOp =
  | { op: 'add'; id: string; label?: string; body?: string; nodeType?: string; refType?: MapRefType; refId?: string; url?: string;
      tags?: string[]; cardType?: string; footnote?: string; collapsed?: boolean;
      x?: number; y?: number; connectTo?: { nodeId: string; edgeId: string; type?: string } }
  /** An empty cardType or footnote clears it. */
  | { op: 'update'; id: string; label?: string; body?: string; cardType?: string; footnote?: string; collapsed?: boolean }
  | { op: 'position'; id: string; x: number; y: number }
  | { op: 'delete'; id: string }
  | { op: 'link'; id: string; sourceId: string; targetId: string; type?: string; label?: string }
  | { op: 'update_link'; id: string; type?: string; label?: string }
  | { op: 'unlink'; id: string };

export interface MapSuggestionApi {
  kind: 'note' | 'document' | 'meeting' | 'post' | 'article' | 'chat';
  refType: MapRefType;
  refId: string;
  title: string;
  excerpt: string;
  date: string | null;
  url: string | null;
  via: 'search' | 'graph';
}

// ── Today dashboard API types ─────────────────────────────────────────────────

/** A single mapped GitHub activity item returned by GET /api/today/github-activity. */
export interface GitHubActivityItem {
  id: string;
  source: string;
  title: string;
  summary: string | null;
  published_at: string;
  url: string | null;
  metadata: Record<string, unknown> | null;
  repo_full_name: string;
  project_tag_id: string;
  project_tag_name: string;
}

/** Today GitHub activity API envelope payload. */
export interface TodayGitHubActivityResponse {
  hasMappings: boolean;
  items: GitHubActivityItem[];
}

/** Connected repository source row for repo mapping settings. */
export interface ConnectedRepo {
  repoFullName: string;
  provider: 'github' | 'gitlab';
}

/** Existing repo->project mapping row from settings config endpoint. */
export interface RepoProjectMapping {
  repoFullName: string;
  projectTagId: string;
  projectTagName: string;
  updatedAt: string;
}

/** Repo mapping settings bootstrap payload. */
export interface RepoProjectMappingConfig {
  repos: ConnectedRepo[];
  filingTags: Array<{ id: string; name: string; parentName: string | null }>;
  mappings: RepoProjectMapping[];
}
