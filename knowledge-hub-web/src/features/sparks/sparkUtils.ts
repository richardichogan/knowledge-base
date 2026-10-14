/**
 * features/sparks/sparkUtils.ts
 * Shared helpers for the Sparks views: links to sources and outputs, labels, Athena prompts.
 */
import type { Spark, SparkCluster, SparkOutputType } from '../../services/api';

export const OUTPUT_LABELS: Record<SparkOutputType, string> = {
  note: 'Note', blog: 'Blog post', canvas: 'Canvas', project: 'Project',
};

export function formatSparkDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** In-app path (starts with "/") or external URL for a spark's source, or null when it can't be opened. */
export function sparkSourceHref(spark: Spark): string | null {
  if (spark.sourceId === null) return null;
  if (spark.sourceType === 'note') return `/think?noteId=${encodeURIComponent(spark.sourceId)}`;
  if (spark.sourceType === 'discover_item') return '/discover';
  return null;
}

/** Opens an in-app path with `navigate`, or an external URL in a new tab. */
export function openHref(href: string, navigate: (to: string) => void): void {
  if (href.startsWith('/')) navigate(href);
  else window.open(href, '_blank', 'noopener,noreferrer');
}

export function themeOutputHref(theme: SparkCluster): string | null {
  if (theme.outputUrl) return theme.outputUrl;
  if (theme.outputRef === null) return null;
  if (theme.outputType === 'note') return `/think?noteId=${encodeURIComponent(theme.outputRef)}`;
  if (theme.outputType === 'canvas') return `/think?mapId=${encodeURIComponent(theme.outputRef)}`;
  if (theme.outputType === 'project') return '/projects';
  return null;
}

function ideaLine(s: Spark): string {
  return `- ${s.body.replace(/\s+/g, ' ').trim()}${s.sourceTitle ? ` (from: ${s.sourceTitle})` : ''}`;
}

/** The prompt that "Develop with Athena" puts into the Athena side panel. */
export function developPrompt(theme: SparkCluster): string {
  return [
    `Help me develop my Spark theme "${theme.theme}". These are the ${theme.sparks.length} ideas I've captured on it:`,
    ...theme.sparks.map(ideaLine),
    '',
    'Find the thread that connects them and the strongest angle, tell me what is missing or worth checking, and recommend the best thing to turn this into (a note, a blog post, a canvas or a project) with a first outline.',
  ].join('\n');
}

/** Short, model-facing summary of the Sparks page for Athena's page context. */
export function sparksContextDetail(themes: SparkCluster[], loose: Spark[]): string {
  const active = themes.filter((t) => t.status === 'active');
  const developed = themes.filter((t) => t.status === 'developed');
  const lines = [
    'The Sparks page: an incubator for captured ideas. Related sparks are grouped into themes, which grow as new sparks arrive and can be turned into a note, blog post, canvas or project.',
  ];
  if (active.length > 0) {
    lines.push('', 'Growing themes:');
    for (const t of active.slice(0, 8)) {
      lines.push(`* ${t.theme} (${t.sparks.length} sparks)`, ...t.sparks.slice(0, 6).map((s) => `  ${ideaLine(s)}`));
    }
  }
  if (developed.length > 0) {
    lines.push('', 'Developed themes:');
    for (const t of developed.slice(0, 8)) {
      lines.push(`* ${t.theme} → ${t.outputType ? OUTPUT_LABELS[t.outputType] : 'output'}: ${t.outputTitle ?? ''}${t.newSinceDeveloped > 0 ? ` (+${t.newSinceDeveloped} new sparks since)` : ''}`);
    }
  }
  if (loose.length > 0) {
    lines.push('', 'Recent loose sparks (not in a theme yet):', ...loose.slice(0, 10).map(ideaLine));
  }
  return lines.join('\n');
}
