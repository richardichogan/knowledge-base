/**
 * Podcast episode — fields available after parsing the Spotify/Anchor RSS feed
 * and merging with podcast-overrides.json from blob storage.
 */

export interface PodcastEpisode {
  /** From RSS <guid> — stable identifier across platform migrations. */
  id: string;
  /** Generated from title + episode number: ep<N>-<kebab-title> (max 60 chars). */
  slug: string;
  title: string;
  subtitle?: string;
  /** HTML description from RSS. */
  description: string;
  /** Plain text version of description. */
  descriptionText: string;
  /** ISO date string. */
  publishDate: string;
  /** Duration in HH:MM:SS format. */
  duration: string;
  /** Direct mp3 URL. */
  audioUrl: string;
  spotifyUrl: string;
  /** Extracted from description or overrides. */
  youtubeUrl?: string;
  /** From overrides only. */
  appleUrl?: string;
  /** Full episode transcript — from overrides. */
  transcript?: string;
  season?: number;
  episode?: number;
  imageUrl?: string;
  /**
   * ID of the companion CMS show notes post (CmsPost.id).
   * Resolved by matching podcastEpisode field in CMS posts.
   */
  showNotesPostId?: string;
}

/**
 * Override record from content/podcast-overrides.json in blob storage.
 * Merged on top of RSS data — only present fields are applied.
 * Key is the RSS <guid>.
 */
export type PodcastOverrides = Record<string, Partial<Omit<PodcastEpisode, 'id'>>>;
