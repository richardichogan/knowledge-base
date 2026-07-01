/**
 * Application-wide constants. No magic strings or numbers in app code.
 */

// ── CMS ───────────────────────────────────────────────────────────────────────

/** Blob path that must NEVER be written — stale derived cache. */
export const CMS_FORBIDDEN_WRITE_PATH = 'content/posts/index.json';

/** Category strings for content type identification (case-insensitive comparison). */
export const CMS_CATEGORY_NEWSLETTER = 'reaching for the cloud';
export const CMS_CATEGORY_PODCAST = 'podcast';

// ── Podcast ───────────────────────────────────────────────────────────────────

/** Blob path for podcast overrides file. */
export const PODCAST_OVERRIDES_BLOB_PATH = 'content/podcast-overrides.json';

/** Max chars in a podcast episode slug. */
export const PODCAST_SLUG_MAX_LENGTH = 60;

// ── AI ────────────────────────────────────────────────────────────────────────

/** Number of RAG items to retrieve per conversation turn. */
export const RAG_ITEMS_LIMIT = 8;

/** Max token estimate for RAG context injection. */
export const RAG_MAX_TOKENS = 4_000;

// ── Pagination ────────────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 1000;
export const NOTE_TITLE_MAX_LENGTH = 120;
export const NOTE_SUMMARY_MAX_LENGTH = 200;

// ── GitHub ────────────────────────────────────────────────────────────────────

/**
 * Repos that should be skipped in all GitHub syncs.
 * Add full_name (owner/repo) for any repo where the token gets 403'd
 * (e.g. org-restricted repos you're a member of but can't read via PAT).
 */
export const GITHUB_REPO_SKIP_LIST = new Set([
  'microsoft/AgentShield',
]);

// ── Sync ──────────────────────────────────────────────────────────────────────

/** Sync cadence in minutes per source. Reviewed before building sync layer. */
export const SYNC_CADENCE_MINUTES: Record<string, number> = {
  cms: 30,
  gitlab: 15,
  github: 15,
  'graph-calendar': 30,
  'graph-todo': 15,
};

export const DEFAULT_SYNC_CADENCE_MINUTES = 30;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HALF_MINUTE = 30_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;
export const DAYS_INITIAL_SYNC_LOOKBACK = 30;
/** How long to wait after startup before running the first sync (ms). */
export const INITIAL_SYNC_DELAY_MS = MS_PER_HALF_MINUTE;

// ── Featured images ───────────────────────────────────────────────────────────

/** Legacy CDN domain for WordPress-era featured images. */
export const LEGACY_IMAGE_CDN = 'richardihogan.wordpress.com';

/** New CDN domain for post-2026 featured images. */
export const NEW_IMAGE_CDN = 'mscloudblogs2026.blob.core.windows.net/images/';

// ── Database pool ─────────────────────────────────────────────────────────────

export const DB_POOL_MAX = 20;
export const DB_POOL_WARN_THRESHOLD = 18; // warn when near capacity
export const DB_STATEMENT_TIMEOUT_MS = 30_000;
export const DB_CONNECTION_TIMEOUT_MS = 10_000;

// SNAT survival — the real fix for "Connection terminated due to connection
// timeout" bursts.
//
// This app runs on a consumption Container Apps environment with no VNet, so
// every outbound connection (DB, AI, GitHub, GitLab, blog) shares Azure's small
// platform-managed SNAT port pool. Opening a NEW DB connection is the most
// frequent outbound dial, and under load the SNAT pool exhausts — new DB
// connections then never reach Postgres and die at DB_CONNECTION_TIMEOUT_MS,
// even though the server is healthy and logs zero failed connections.
//
// Mitigation: keep a warm floor of long-lived connections that are REUSED
// instead of re-dialed. TCP keepalive keeps them alive so Azure won't silently
// drop them, and a long idle timeout means low-traffic gaps no longer force a
// reconnect storm through the congested SNAT pool.
export const DB_POOL_MIN = 8;
// Keep idle connections ~10 min (was 60s). Long enough to survive quiet periods
// without re-dialing; keepalive prevents the sockets from going stale.
export const DB_IDLE_TIMEOUT_MS = 600_000;
export const DB_KEEPALIVE_INITIAL_DELAY_MS = 10_000;

// Background jobs must never check out more than a fraction of the pool at once,
// or live API traffic can't acquire a client and every route 500s with
// "Connection terminated due to connection timeout". Keep fan-out well below
// DB_POOL_MAX so there is always headroom for user requests.
export const JOB_DB_CONCURRENCY = 4;

// AI calls must time out — an unreachable/slow Foundry endpoint (e.g. mid
// repoint) was hanging sync jobs forever, never releasing their work.
export const AI_REQUEST_TIMEOUT_MS = 30_000;
// External HTTP fetches (blog admin API) must also time out.
export const EXTERNAL_FETCH_TIMEOUT_MS = 20_000;

// ── HTTP ──────────────────────────────────────────────────────────────────────

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORISED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  INTERNAL_ERROR: 500,
  BAD_GATEWAY: 502,
} as const;

// ── Images ────────────────────────────────────────────────────────────────────

/** Radix for random ID generation. */
export const RANDOM_ID_RADIX = 36;
/** Start index for slicing random ID segment. */
export const RANDOM_ID_SLICE_START = 2;
/** End index for slicing random ID segment. */
export const RANDOM_ID_SLICE_END = 8;
/** Max Vision OCR polling attempts. */
export const OCR_MAX_POLLS = 10;
/** Interval between OCR polls in ms. */
export const OCR_POLL_INTERVAL_MS = 1_000;
/** Years until image SAS token expires. */
export const IMAGE_SAS_EXPIRY_YEARS = 10;
/** Timeout in ms for blob upload operations. */
export const BLOB_UPLOAD_TIMEOUT_MS = 30_000;

// ── AI ────────────────────────────────────────────────────────────────────────

/** Default max tokens for AI completion requests. */
export const AI_DEFAULT_MAX_TOKENS = 2_000;

// ── Graph / tokens ────────────────────────────────────────────────────────────

/** Milliseconds per second — used for token expiry calculations. */
export const MS_PER_SECOND = 1_000;

// ── Canvas ────────────────────────────────────────────────────────────────────

/** Default width of a new canvas node in world-space units. */
export const CANVAS_NODE_DEFAULT_WIDTH = 280;
/** Default height of a new canvas node in world-space units. */
export const CANVAS_NODE_DEFAULT_HEIGHT = 80;
