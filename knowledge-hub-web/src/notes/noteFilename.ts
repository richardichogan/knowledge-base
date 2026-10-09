const MAX_FILENAME_STEM_LENGTH = 180;

export function noteFilename(title: string): string {
  const stem = title.trim().normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '').toLowerCase()
    .slice(0, MAX_FILENAME_STEM_LENGTH).replace(/[\uD800-\uDBFF]$/u, '').replace(/-+$/g, '');
  return `${stem || 'untitled-note'}.md`;
}
