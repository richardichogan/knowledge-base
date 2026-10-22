import type { Pool } from 'pg';
import { readYouTubeVideo, type YouTubeVideo } from './youtube.js';
import { callTavilyMcpTool, getTavilyMcpTools, isTavilyEnabled } from '../../ai/tavilyMcpClient.js';
import { parseTavilySearch, type WebSearchHit } from '../../ai/digestWebSearch.js';

const MAX_RESULTS = 3;
const BACKGROUND_BATCH = 5;
const EVIDENCE_VERSION = 1;
const MAX_QUERY_TITLE = 200;
const MAX_QUERY_CHANNEL = 100;

interface SubjectSearch {
  status: 'not-configured' | 'retrieved' | 'no-results' | 'failed';
  sources: WebSearchHit[];
}

/** One existing-provider lookup using only public video metadata. */
export async function searchYouTubeSubject(query: string): Promise<SubjectSearch> {
  if (!isTavilyEnabled()) return { status: 'not-configured', sources: [] };
  const tool = (await getTavilyMcpTools()).find(t => /tavily[-_]search$/.test(t.function.name));
  if (!tool) throw new Error('Search tool unavailable.');
  const props = (tool.function.parameters as { properties?: Record<string, unknown> }).properties ?? {};
  const result = await callTavilyMcpTool(tool.function.name, {
    query, ...('max_results' in props ? { max_results: MAX_RESULTS } : {}),
  });
  if (result && typeof result === 'object' && 'error' in result) throw new Error('Subject search failed.');
  const seen = new Set<string>();
  const sources = parseTavilySearch(result).filter(hit => {
    let url: URL;
    try { url = new URL(hit.url); } catch { return false; }
    if (url.username || url.password || ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'].includes(url.hostname)) return false;
    if (!hit.content || seen.has(hit.url)) return false;
    seen.add(hit.url);
    return true;
  }).slice(0, MAX_RESULTS);
  return { status: sources.length ? 'retrieved' : 'no-results', sources };
}

/** Public secondary sources are background about the subject, never evidence of what a video said. */
export interface YouTubeEvidence {
  body: string;
  metadata: Record<string, unknown>;
}

/** Safe, bounded related-reading projection for the Discover API. */
export function relatedYouTubeArticles(metadata: Record<string, unknown>): Array<{ title: string; url: string }> {
  const research = metadata['secondaryResearch'];
  if (!research || typeof research !== 'object' || !('sources' in research) || !Array.isArray(research.sources)) return [];
  return research.sources.flatMap((source: unknown) => {
    if (!source || typeof source !== 'object' || !('title' in source) || typeof source.title !== 'string'
      || !('url' in source) || typeof source.url !== 'string') return [];
    try {
      const url = new URL(source.url);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        ? [{ title: source.title, url: url.toString() }] : [];
    } catch { return []; }
  }).slice(0, MAX_RESULTS);
}

/** Attempts captions, then one secondary subject search only when captions could not be retrieved. */
export async function collectYouTubeEvidence(video: YouTubeVideo, search = searchYouTubeSubject): Promise<YouTubeEvidence> {
  const transcript = video.transcript;
  let researchStatus: 'not-needed' | 'not-configured' | 'retrieved' | 'no-results' | 'failed' =
    transcript?.status === 'retrieved' ? 'not-needed' : 'not-configured';
  let sources: WebSearchHit[] = [];
  const query = `${video.title.slice(0, MAX_QUERY_TITLE)} ${video.channel.slice(0, MAX_QUERY_CHANNEL)} explained`;
  if (transcript?.status !== 'retrieved') {
    try {
      const result = await search(query);
      sources = result.sources;
      researchStatus = result.status;
    } catch {
      researchStatus = 'failed';
      console.warn('[YouTube] Secondary subject search failed; no external context will be claimed.');
    }
  }
  const context = sources.length ? `\n\nSecondary background sources about the subject (search excerpts, NOT a transcript or proof of what the video says; identity may be ambiguous; cite each URL separately):\n${sources.map(s => `${s.title}\n${s.url}\n${s.content}`).join('\n\n')}` : '';
  return {
    body: `${video.summary}${context}`,
    metadata: {
      contentBasis: transcript?.status === 'retrieved' ? 'captions' : 'description-only',
      transcriptStatus: transcript?.status ?? 'not-retrieved',
      transcriptLanguage: transcript?.language ?? null, transcriptAutomatic: transcript?.automatic ?? null,
      transcriptTruncated: transcript?.truncated ?? false,
      youtubeEvidenceVersion: EVIDENCE_VERSION, youtubeEvidenceAt: new Date().toISOString(),
      secondaryResearch: { status: researchStatus, query, sources },
    },
  };
}

/** Stores evidence without replacing workflow state, scoring or other concurrent metadata edits. */
export async function saveYouTubeEvidence(db: Pool, id: string, evidence: YouTubeEvidence): Promise<void> {
  await db.query(`UPDATE content_items SET body=$2, metadata=metadata || $3::jsonb,
    foundry_indexed_at=NULL, updated_at=NOW() WHERE id=$1 AND source='discovered-article'`,
  [id, evidence.body, JSON.stringify(evidence.metadata)]);
}

/** Bounded production sync work also covers older description-only imports, sequentially. */
export async function enrichPendingYouTubeVideos(db: Pool, read = readYouTubeVideo): Promise<void> {
  const { rows } = await db.query<{ id: string; url: string }>(`SELECT id::text, url FROM content_items
    WHERE source='discovered-article' AND metadata->>'contentKind'='youtube-video'
      AND COALESCE((metadata->>'youtubeEvidenceVersion')::int, 0) < $1
      AND COALESCE((metadata->>'youtubeEvidenceAttempts')::int, 0) < 2
    ORDER BY published_at DESC LIMIT $2`, [EVIDENCE_VERSION, BACKGROUND_BATCH]);
  for (const row of rows) {
    try {
      await saveYouTubeEvidence(db, row.id, await collectYouTubeEvidence(await read(row.url)));
    } catch {
      console.warn(`[YouTube] Evidence enrichment failed for item ${row.id}.`);
      await db.query(`UPDATE content_items SET metadata=metadata || jsonb_build_object(
        'youtubeEvidenceAttempts', COALESCE((metadata->>'youtubeEvidenceAttempts')::int,0)+1,
        'transcriptStatus','failed') WHERE id=$1`, [row.id]);
    }
  }
}
