import { createHash } from 'node:crypto';
import { readPublicPage } from '../utils/articleReading.js';
import { ValidationError } from '../types/errors.js';
import type { LearningSource } from './contracts.js';

const MIN_SOURCE_CHARS = 600;
const MAX_SOURCE_CHARS = 100_000;
// These are documentation entry points, not pre-written facts or model-suggested URLs.
export const LEARNING_TOPICS = [
  { id: 'azure-strategy', label: 'Azure adoption strategy', ecosystem: 'Microsoft', url: 'https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/strategy/' },
  { id: 'azure-architecture', label: 'Azure architecture', ecosystem: 'Microsoft', url: 'https://learn.microsoft.com/en-us/azure/well-architected/' },
  { id: 'zero-trust', label: 'Zero Trust', ecosystem: 'Microsoft', url: 'https://learn.microsoft.com/en-us/security/zero-trust/zero-trust-overview' },
  { id: 'microsoft-365-copilot', label: 'Microsoft 365 Copilot', ecosystem: 'Microsoft', url: 'https://learn.microsoft.com/en-us/copilot/microsoft-365/microsoft-365-copilot-overview' },
  { id: 'azure-readiness', label: 'Azure platform readiness', ecosystem: 'Microsoft', url: 'https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/' },
  { id: 'power-platform', label: 'Power Platform', ecosystem: 'Microsoft', url: 'https://learn.microsoft.com/en-us/power-platform/admin/wp-data-loss-prevention' },
  { id: 'github-copilot', label: 'GitHub Copilot', ecosystem: 'GitHub', url: 'https://docs.github.com/en/copilot/get-started/what-is-github-copilot' },
  { id: 'github-security', label: 'GitHub security', ecosystem: 'GitHub', url: 'https://docs.github.com/en/code-security/getting-started/github-security-features' },
  { id: 'github-enterprise', label: 'GitHub Enterprise', ecosystem: 'GitHub', url: 'https://docs.github.com/en/enterprise-cloud@latest/admin/overview/about-enterprise-accounts' },
  { id: 'github-actions', label: 'GitHub Actions', ecosystem: 'GitHub', url: 'https://docs.github.com/en/actions/about-github-actions/understanding-github-actions' },
] as const;
export type LearningTopicId = typeof LEARNING_TOPICS[number]['id'];
export const TOPIC_SOURCE_MAP: Record<string, LearningTopicId> = {
  ...Object.fromEntries(LEARNING_TOPICS.map(topic => [topic.url.replace(/\/$/, ''), topic.id])),
  'https://docs.github.com/en/copilot/get-started/about-github-copilot': 'github-copilot',
  'https://docs.github.com/en/enterprise-cloud@latest/admin/concepts/enterprise-fundamentals/enterprise-accounts': 'github-enterprise',
};
export function learningTopicId(question: { topicId?: string; sources: { url: string }[] }): LearningTopicId {
  const topic = LEARNING_TOPICS.find(item => item.id === question.topicId)
    ?? LEARNING_TOPICS.find(item => question.sources.some(source => TOPIC_SOURCE_MAP[source.url.replace(/\/$/, '')] === item.id));
  if (!topic) throw new ValidationError('The learning question does not have a recognised subject area.');
  return topic.id;
}

export function officialDocumentationUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !['learn.microsoft.com', 'docs.github.com'].includes(url.hostname)
    || !url.pathname.startsWith('/en')) throw new ValidationError('Learning sources must be official English Microsoft Learn or GitHub documentation.');
  url.hash = '';
  return url.toString();
}
export const learningSourceHash = (text: string): string => createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');
export async function fetchLearningSource(url: string): Promise<LearningSource> {
  const requested = officialDocumentationUrl(url);
  const page = await readPublicPage(requested);
  const finalUrl = officialDocumentationUrl(page.finalUrl ?? requested);
  if (page.text.length < MIN_SOURCE_CHARS || page.text.length > MAX_SOURCE_CHARS || /^(access denied|page not found)/i.test(page.title)) {
    throw new ValidationError('The official learning source is missing, blocked or outside the safe reading budget.');
  }
  return { url: finalUrl, title: page.title, text: page.text, hash: learningSourceHash(page.text), checkedAt: new Date().toISOString() };
}
