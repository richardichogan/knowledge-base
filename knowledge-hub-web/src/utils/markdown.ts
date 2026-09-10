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
  // Tracks which list type (if any) is currently open, so switching between
  // a bullet list and a numbered list (or ending either) closes the right tag.
  let listType: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listType) { html.push(`</${listType}>`); listType = null; }
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      closeList();
      if (inCode) { html.push('</code></pre></div>'); inCode = false; }
      else { html.push(`<div class="kh-code-block"><button type="button" class="kh-code-copy-btn" data-copy-code>Copy</button><pre><code class="language-${escapeHtml(line.slice(3).trim())}">`); inCode = true; }
      continue;
    }
    if (inCode) { html.push(escapeHtml(line)); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeList();
      html.push('<hr />'); continue;
    }
    const hm = line.match(/^(#{1,6})\s+(.+)/);
    if (hm) {
      closeList();
      html.push(`<h${hm[1]!.length}>${inlineMarkdown(hm[2] ?? '')}</h${hm[1]!.length}>`); continue;
    }
    if (line.startsWith('> ')) {
      closeList();
      html.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`); continue;
    }
    const oli = line.match(/^\s*\d+[.)]\s+(.+)/);
    if (oli) {
      if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; }
      html.push(`<li>${inlineMarkdown(oli[1] ?? '')}</li>`); continue;
    }
    const li = line.match(/^\s*[-*+]\s+(.+)/);
    if (li) {
      if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
      html.push(`<li>${inlineMarkdown(li[1] ?? '')}</li>`); continue;
    }
    if (line.trim() === '') {
      closeList();
      continue;
    }
    closeList();
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  closeList();
  if (inCode) html.push('</code></pre></div>');
  return html.join('\n');
}
