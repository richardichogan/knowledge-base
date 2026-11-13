
export interface ScriptSectionBlock {
  id?: string;
  type: string;
  props?: { [key: string]: unknown; level?: number; scriptSection?: boolean; scriptDirection?: string };
  content?: unknown;
  children?: ScriptSectionBlock[];
}

/** BlockNote requires an empty root paragraph after a nonempty final card. */
export function splitScriptSectionTail<T extends ScriptSectionBlock>(blocks: T[]): { body: T[]; tail: T[] } {
  const last = blocks.at(-1);
  const trailing = blocks.length > 1 && blocks.some(block => block.type === 'heading')
    && last?.type === 'paragraph' && Array.isArray(last.content) && last.content.length === 0 && !last.children?.length;
  return trailing ? { body: blocks.slice(0, -1), tail: [last] } : { body: blocks, tail: [] };
}

export function splitScriptTitle<T extends ScriptSectionBlock>(blocks: T[]): { title: T[]; body: T[] } {
  const first = blocks[0];
  const standalone = first?.type === 'heading' && first.props?.level === 1 && !first.props.scriptSection
    && !first.children?.length && blocks.slice(1).some(block => block.type === 'heading' && block.props?.scriptSection);
  return standalone ? { title: [first], body: blocks.slice(1) } : { title: [], body: blocks };
}

/** Unwrap only card-owned bodies; ordinary nested lists and headings stay intact. */
export function ungroupScriptSections<T extends ScriptSectionBlock>(blocks: T[]): T[] {
  return blocks.flatMap(block => block.type === 'heading' && block.props?.scriptSection
    ? [{ ...block, children: [] } as T,
      ...ungroupScriptSections((block.children ?? []) as T[])]
    : [block]);
}

/** Existing heading IDs, rich title spans and body block IDs survive card conversion. */
export function groupScriptSections<T extends ScriptSectionBlock>(blocks: T[], createSection: () => T, options: { markedOnly?: boolean } = {}): T[] {
  const { title, body } = splitScriptTitle(blocks);
  const sections: T[] = [];
  for (const block of body) {
    if (block.type === 'heading' && (!options.markedOnly || block.props?.scriptSection)) {
      sections.push({ ...block, props: { ...block.props, scriptSection: true },
        children: [...(block.children ?? [])] });
    } else {
      let section = sections.at(-1);
      if (!section) {
        section = createSection();
        sections.push(section);
      }
      section.children!.push(block);
    }
  }
  if (!sections.length) sections.push(createSection());
  return [...title, ...sections];
}
