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
  'aria-hidden', 'aria-label', 'data-copy-code', 'data-task-action', 'data-task-id',
]);

const SAFE_HREF = /^(https?:|mailto:|\/(?!\/)|#)/i;

function clean(node: Element): void {
  for (const child of [...node.children]) {
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
    clean(child);
  }
}

/** Returns `html` with everything outside the formatting allowlist removed. */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  clean(doc.body);
  return doc.body.innerHTML;
}
