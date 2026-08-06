/**
 * Shared BlockNote content helpers.
 *
 * Notes are stored as JSON: { title, contentType, contentJson } where
 * contentJson is a serialised BlockNote block array. These helpers parse
 * that structure, extract plain text, and locate embedded image blocks so
 * their vision analysis can be merged in wherever note content is surfaced
 * (timeline sync, AI chat search results, page-context injection, etc.).
 */

interface BlockContent { text?: string }
interface BlockProps { url?: string }
export interface Block { type?: string; content?: BlockContent[]; children?: Block[]; props?: BlockProps }
interface NoteContentWrapper { title?: string; contentType?: string; contentJson?: string }

export function parseNoteContent(contentJson: string): { title: string | null; blocks: Block[] } {
  try {
    const outer = JSON.parse(contentJson) as unknown;
    // Wrapped format: { title, contentType, contentJson }
    if (outer !== null && typeof outer === 'object' && !Array.isArray(outer)) {
      const wrapper = outer as NoteContentWrapper;
      const title = typeof wrapper.title === 'string' && wrapper.title.trim() !== '' && wrapper.title !== 'Untitled'
        ? wrapper.title.trim()
        : null;
      let blocks: Block[] = [];
      if (typeof wrapper.contentJson === 'string') {
        try {
          const inner = JSON.parse(wrapper.contentJson) as unknown;
          blocks = Array.isArray(inner) ? (inner as Block[]) : [];
        } catch { /* ignore */ }
      }
      return { title, blocks };
    }
    // Raw array format (legacy)
    const blocks = Array.isArray(outer) ? (outer as Block[]) : [];
    return { title: null, blocks };
  } catch {
    return { title: null, blocks: [] };
  }
}

/** Recursively collects `props.url` from every `image` block, including nested children. */
export function extractImageBlockUrls(blocks: Block[]): string[] {
  const urls: string[] = [];
  const walk = (list: Block[]): void => {
    for (const block of list) {
      if (block.type === 'image' && typeof block.props?.url === 'string' && block.props.url !== '') {
        urls.push(block.props.url);
      }
      if (Array.isArray(block.children)) walk(block.children);
    }
  };
  walk(blocks);
  return urls;
}

/**
 * The blob name (== kb_images.id) is the last path segment before the SAS
 * query string, e.g. https://acct.blob.core.windows.net/kb-images/<id>?sv=...
 */
export function blobIdFromUrl(url: string): string {
  const withoutQuery = url.split('?')[0] ?? '';
  const segments = withoutQuery.split('/');
  return segments[segments.length - 1] ?? '';
}

/**
 * Renders blocks as plain text for AI consumption, substituting each image
 * block with its vision analysis (keyed by blob id) when available, so the
 * model actually knows what a pasted diagram/screenshot shows instead of
 * just seeing an opaque image reference.
 */
export function blocksToTextWithImages(blocks: Block[], visionByBlobId: Map<string, string>): string {
  const lines: string[] = [];
  const walk = (list: Block[]): void => {
    for (const block of list) {
      if (block.type === 'image' && typeof block.props?.url === 'string') {
        const analysis = visionByBlobId.get(blobIdFromUrl(block.props.url));
        lines.push(analysis ? `[Image: ${analysis}]` : '[Image: no analysis available]');
      } else {
        const text = (block.content ?? []).map((c) => c.text ?? '').join('').trim();
        if (text) lines.push(text);
      }
      if (Array.isArray(block.children)) walk(block.children);
    }
  };
  walk(blocks);
  return lines.join('\n');
}
