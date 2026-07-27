/**
 * Minimal, dependency-free markdown → HTML renderer.
 * Supports headings, bold/italic emphasis, inline code, links, fenced code
 * blocks, blockquotes, horizontal rules, and bullet lists — enough for
 * GitHub-flavoured project docs and AI chat replies.
 *
 * Shared by DocumentsPage (Library viewer) and AIChatPage (chat bubbles) so
 * both surfaces render markdown identically.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let inCode = false;
  let inList = false;

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inList) { html.push('</ul>'); inList = false; }
      if (inCode) { html.push('</code></pre></div>'); inCode = false; }
      else { html.push(`<div class="kh-code-block"><button type="button" class="kh-code-copy-btn" data-copy-code>Copy</button><pre><code class="language-${escapeHtml(line.slice(3).trim())}">`); inCode = true; }
      continue;
    }
    if (inCode) { html.push(escapeHtml(line)); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push('<hr />'); continue;
    }
    const hm = line.match(/^(#{1,6})\s+(.+)/);
    if (hm) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<h${hm[1]!.length}>${inlineMarkdown(hm[2] ?? '')}</h${hm[1]!.length}>`); continue;
    }
    if (line.startsWith('> ')) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`); continue;
    }
    const li = line.match(/^\s*[-*+]\s+(.+)/);
    if (li) {
      if (!inList) { html.push('<ul>'); inList = true; }
      html.push(`<li>${inlineMarkdown(li[1] ?? '')}</li>`); continue;
    }
    if (line.trim() === '') {
      if (inList) { html.push('</ul>'); inList = false; }
      continue;
    }
    if (inList) { html.push('</ul>'); inList = false; }
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  if (inList) html.push('</ul>');
  if (inCode) html.push('</code></pre></div>');
  return html.join('\n');
}
