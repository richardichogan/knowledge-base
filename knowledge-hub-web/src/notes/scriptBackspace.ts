import { Fragment, type Node } from '@tiptap/pm/model';
import { TextSelection, type Command } from '@tiptap/pm/state';

export const scriptBackspace: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty || selection.$from.parentOffset !== 0
    || selection.$from.parent.type.name !== 'paragraph') return false;
  const { $from } = selection;
  const depth = $from.depth - 1;
  if (depth < 3 || $from.node(depth).type.name !== 'blockContainer'
    || $from.node(depth - 1).type.name !== 'blockGroup'
    || $from.node(depth - 2).firstChild?.attrs['scriptSection'] !== true) return false;

  // The card body is structural, not a list level that Backspace should lift.
  const index = $from.index(depth - 1);
  if (index === 0) return true;
  const group = $from.node(depth - 1);
  const previous = group.child(index - 1);
  const current = $from.node(depth);
  let cursorOffset = 0;
  const append = (block: Node, offset: number): Node | undefined => {
    const children = block.childCount > 1 ? block.lastChild : null;
    if (children?.type.name === 'blockGroup') {
      const last = children.lastChild;
      if (!last) return undefined;
      const lastOffset = children.content.size - last.nodeSize;
      const updated = append(last, offset + 1 + block.firstChild!.nodeSize + 1 + lastOffset);
      if (!updated) return undefined;
      return block.copy(Fragment.fromArray([
        block.firstChild!,
        children.copy(children.content.cut(0, lastOffset).append(Fragment.from(updated))),
      ]));
    }
    const content = block.firstChild;
    if (!content?.isTextblock || !current.firstChild) return undefined;
    cursorOffset = offset + 2 + content.content.size;
    return block.copy(Fragment.from(content.copy(content.content.append(current.firstChild.content))));
  };
  const merged = append(previous, 0);
  if (!merged) return true;
  if (dispatch) {
    const before = $from.before(depth) - previous.nodeSize;
    const promoted = current.childCount > 1 ? current.lastChild!.content : Fragment.empty;
    const transaction = state.tr.replaceWith(before, $from.after(depth), Fragment.from(merged).append(promoted));
    transaction.setSelection(TextSelection.create(transaction.doc, before + cursorOffset));
    dispatch(transaction.scrollIntoView());
  }
  return true;
};
