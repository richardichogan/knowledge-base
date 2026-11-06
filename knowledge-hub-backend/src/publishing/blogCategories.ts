import { resolveBlogCategory } from '../ai/blogHouseStyle.js';

export function normalisePublishingBlogCategories(content: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(content.categories)) return content;

  const categories: string[] = [];
  const moved: string[] = [];
  for (const value of content.categories) {
    if (typeof value !== 'string') return content;
    if (!value.trim()) continue;
    const category = resolveBlogCategory(value)
      ?? (value.trim().toLowerCase() === 'azure' ? 'Microsoft Azure' : undefined);
    if (category) {
      if (!categories.includes(category)) categories.push(category);
    } else {
      moved.push(value.trim());
    }
  }
  if (!moved.length) return { ...content, categories };
  if (content.tags !== undefined && !Array.isArray(content.tags)) return content;
  const tags: unknown[] = Array.isArray(content.tags) ? Array.from<unknown>(content.tags) : [];
  for (const tag of moved) {
    if (!tags.some(existing => typeof existing === 'string' && existing.trim().toLowerCase() === tag.toLowerCase())) {
      tags.push(tag);
    }
  }
  return { ...content, categories, tags };
}
