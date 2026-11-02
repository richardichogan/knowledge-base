export interface DiscoverPick {
  id: string; title: string; url: string | null; source: string;
  workflowState: 'to-review' | 'saved'; publishedAt: string | null; angle: string;
}
export interface DiscoverPicks {
  generatedAt: string; trigger: 'job' | 'manual' | 'athena';
  picks: DiscoverPick[]; removed: number; note: string | null;
}
export interface DiscoverPicksResponse { picks: DiscoverPicks | null; running: boolean }
