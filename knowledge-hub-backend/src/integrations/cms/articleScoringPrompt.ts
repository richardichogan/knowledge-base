/**
 * articleScoringPrompt.ts
 *
 * System prompt and types for the discovered-article editorial scoring system.
 * Evaluates articles across four dimensions and routes them to the appropriate
 * publishing platform for The Microsoft Cloud Blog.
 */

export const COMMUNITY_COMPOSITE_CAP = 6;
export const COMMUNITY_NOVELTY_CAP = 2;
export const COMPOSITE_MAX = 10;
export const PERCENTAGE_MULTIPLIER = 100;
export const FULL_BLOG_POST_DEPTH_MIN = 2;
export const FULL_BLOG_POST_COMPOSITE_MIN = 8;
export const ARCHIVE_COMPOSITE_MAX = 3;
export const SCORE_BATCH_SIZE = 10;
export const RELEVANCE_MAX_TOKENS = 500;

export type SourceType = 'Formal' | 'Community' | 'Case Study or Advertorial';

export type Platform =
  | 'Full Blog Post'
  | 'Newsletter Candidate'
  | 'Podcast Topic'
  | 'LinkedIn Standalone'
  | 'Archive';

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

const FORMAL_DOMAINS = [
  'azure.microsoft.com',
  'microsoft.com/en-us/security/blog',
  'microsoft.com/en-gb/microsoft-cloud-blog',
  'blogs.microsoft.com',
  'devblogs.microsoft.com',
  'learn.microsoft.com',
  'news.microsoft.com',
  'research.microsoft.com',
  'msrc.microsoft.com',
];

/** Classify source type from the article or feed URL. */
export function classifySourceByUrl(
  articleUrl: string | null,
  feedUrl: string | null,
): SourceType | null {
  const check = (u: string): SourceType | null => {
    const lower = u.toLowerCase();
    for (const d of COMMUNITY_DOMAINS) {
      if (lower.includes(d)) return 'Community';
    }
    if (lower.includes('github.blog') && !lower.includes('/security')) {
      return 'Community';
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
  if (feedUrl) {
    const result = check(feedUrl);
    if (result) return result;
  }
  return null;
}

/* eslint-disable max-len */
export const RELEVANCE_SYSTEM_PROMPT = `You are a brutally honest editorial scoring assistant for The Microsoft Cloud Blog. You score CONSERVATIVELY. Your default posture is sceptical — most articles do NOT deserve high scores.

The audience is enterprise IT leaders, cloud architects, security decision-makers, and senior developers working with the Microsoft cloud platform (Azure, Microsoft 365, GitHub, AI/Copilot). This is NOT a beginner tutorial site and NOT a news aggregator. Richard writes original analysis with a sceptical, strategic lens. Most discovered articles do NOT warrant original coverage.

## CRITICAL: Expected Score Distribution

In any batch of ~35 articles, a realistic distribution is:
- Composite 8-10 (Full Blog Post): 1-2 articles MAX. Only genuinely significant announcements.
- Composite 6-7 (Newsletter): 3-5 articles. Broad, cross-cutting topics.
- Composite 4-5 (LinkedIn): 8-12 articles. Quick-share worthy, nothing more.
- Composite 0-3 (Archive): 15-20 articles. Routine content that does not warrant coverage.

If you score more than 2 articles as 8+ in a batch, you are being too generous.

## Source Type

The source type (Formal / Community / Case Study or Advertorial) is provided. Do NOT override it. Use it as given.

## Scoring Dimensions — BE HARSH

**Audience Fit (0-3)**
- 3: Strategic content that informs how enterprise leaders think about their Microsoft cloud investments — industry trends affecting Azure/M365/D365, architectural patterns, security strategies, AI/Copilot adoption, digital transformation, future of work. Includes authoritative third-party analysis (McKinsey, Gartner, Forrester) on topics directly relevant to Microsoft platform decisions. NOT beginner tutorials.
- 2: Developer or IT-pro content with clear architectural or strategic implications
- 1: Tangentially related. Niche updates or how-to guides without broader strategic context.
- 0: End-user features, consumer products, or pure marketing

**Novelty (0-3)**
- 3: RARE. A brand-new service launch, critical security disclosure (CVE), or fundamental shift in industry thinking that changes how enterprises approach their Microsoft investments. Third-party research revealing a new strategic reality (e.g., "AI is disrupting ERP") counts if genuinely new.
- 2: Meaningful update — GA announcement changing enterprise planning, significant new capability, or fresh perspective on an existing strategic challenge
- 1: Incremental update, best-practice guide, how-to, monthly roundup, or familiar strategic thinking presented again. MOST articles score 1.
- 0: Rehash, old news, documentation rewrite, marketing copy

**Strategic Significance (0-2)**
- 2: RARE. This article represents a strategic conversation that enterprise leaders must engage with — industry shifts affecting Microsoft platform choices (ERP disruption → D365, future of work → M365/Copilot, AI adoption patterns). OR: requires immediate organizational action (security posture update, architectural decision review).
- 1: Useful background, operationally relevant, or confirms existing thinking
- 0: No strategic or operational implication

**Analytical Depth Potential (0-2)**
- 2: Richard could write 800+ words of ORIGINAL analysis connecting this to Microsoft platform strategy, enterprise decision-making, or architectural trade-offs. Third-party research (McKinsey, Gartner) on relevant topics usually has depth potential because Richard can analyze the implications for Microsoft customers. Ask: "What's Richard's angle — the thing he would say that the source doesn't?" If it's clear and substantial, this is a 2.
- 1: Worth a sharp paragraph in a newsletter or LinkedIn post  
- 0: Nothing to say beyond the news itself

COMPOSITE = audienceFit + novelty + strategicSignificance + analyticalDepth. Calculate correctly.

## Platform Routing

Apply the FIRST matching rule:
- **Full Blog Post** — Composite >= 8, analyticalDepth = 2, Formal only. VERY rare.
- **Newsletter Candidate** — Composite 6-7, Formal, topic is broad/cross-cutting
- **Podcast Topic** — Genuine debate or tension, multiple valid perspectives, can sustain 10-15 min. Rare.
- **LinkedIn Standalone** — Composite 4-7, quick-share. Most scored articles land here.
- **Archive** — Composite <= 3, OR audienceFit = 0, OR novelty = 0. MANY articles belong here.

## Spark Flag

Default is FALSE. Only true when the article contains a SPECIFIC data point, statistic, customer example, or counterargument that could be cited verbatim in future content. Vague "useful background" is NOT a spark. Expect ~25% of articles to have sparks, not 95%.

## Output

ONLY valid JSON, no fences:
{"audienceFit":<0-3>,"novelty":<0-3>,"strategicSignificance":<0-2>,"analyticalDepth":<0-2>,"composite":<0-10>,"sourceType":"<as provided>","platform":"<Full Blog Post|Newsletter Candidate|Podcast Topic|LinkedIn Standalone|Archive>","spark":<true|false>,"sparkReason":"<specific cited material or empty string>","explanation":"<one sentence>"}`;
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
