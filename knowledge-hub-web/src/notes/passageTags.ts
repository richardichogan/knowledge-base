import { createStyleSpec } from '@blocknote/core';
import { PASSAGE_TAGS, passageTagKeys, type PassageTag } from './passageTagModel';
export { PASSAGE_TAGS, type PassageTag } from './passageTagModel';

function passageStyle<T extends PassageTag>(type: T) {
  return createStyleSpec({ type, propSchema: 'string' }, {
    render: id => {
      const dom = document.createElement('span');
      dom.dataset.passageTag = type;
      dom.dataset.passageId = id;
      dom.dataset.passageIcon = PASSAGE_TAGS[type].icon;
      dom.title = PASSAGE_TAGS[type].label;
      dom.setAttribute('aria-description', `${PASSAGE_TAGS[type].label} passage`);
      dom.tabIndex = 0;
      return { dom, contentDOM: dom };
    },
    toExternalHTML: () => {
      const dom = document.createElement('span');
      return { dom, contentDOM: dom };
    },
  });
}

export const passageTagStyles = {
  important: passageStyle('important'),
  followUp: passageStyle('followUp'),
  question: passageStyle('question'),
  risk: passageStyle('risk'),
  issue: passageStyle('issue'),
};

/** Give copied passages independent identities while preserving a moved passage's existing identity. */
export function prepareTaggedPaste(html: string, document: unknown): { html: string; followUpIds: string[] } | null {
  if (!html.includes('data-style-type')) return null;
  const existing = passageTagKeys(document);
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const replacements = new Map<string, string>();
  const followUpIds = new Set<string>();
  let tagged = false;
  for (const element of parsed.querySelectorAll<HTMLElement>('[data-style-type][data-value]')) {
    const kind = element.dataset.styleType;
    const id = element.dataset.value;
    if (!kind || !(kind in PASSAGE_TAGS) || !id) continue;
    tagged = true;
    const key = `${kind}:${id}`;
    if (!replacements.has(key)) {
      const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      replacements.set(key, existing.has(key) || !valid ? crypto.randomUUID() : id);
    }
    const next = replacements.get(key)!;
    element.dataset.value = next;
    if (element.dataset.passageId) element.dataset.passageId = next;
    if (kind === 'followUp') followUpIds.add(next);
  }
  return tagged ? { html: parsed.body.innerHTML, followUpIds: [...followUpIds] } : null;
}
