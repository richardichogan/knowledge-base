export type FeedId = 'bluesky' | 'blog-linkedin';
export interface FeedPolicy {
  timezone: string; startHour: number; endHour: number; days: number[]; expiryHours: number; guidance: string;
}
export interface PublishingFeed { id: FeedId; enabled: boolean; revision: number; policy: FeedPolicy }
export interface ScheduledPost {
  draftId: string; topicId: string; title: string; destination: 'bluesky' | 'blog' | 'linkedin'; version: number;
  scheduledAt: string | null; timezone: string; paused: boolean; reason: string;
}
export interface ScheduledPodcastPost extends Omit<ScheduledPost, 'topicId'> {
  noteId: string; label: string; copy: string;
  blog: { title: string; content: string; summary: string; slug?: string; excerpt: string } | null;
  campaignPaused: boolean; deliveryStatus: 'sending' | 'sent' | 'failed' | 'unconfirmed' | null;
}
export type PublishingScheduleEntry = ScheduledPost | ScheduledPodcastPost;
export interface PublishingDraft {
  id: string; topicId: string; destination: 'bluesky' | 'blog' | 'linkedin'; variant: 'source' | 'blog';
  version: number; content: Record<string, unknown>; review: string; approval: string; held: boolean;
  reason: string; expiresAt: string; reviewedAt: string | null;
}
export interface PublishingTopic {
  id: string; title: string; rationale: string; priority: number; state: string; error: string | null;
  drafts: PublishingDraft[]; deliveries: PublishingDelivery[];
}
export interface PublishingDelivery {
  id: string; destination: string; status: string; account: string; topicId: string | null; draftId: string | null;
  version: number | null; attemptedAt: string; publishedAt: string | null; nextAttemptAt: string | null;
  receipt: Record<string, unknown> | null; error: string | null;
}
export interface PublishingEvent { id: string; actor: string; event: string; detail: unknown; createdAt: string }
export interface PublishingDetail {
  topic: PublishingTopic; drafts: PublishingDraft[]; deliveries: PublishingDelivery[]; events: PublishingEvent[];
  sources: Array<{ itemId: string; title: string; url: string; body: string; readAt: string | null }>;
  versions: Array<{ draft_id: string; version: number; reviews: unknown[]; approved_by: string | null; approved_at: string | null; content: Record<string, unknown> }>;
}
