import type { ResolvedPos } from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';

export function preserveScriptSelection(transaction: Transaction, change: () => void): void {
  const bookmark = (position: ResolvedPos): { id: string; offset: number } | undefined => {
    for (let depth = position.depth; depth > 0; depth--) {
      const node = position.node(depth);
      if (node.type.name === 'blockContainer' && typeof node.attrs['id'] === 'string') {
        return { id: node.attrs['id'], offset: position.pos - position.before(depth) };
      }
    }
    return undefined;
  };
  const { selection } = transaction;
  const anchor = bookmark(selection.$anchor);
  const head = bookmark(selection.$head);
  change();
  if (!anchor || !head || !selection.$anchor.parent.inlineContent || !selection.$head.parent.inlineContent) return;
  let from: number | undefined;
  let to: number | undefined;
  transaction.doc.descendants((node, position) => {
    if (node.type.name !== 'blockContainer') return;
    const end = node.firstChild?.nodeSize ?? node.nodeSize - 2;
    if (node.attrs['id'] === anchor.id) from = position + Math.min(anchor.offset, end);
    if (node.attrs['id'] === head.id) to = position + Math.min(head.offset, end);
  });
  if (from !== undefined && to !== undefined) {
    transaction.setSelection(TextSelection.between(transaction.doc.resolve(from), transaction.doc.resolve(to)));
  }
}
