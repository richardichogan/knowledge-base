import type { PublishingDelivery } from './publishing';

export type EpisodePlatform = 'youtube' | 'spotify' | 'apple';
export type EpisodeLinks = Record<EpisodePlatform, string>;
export interface PodcastPost {
  id: string; destination: 'blog' | 'linkedin' | 'bluesky'; label: string; scheduledAt: string | null;
  copy: string; platform: EpisodePlatform | null; url: string | null;
  blog: { title: string; content: string; summary: string; slug?: string; excerpt: string } | null;
}
export interface PodcastCampaignDetail {
  noteId: string; revision: number; links: EpisodeLinks;
  plan: {
    title: string; notes: string[]; excluded: string[]; posts: PodcastPost[];
    accounts: Record<PodcastPost['destination'], string>; linkedinName: string;
    window?: { from: string; to: string } | null; followUp?: boolean;
  } | null;
  sourceRevision: number | null; state: 'draft' | 'approved' | 'paused'; approvedAt: string | null;
  error: string | null; deliveries: Array<PublishingDelivery & { identity: string }>;
  issues: string[]; sourceChanged: boolean; automaticDelivery: boolean;
}
