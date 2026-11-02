import type { PublishingDelivery } from './publishing';

export type EpisodePlatform = 'youtube' | 'spotify' | 'apple';
export type EpisodeLinks = Record<EpisodePlatform, string>;
export interface PodcastPost {
  id: string; destination: 'blog' | 'linkedin' | 'bluesky'; label: string; scheduledAt: string | null;
  copy: string; platform: EpisodePlatform | null; url: string | null;
  sourceCopy?: string;
  blog: { title: string; content: string; summary: string; slug?: string; excerpt: string } | null;
  asset?: { imageId: string; url: string; width: number; height: number; alt: string; sourceHash: string; contentHash: string };
  assetSpec?: { kind: 'quote' | 'launch' | 'teaser' | 'fuller'; headline: string; quote: string | null; speaker: string | null; timestamp: string | null; episodeNumber: number | null };
}
export interface PodcastCampaignDetail {
  noteId: string; revision: number; links: EpisodeLinks;
  plan: {
    title: string; notes: string[]; excluded: string[]; posts: PodcastPost[];
    accounts: Record<PodcastPost['destination'], string>; linkedinName: string;
    window?: { from: string; to: string } | null; followUp?: boolean;
    recordingTease?: boolean; transcriptUploadedAt?: string | null;
    assetsRequired?: boolean;
    reviewRequired?: boolean;
    sequenceRequired?: boolean;
    review?: {
      status: 'pending' | 'pass' | 'fail'; fingerprint: string; reviewer: string | null; checkedAt: string | null;
      findings: Array<{ postId: string | null; message: string }>;
    };
  } | null;
  sourceRevision: number | null; state: 'draft' | 'approved' | 'paused'; approvedAt: string | null;
  error: string | null; deliveries: Array<PublishingDelivery & { identity: string }>;
  issues: string[]; sourceChanged: boolean; automaticDelivery: boolean;
}
