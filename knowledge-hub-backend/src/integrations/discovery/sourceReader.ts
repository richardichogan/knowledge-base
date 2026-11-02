import { parseFeedXml, type FeedArticle } from './feedReader.js';
import { resolveDiscoveryFeed } from './youtube.js';
import { readSourcePage, readWebsite } from './websiteReader.js';

const FORMAT_PROBE_CHARS = 2_000;

export type DiscoverySourceKind = 'feed' | 'website';
export interface DiscoverySourceRead {
  feedUrl: string;
  sourceKind: DiscoverySourceKind;
  articles: FeedArticle[];
  warning: string | null;
}

/** The form, Athena and scheduled checks use the same detection and validation. */
export async function readDiscoverySource(raw: string, reader = readSourcePage): Promise<DiscoverySourceRead> {
  const feedUrl = await resolveDiscoveryFeed(raw);
  const page = await reader(feedUrl);
  if (/<(rss|feed|rdf:RDF)\b/i.test(page.text.slice(0, FORMAT_PROBE_CHARS))) {
    return { feedUrl, sourceKind: 'feed', articles: parseFeedXml(page.text), warning: null };
  }
  if (!/<!doctype html|<html\b/i.test(page.text.slice(0, FORMAT_PROBE_CHARS))) throw new Error('Not an RSS/Atom feed or a readable HTML blog listing.');
  const result = await readWebsite(page, reader);
  return { feedUrl, sourceKind: 'website', ...result };
}
