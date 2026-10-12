import React, { useLayoutEffect, useMemo, useState } from 'react';
import { useCreateBlockNote } from '@blocknote/react';
import type { PartialBlock } from '@blocknote/core';
import { BlockNoteViewWrapper } from './BlockNoteViewWrapper';
import { editorSchema } from './editorSchema';
import { BLOCKNOTE_G100_THEME } from './constants';
import type { NoteVersion } from '../services/api';

class RecoveryBoundary extends React.Component<{ children: React.ReactNode; onFailure: () => void; stem: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  componentDidCatch(error: Error): void { console.error('[Think recovery] Writing preview failed.', error); this.props.onFailure(); }
  render(): React.ReactNode {
    return this.state.failed ? <p role="alert" className={`${this.props.stem}__error`}>This writing cannot be displayed by the current editor. Restore is disabled; its stored JSON is unchanged.</p> : this.props.children;
  }
}
function recoveryBlocks(raw: string): PartialBlock[] {
  const blocks: unknown = JSON.parse(raw);
  function validate(value: unknown): void {
    if (!Array.isArray(value)) throw new Error('Stored writing must be a block array.');
    for (const block of value) {
      if (typeof block !== 'object' || block === null || Array.isArray(block)) throw new Error('Stored writing contains an unsupported block.');
      const fields = block as Record<string, unknown>;
      const type = fields['type'] === undefined ? 'paragraph' : fields['type'];
      if (typeof type !== 'string' || !Object.hasOwn(editorSchema.blockSchema, type)) throw new Error('Stored writing contains an unsupported block type.');
      if (fields['children'] !== undefined) validate(fields['children']);
    }
  }
  validate(blocks);
  return blocks as PartialBlock[];
}
function PreviewBody({ writing, blocks, stem }: { writing: NoteVersion['writing']; blocks: PartialBlock[]; stem: string }): React.ReactElement {
  const editor = useCreateBlockNote({ schema: editorSchema, initialContent: blocks.length ? blocks : [{ type: 'paragraph', content: '' }] });
  const [missingImage, setMissingImage] = useState(false);
  return <div className={`${stem}__preview`} onErrorCapture={event => {
    if (event.target instanceof HTMLImageElement) setMissingImage(true);
  }}>
    <h3>{writing.title}</h3>
    <p className={`${stem}__type`}>{writing.contentType}</p>
    {missingImage && <p role="status" className={`${stem}__error`}>An image is unavailable. Recovery retains references, not image files.</p>}
    <BlockNoteViewWrapper editor={editor} theme={BLOCKNOTE_G100_THEME} editable={false} />
  </div>;
}
export const NoteRecoveryPreview: React.FC<{ writing: NoteVersion['writing']; onFailure: () => void; variant?: 'history' | 'recovery' }> = ({ writing, onFailure, variant = 'recovery' }) => {
  const stem = variant === 'history' ? 'note-history' : 'note-recovery';
  const parsed = useMemo(() => {
    try { return { blocks: recoveryBlocks(writing.contentJson), error: null }; }
    catch (error) { return { blocks: [], error: error instanceof Error ? error : new Error('Stored writing cannot be previewed.') }; }
  }, [writing.contentJson]);
  useLayoutEffect(() => {
    if (parsed.error) { console.error('[Think recovery] Writing preview is unavailable.', parsed.error); onFailure(); }
  }, [parsed.error, onFailure]);
  if (parsed.error) return <p role="alert" className={`${stem}__error`}>{parsed.error.message} Restore is disabled; exact stored JSON is unchanged.</p>;
  return <RecoveryBoundary stem={stem} onFailure={onFailure}><PreviewBody writing={writing} blocks={parsed.blocks} stem={stem} /></RecoveryBoundary>;
};
