/**
 * utils/sanitizeHtml.ts — allowlist sanitiser for HTML we render with
 * dangerouslySetInnerHTML (Athena replies, markdown documents).
 *
 * The markdown renderer passes non-code text through unescaped, and model
 * output can be steered by content it reads (web pages, documents), so the
 * final HTML is filtered here: only known formatting tags and attributes
 * survive, event handlers are dropped, and links must be http(s), mailto,
 * or same-site paths. Uses the browser's own parser — no dependency.
 */

const ALLOWED_TAGS = new Set([
  'A', 'B', 'STRONG', 'I', 'EM', 'CODE', 'PRE', 'P', 'BR', 'HR', 'UL', 'OL', 'LI',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'DIV', 'SPAN', 'BUTTON',
  'DL', 'DT', 'DD', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'DEL', 'SUP', 'SUB',
]);

const ALLOWED_ATTRS = new Set([
  'class', 'href', 'target', 'rel', 'title', 'type', 'disabled', 'start',
  'aria-hidden', 'aria-label', 'data-copy-code', 'data-xlsx-table', 'data-task-action', 'data-task-id',
]);

const SAFE_HREF = /^(https?:|mailto:|\/(?!\/)|#)/i;
const SAFE_IMAGE = /^(https?:|\/(?!\/)|data:image\/(?:png|jpeg|gif|webp);base64,)/i;

function clean(node: Element, documentContent = false): void {
  for (const child of [...node.children]) {
    if (documentContent && child.tagName === 'IMG') {
      const source = child.getAttribute('src')?.trim() ?? '';
      const alt = child.getAttribute('alt') ?? '';
      const image = document.createElement('img');
      image.alt = alt;
      if (SAFE_IMAGE.test(source)) {
        image.src = source;
        image.loading = 'lazy';
        child.replaceWith(image);
      } else child.replaceWith(document.createTextNode(alt || 'Image unavailable in this view.'));
      continue;
    }
    if (documentContent && child.tagName === 'INPUT' && child.getAttribute('type') === 'checkbox') {
      child.replaceWith(document.createTextNode(child.hasAttribute('checked') ? '[x] ' : '[ ] '));
      continue;
    }
    if (!ALLOWED_TAGS.has(child.tagName)) {
      // Drop scripts/styles/iframes/etc. entirely; keep the text of any
      // other unknown element so formatting glitches don't lose content.
      if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'SVG', 'MATH'].includes(child.tagName)) {
        child.remove();
      } else {
        child.replaceWith(document.createTextNode(child.textContent ?? ''));
      }
      continue;
    }
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase();
      if (!ALLOWED_ATTRS.has(name)) { child.removeAttribute(attr.name); continue; }
      if (name === 'href' && !SAFE_HREF.test(attr.value.trim())) child.removeAttribute(attr.name);
    }
    if (child.tagName === 'A' && child.getAttribute('target') === '_blank') {
      child.setAttribute('rel', 'noreferrer noopener');
    }
    clean(child, documentContent);
  }
}

/** Returns `html` with everything outside the formatting allowlist removed. */
export function sanitizeHtml(html: string, options: { documentContent?: boolean } = {}): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  clean(doc.body, options.documentContent);
  return doc.body.innerHTML;
}
