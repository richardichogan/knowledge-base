/**
 * articleScoringPrompt.ts
 *
 * Editorial triage scoring for discovered articles: a vendor-neutral rubric
 * written around Richard's actual lens (enterprise architecture, AI governance
 * and security, the IBM–Microsoft practice), a 0–100 score that spreads out
 * rather than piling up at a ceiling, and routing to the publishing format
 * (blog, newsletter, podcast, LinkedIn) the article suits.
 */

export const COMMUNITY_COMPOSITE_CAP = 6;
export const COMMUNITY_NOVELTY_CAP = 2;
export const COMPOSITE_MAX = 10;
export const PERCENTAGE_MULTIPLIER = 100;
export const FULL_BLOG_POST_DEPTH_MIN = 2;
export const FULL_BLOG_POST_COMPOSITE_MIN = 8;
export const ARCHIVE_COMPOSITE_MAX = 3;
export const SCORE_BATCH_SIZE = 50;
export const RELEVANCE_MAX_TOKENS = 1500; // headroom for the reasoning model's thinking tokens

/**
 * Score = 100 × the weighted share of the four dimensions, then a calibration
 * curve, then small additive adjustments. No stacked multipliers and no
 * ceiling clamp, so a very strong article and a good one stay distinguishable.
 * (Platform is an OUTCOME of scoring, so it no longer feeds back into the score.)
 */
export const SCORING_WEIGHTS = {
  audienceFit: 0.35,            // fit to his themes and audience
  novelty: 0.25,                // genuinely new information
  strategicSignificance: 0.20,  // enterprise decision impact
  analyticalDepth: 0.20,        // does he have an angle worth 800 words
} as const;

/**
 * Calibration curve: weighted share (0-1) → score points. The scorer is deliberately harsh, so
 * raw shares cluster low; these anchors stretch them so a composite of 6+ out of 10 reaches
 * the 80s (roughly the top 7-8% of articles) while ordinary articles spread across 30-70.
 */
const SCORE_CURVE: Array<[share: number, points: number]> = [
  [0, 0], [0.15, 15], [0.30, 38], [0.45, 60], [0.56, 80], [0.80, 94], [1, 99],
];

function applyCurve(share: number): number {
  const x = Math.max(0, Math.min(1, share));
  for (let i = 1; i < SCORE_CURVE.length; i++) {
    const [x1, y1] = SCORE_CURVE[i]!;
    const [x0, y0] = SCORE_CURVE[i - 1]!;
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 99;
}

/** Article types that can never reach the top band, whatever else they score. */
export const ARTICLE_TYPE_MAX_POINTS: Partial<Record<string, number>> = {
  'Tutorial or How-To': 60,
  'Press Release': 70,
  'News or Roundup': 60,
};

/** Additive adjustments, in score points (0–100). */
export const SCORE_ADJUSTMENTS = {
  spark: 4,                 // a specific citeable data point or example
  coveredRelated: -8,       // he has published something related
  coveredFully: -25,        // he has already made this argument
  communityMax: 60,         // community sources never reach the top band
  archiveMax: 25,           // anything routed to Archive stays low
  advertorialMax: 10,
} as const;

/** The themes the score is measured against — edit here as his focus changes. */
export const RICHARD_THEMES = [
  'AI governance, risk and security for enterprises (agents, identity, concentration risk, regulation, incidents)',
  'Microsoft cloud, Copilot and GitHub as enterprise platforms',
  'The IBM and Microsoft partnership and practice; IBM announcements he can connect to enterprise AI and Microsoft work',
  'Agentic enterprise architecture and operating models (the kind of work Project Imagine does)',
  'Competitive and ecosystem moves (Google, AWS, OpenAI, IBM) that change how enterprises choose, combine or govern platforms',
  'Enterprise AI adoption: what actually works, what fails, and why',
];

export type SourceType = 'Formal' | 'Community' | 'Case Study or Advertorial';

export type Platform =
  | 'Full Blog Post'
  | 'Newsletter Candidate'
  | 'Podcast Topic'
  | 'LinkedIn Standalone'
  | 'Archive';

/** Coarse content-type classification, used as a ranking multiplier alongside editorial quality. */
export type ArticleType =
  | 'Security Disclosure'
  | 'Product Announcement'
  | 'Research Report'
  | 'Opinion or Analysis'
  | 'Press Release'
  | 'Tutorial or How-To'
  | 'News or Roundup';

/** Weight applied per article type on top of the editorial composite score. */
export const ARTICLE_TYPE_WEIGHTS: Record<ArticleType, number> = {
  'Security Disclosure': 1.2,
  'Product Announcement': 1.1,
  'Research Report': 1.1,
  'Opinion or Analysis': 1.0,
  'Tutorial or How-To': 0.9,
  'Press Release': 0.85,
  'News or Roundup': 0.8,
};

/** Fine-grained source authority tier, distinct from the coarser SourceType used for platform routing/caps. */
export type SourceAuthorityTier =
  | 'Microsoft/GitHub Official'
  | 'IBM Official'
  | 'Vendor Official'
  | 'Analyst/Consultancy'
  | 'Formal'
  | 'Community'
  | 'Unknown';

/** Weight applied per source authority tier on top of the editorial score (ranking only, applied live). */
export const SOURCE_AUTHORITY_WEIGHTS: Record<SourceAuthorityTier, number> = {
  'Microsoft/GitHub Official': 1.3,
  'IBM Official': 1.3,
  'Vendor Official': 1.1,   // Google, AWS, OpenAI: primary sources, but not his platform
  'Analyst/Consultancy': 1.15,
  Formal: 1.0,
  Community: 0.75,
  Unknown: 0.9,
};

/** Microsoft/GitHub's own channels. */
const MICROSOFT_GITHUB_DOMAINS = [
  'azure.microsoft.com',
  'microsoft.com/en-us/security/blog',
  'microsoft.com/en-gb/microsoft-cloud-blog',
  'blogs.microsoft.com',
  'devblogs.microsoft.com',
  'learn.microsoft.com',
  'news.microsoft.com',
  'research.microsoft.com',
  'msrc.microsoft.com',
  'github.blog',
  'github.com/security',
  'github.com/newsroom',
];

/** IBM's own channels. */
const IBM_DOMAINS = ['newsroom.ibm.com', 'research.ibm.com', 'ibm.com/blog', 'ibm.com/think', 'ibm.com/new', 'ibm.com/products'];

/** Other major vendors' primary sources. */
const OTHER_VENDOR_DOMAINS = [
  'openai.com',
  'aws.amazon.com',
  'amazon.science',
  'cloud.google.com',
  'cloudblog.withgoogle.com',
  'blog.google',
  'deepmind.google',
  'research.google',
  'ai.google',
];

/** Major analyst/consultancy firms — independent strategic research, one tier below Microsoft/GitHub's own word. */
const ANALYST_CONSULTANCY_DOMAINS = [
  'mckinsey.com',
  'gartner.com',
  'forrester.com',
  'bcg.com',
  'deloitte.com',
  'idc.com',
  'bain.com',
];

/** Classifies a URL into a fine-grained source authority tier for ranking (distinct from classifySourceByUrl's coarser SourceType). */
export function classifySourceAuthority(articleUrl: string | null, sourceUrl: string | null): SourceAuthorityTier {
  const candidates = [articleUrl, sourceUrl].filter((u): u is string => Boolean(u)).map((u) => u.toLowerCase());
  for (const u of candidates) {
    if (MICROSOFT_GITHUB_DOMAINS.some((d) => u.includes(d))) return 'Microsoft/GitHub Official';
  }
  for (const u of candidates) {
    if (IBM_DOMAINS.some((d) => u.includes(d))) return 'IBM Official';
  }
  for (const u of candidates) {
    if (OTHER_VENDOR_DOMAINS.some((d) => u.includes(d))) return 'Vendor Official';
  }
  for (const u of candidates) {
    if (ANALYST_CONSULTANCY_DOMAINS.some((d) => u.includes(d))) return 'Analyst/Consultancy';
  }
  for (const u of candidates) {
    if (COMMUNITY_DOMAINS.some((d) => u.includes(d))) return 'Community';
  }
  return 'Unknown';
}

export interface ScoringResult {
  audienceFit: number;
  novelty: number;
  strategicSignificance: number;
  analyticalDepth: number;
  composite: number;
  sourceType: SourceType;
  platform: Platform;
  spark: boolean;
  sparkReason: string;
  explanation: string;
  articleType: ArticleType;
  /** 0 = not covered, 1 = he has published something related, 2 = he has already made this argument. */
  alreadyCovered?: number;
  /** The title of his piece that covers it, when alreadyCovered > 0. */
  coveredBy?: string;
}

// ── URL-based source type detection ───────────────────────────────────────────

const COMMUNITY_DOMAINS = [
  'techcommunity.microsoft.com',
  'linkedin.com',
  'dev.to',
  'medium.com',
  'reddit.com',
  'stackoverflow.com',
];

/** Keywords in title/description that indicate vendor-sponsored content. */
const ADVERTORIAL_SIGNALS = [
  'forrester',
  'total economic impact',
  'commissioned study',
  'sponsored by',
  'idc report',
  'benefited from',
  'roi of',
  '% roi',
  'total cost of ownership',
];

/** Official primary sources (vendors' own channels) — classed 'Formal'. */
const FORMAL_DOMAINS = [...MICROSOFT_GITHUB_DOMAINS, ...IBM_DOMAINS, ...OTHER_VENDOR_DOMAINS];

/** Classify source type from the article or feed URL, plus title/description. */
export function classifySourceByUrl(
  articleUrl: string | null,
  feedUrlOrTitle: string | null,
): SourceType | null {
  // Check for advertorial signals in title/description
  const combinedText = [articleUrl, feedUrlOrTitle].filter(Boolean).join(' ').toLowerCase();
  for (const signal of ADVERTORIAL_SIGNALS) {
    if (combinedText.includes(signal)) return 'Case Study or Advertorial';
  }

  const check = (u: string): SourceType | null => {
    const lower = u.toLowerCase();
    for (const d of COMMUNITY_DOMAINS) {
      if (lower.includes(d)) return 'Community';
    }
    for (const d of FORMAL_DOMAINS) {
      if (lower.includes(d)) return 'Formal';
    }
    return null;
  };
  if (articleUrl) {
    const result = check(articleUrl);
    if (result) return result;
  }
  if (feedUrlOrTitle) {
    const result = check(feedUrlOrTitle);
    if (result) return result;
  }
  return null;
}

/* eslint-disable max-len */
/**
 * The scoring brief. `covered` is the titles of Richard's own recent published
 * pieces (blog, newsletter, podcast), so the model can tell when an article
 * covers ground he has already covered.
 */
export function buildRelevanceSystemPrompt(covered: string[]): string {
  const coveredList = covered.length > 0 ? covered.map((t) => `- ${t}`).join('\n') : '(none provided)';
  return `You are a brutally honest editorial triage assistant for Richard Hogan, Global Chief Architect in IBM's Microsoft Practice. He publishes a blog (The Microsoft Cloud Blog), a fortnightly newsletter (Reaching for the Cloud), a fortnightly podcast (Cloudy with a Chance of Insights, with two co-hosts) and LinkedIn posts. He writes sceptical, strategic analysis for enterprise IT leaders, cloud architects and security decision-makers. You score CONSERVATIVELY: most articles do NOT deserve high scores, and most should not become content at all.

## What he is building a reputation for
${RICHARD_THEMES.map((t) => `- ${t}`).join('\n')}

The VENDOR does not matter; relevance to those themes and to enterprise decisions does. An OpenAI, Google, AWS or IBM announcement can score as high as a Microsoft one if it changes how enterprises choose, combine or govern platforms, or it is a development Richard can credibly analyse. Pure product feature lists, minor service updates, consumer features and corporate PR score low whoever publishes them.

**Narrow product features score LOW.** A single service feature, new region, SKU, integration or "now supports..." note (databases, storage, compute, networking, Kubernetes, ML tooling and how-tos) is audienceFit 1 and strategicSignificance 0 unless it changes how enterprises should choose, combine or govern platforms. Most AWS "now supports" posts and Google Cloud feature posts are in this group. Customer-story posts ("How X uses Y") are marketing: audienceFit 1 at most.

## What he has published recently (his own pieces)
${coveredList}

## Expected score distribution (per batch of ~35 articles)
- Composite 8-10: 1-2 articles MAX. Genuinely significant and a clear angle for him.
- Composite 6-7: 3-5 articles.
- Composite 4-5: 8-12 articles. Quick-share worthy at most.
- Composite 0-3: 15-20 articles. Routine content.
If you score more than 2 articles as 8+ in a batch, you are being too generous.

## Source type
The source type (Formal / Community / Case Study or Advertorial) is provided. Do NOT override it. "Formal" means a vendor's own channel or another primary source.

## Scoring dimensions: BE HARSH

**Audience Fit (0-3)**
- 3: Strategic content squarely inside his themes that changes how enterprise leaders think or decide: AI governance and security developments, platform strategy shifts, architectural patterns, credible independent analysis, or another vendor's move that directly affects Microsoft/IBM-based enterprise decisions. NOT beginner tutorials. NOT vendor-commissioned studies (Forrester TEI, IDC sponsored reports).
- 2: Clear implications for his themes, but narrower or more technical.
- 1: Tangential, niche, or a how-to without broader context.
- 0: Consumer features, pure marketing, or nothing to do with his themes.

**Novelty (0-3)**
- 3: RARE. A genuinely new capability, critical security disclosure, or a fundamental shift in thinking (the finding itself must be new, not just the publisher well known).
- 2: Meaningful update or a fresh perspective on a live strategic problem.
- 1: Incremental, best-practice, roundup, or familiar thinking restated. MOST articles score 1, including formulaic "[trend] in [industry]" thought-leadership.
- 0: Rehash, old news, documentation rewrite, marketing copy.

**Strategic Significance (0-2)**
- 2: RARE. A conversation enterprise leaders must engage with, or it requires organisational action.
- 1: Useful background or operationally relevant.
- 0: No strategic or operational implication.

**Analytical Depth Potential (0-2)**
- 2: He could write 800+ words of ORIGINAL analysis. Ask: "what is his angle, the thing he would say that the source does not?" If it is clear and substantial, 2. Judge on the article's merits, not the publisher's brand.
- 1: Worth a sharp paragraph in a newsletter or LinkedIn post.
- 0: Nothing to say beyond the news itself.

COMPOSITE = audienceFit + novelty + strategicSignificance + analyticalDepth. Calculate correctly.

## Already covered (0-2)
Compare with his published pieces above, and be STRICT: sharing a broad theme (AI governance, agents, security, Copilot, "AI adoption") does NOT count, because almost everything touches those. Only flag when the article is about the SAME specific story, announcement, incident or argument he has already written about.
- 2 = he has already made essentially this argument or covered this exact news.
- 1 = it is the same specific story or thesis from a different angle, so a new piece would need a clearly different take.
- 0 = anything else, including merely related themes. Expect 0 for about 95% of articles.
When 1 or 2, put the title of his piece in "coveredBy".

## Platform routing (apply the FIRST matching rule)
- **Full Blog Post**: composite >= 8, analyticalDepth = 2, Formal only. VERY rare.
- **Newsletter Candidate**: composite 6-7, topic is broad and cross-cutting (suits a considered issue).
- **Podcast Topic**: a genuine debate or tension with multiple valid perspectives that can sustain 10-15 minutes between three hosts. Rare.
- **LinkedIn Standalone**: composite 4-7, quick-share. Most scored articles land here.
- **Archive**: composite <= 3, OR audienceFit = 0, OR novelty = 0. MANY articles belong here.

## Spark flag
Default FALSE. True only when the article contains a SPECIFIC data point, statistic, customer example or counterargument that could be cited verbatim in future content. Expect ~25% sparks.

## Article type
Exactly one of: Security Disclosure, Product Announcement, Research Report, Opinion or Analysis, Press Release, Tutorial or How-To, News or Roundup. "Press Release" = vendor announcements in marketing voice with no independent analysis; "Product Announcement" = genuine GA/feature launches covered on their technical merits.

## Output
ONLY valid JSON, no fences:
{"audienceFit":<0-3>,"novelty":<0-3>,"strategicSignificance":<0-2>,"analyticalDepth":<0-2>,"composite":<0-10>,"sourceType":"<as provided>","platform":"<Full Blog Post|Newsletter Candidate|Podcast Topic|LinkedIn Standalone|Archive>","spark":<true|false>,"sparkReason":"<specific cited material or empty string>","explanation":"<one sentence>","articleType":"<Security Disclosure|Product Announcement|Research Report|Opinion or Analysis|Press Release|Tutorial or How-To|News or Roundup>","alreadyCovered":<0-2>,"coveredBy":"<title of his piece, or empty string>"}`;
}
/* eslint-enable max-len */

/** Server-side enforcement of scoring rules on top of model output. */
export function enforceScoreCaps(
  parsed: ScoringResult,
  urlSourceType: SourceType | null,
): ScoringResult {
  // Server-side source type override from URL
  if (urlSourceType !== null) {
    parsed.sourceType = urlSourceType;
  }

  // Guard against a missing/invalid articleType from a model that ignores the new field.
  if (!(parsed.articleType in ARTICLE_TYPE_WEIGHTS)) {
    parsed.articleType = 'News or Roundup';
  }

  // Recalculate composite — never trust the model's arithmetic
  parsed.composite = parsed.audienceFit + parsed.novelty
    + parsed.strategicSignificance + parsed.analyticalDepth;

  // Case Study or Advertorial: force Archive
  if (parsed.sourceType === 'Case Study or Advertorial') {
    parsed.composite = 0;
    parsed.platform = 'Archive';
  }

  // Community caps
  if (parsed.sourceType === 'Community') {
    parsed.novelty = Math.min(parsed.novelty, COMMUNITY_NOVELTY_CAP);
    parsed.composite = parsed.audienceFit + parsed.novelty
      + parsed.strategicSignificance + parsed.analyticalDepth;
    parsed.composite = Math.min(parsed.composite, COMMUNITY_COMPOSITE_CAP);
    if (parsed.platform === 'Full Blog Post') {
      parsed.platform = 'Newsletter Candidate';
    }
  }

  // Full Blog Post gate
  if (parsed.platform === 'Full Blog Post') {
    if (
      parsed.composite < FULL_BLOG_POST_COMPOSITE_MIN
      || parsed.analyticalDepth < FULL_BLOG_POST_DEPTH_MIN
      || parsed.sourceType !== 'Formal'
    ) {
      parsed.platform = parsed.composite >= COMMUNITY_COMPOSITE_CAP
        ? 'Newsletter Candidate'
        : 'LinkedIn Standalone';
    }
  }

  // Force Archive when scores too low
  if (
    parsed.audienceFit === 0
    || parsed.novelty === 0
    || parsed.composite <= ARCHIVE_COMPOSITE_MAX
  ) {
    parsed.platform = 'Archive';
  }

  return parsed;
}

/**
 * Triage score (0-1, shown as a percentage): the weighted share of the four
 * dimensions, shaped by a calibration curve, plus small additive adjustments
 * for citeable material and for ground he has already covered. Caps keep
 * community, advertorial and archive-routed articles out of the top band.
 *
 * NOTE: source authority, article type and recency are deliberately NOT applied here.
 * The score is the absolute "editorial quality" percentage shown in Discover; those
 * ranking factors are applied only as a live multiplier in the Discover query's ORDER BY.
 */
export function calculateWeightedRelevance(result: ScoringResult): number {
  const share =
    (result.audienceFit / 3) * SCORING_WEIGHTS.audienceFit +
    (result.novelty / 3) * SCORING_WEIGHTS.novelty +
    (result.strategicSignificance / 2) * SCORING_WEIGHTS.strategicSignificance +
    (result.analyticalDepth / 2) * SCORING_WEIGHTS.analyticalDepth;

  let points = applyCurve(share);
  if (result.spark) points += SCORE_ADJUSTMENTS.spark;
  const covered = result.alreadyCovered ?? 0;
  if (covered >= 2) points += SCORE_ADJUSTMENTS.coveredFully;
  else if (covered === 1) points += SCORE_ADJUSTMENTS.coveredRelated;

  if (result.sourceType === 'Community') points = Math.min(points, SCORE_ADJUSTMENTS.communityMax);
  if (result.sourceType === 'Case Study or Advertorial') points = Math.min(points, SCORE_ADJUSTMENTS.advertorialMax);
  if (result.platform === 'Archive') points = Math.min(points, SCORE_ADJUSTMENTS.archiveMax);
  const typeMax = ARTICLE_TYPE_MAX_POINTS[result.articleType];
  if (typeMax !== undefined) points = Math.min(points, typeMax);

  return Math.max(0, Math.min(99, points)) / 100;
}
