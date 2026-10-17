export const DISCOVER_FORMATS = [
  { id: 'newsletter', label: 'Newsletter' },
  { id: 'podcast', label: 'Microsoft podcast' },
  { id: 'fullBlog', label: 'Full blog post' },
  { id: 'quickBlog', label: 'Quick blog post' },
  { id: 'social', label: 'Social post (LinkedIn, Bluesky)' },
] as const;

export type DiscoverFormat = typeof DISCOVER_FORMATS[number]['id'];
