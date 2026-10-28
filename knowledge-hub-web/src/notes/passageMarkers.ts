import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { PASSAGE_TAGS, type PassageTag } from './passageTagModel';

export const passageMarkerKey = new PluginKey<DecorationSet>('note-passage-markers');

function markers(doc: ProseMirrorNode): DecorationSet {
  const ends = new Map<string, { kind: PassageTag; position: number }>();
  doc.descendants((node, pos) => {
    if (!node.isText && !(node.isInline && node.isAtom)) return;
    for (const mark of node.marks) {
      const kind = mark.type.name;
      const id: unknown = mark.attrs['stringValue'];
      if (Object.hasOwn(PASSAGE_TAGS, kind) && typeof id === 'string') {
        ends.set(`${kind}:${id}`, { kind: kind as PassageTag, position: pos + node.nodeSize });
      }
    }
  });
  return DecorationSet.create(doc, [...ends.entries()].map(([key, { kind, position }]) =>
    Decoration.widget(position, () => {
      const marker = document.createElement('span');
      marker.className = 'note-passage-marker';
      marker.textContent = PASSAGE_TAGS[kind].icon;
      marker.title = PASSAGE_TAGS[kind].label;
      marker.setAttribute('aria-label', `${PASSAGE_TAGS[kind].label} passage`);
      marker.setAttribute('role', 'img');
      marker.tabIndex = 0;
      return marker;
    }, { key, side: 1, ignoreSelection: true }),
  ));
}

export function createPassageMarkerPlugin(): Plugin<DecorationSet> {
  return new Plugin({
    key: passageMarkerKey,
    state: {
      init: (_, state) => markers(state.doc),
      apply: (transaction, previous) => transaction.docChanged ? markers(transaction.doc) : previous,
    },
    props: { decorations: state => passageMarkerKey.getState(state) ?? null },
  });
}
