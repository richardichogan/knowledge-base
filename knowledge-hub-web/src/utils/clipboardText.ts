function structuredText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(structuredText).filter(Boolean).join(
    value.some(item => item !== null && typeof item === 'object' && 'content' in item) ? '\n' : '',
  );
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  if (typeof item['text'] === 'string') return item['text'];
  if (item['type'] === 'kh-diagram/v1') return '';
  if (typeof item['body'] === 'string') return item['body'];
  if (typeof item['contentJson'] === 'string') {
    try { return structuredText(JSON.parse(item['contentJson'])); }
    catch (cause) { if (!(cause instanceof SyntaxError)) throw cause; }
  }
  if (item['type'] === 'entityMention' || item['type'] === 'noteMention') {
    const props = item['props'] as Record<string, unknown> | undefined;
    return typeof props?.['label'] === 'string' ? props['label'] : '';
  }
  return ['content', 'children', 'blocks'].map(key => structuredText(item[key])).filter(Boolean).join('\n');
}

export function clipboardHtmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style').forEach(node => { node.remove(); });
  doc.querySelectorAll('br').forEach(node => { node.replaceWith('\n'); });
  doc.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,tr').forEach(node => { node.append('\n'); });
  return doc.body.textContent?.replace(/\n{3,}/g, '\n\n').trim() ?? '';
}

export function readableClipboardText(plain: string, html: string): string {
  let readable = plain;
  const markup = html || (/^\s*<(?:!doctype\s+html|html|body|p|div|ul|ol|h[1-6]|table|blockquote|pre)(?:\s|>)/i.test(plain) ? plain : '');
  if (markup) {
    const text = clipboardHtmlText(markup);
    if (text) readable = text;
  }
  const trimmed = readable.trim();
  if (/^[{[]/.test(trimmed)) {
    try {
      const data: unknown = JSON.parse(trimmed);
      const text = structuredText(data);
      if (text) return text;
    } catch (cause) { if (!(cause instanceof SyntaxError)) throw cause; }
  }
  return readable;
}

export function pasteReadableText(event: React.ClipboardEvent<HTMLElement>): void {
  const field = event.target;
  if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) return;
  const plain = event.clipboardData.getData('text/plain');
  const text = readableClipboardText(plain, event.clipboardData.getData('text/html'));
  if (text === plain) return;
  event.preventDefault();
  event.stopPropagation();
  field.focus();
  if (!document.execCommand('insertText', false, text)) {
    const next = field.value.slice(0, field.selectionStart ?? field.value.length) + text
      + field.value.slice(field.selectionEnd ?? field.value.length);
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, next.slice(0, field.maxLength > 0 ? field.maxLength : undefined));
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
