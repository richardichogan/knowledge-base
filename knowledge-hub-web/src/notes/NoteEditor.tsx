/**
 * notes/NoteEditor.tsx — BlockNote editor canvas with autosave, top bar,
 * bottom toolbar, right metadata panel, and GitHub push modal.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteSchema, defaultBlockSpecs, createCodeBlockSpec } from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';
import '@blocknote/mantine/style.css';
import { toPng } from 'html-to-image';
import { BlockNoteViewWrapper } from './BlockNoteViewWrapper';
import { GitHubModal } from './GitHubModal';
import { setActiveBlockNoteEditor } from '../utils/activeBlockNoteEditor';
import { TrashCan, Export, DocumentExport, Image as ImageIcon } from '@carbon/icons-react';
import { pushToGitHub } from './githubSync';
import { saveNote } from './noteStorage';
import { api } from '../services/api';
import {
  AUTOSAVE_INTERVAL_MS,
  SAVED_BANNER_DURATION_MS,
  BLOCKNOTE_G100_THEME,
  UNTITLED_DOCUMENT,
} from './constants';
import type { ContentType } from './constants';
import type { NoteDocument } from './types';
import { useNoteTags, useSetNoteTags, useFlatTags } from '../hooks/useTaxonomy';
import { MetadataPanel } from './MetadataPanel';

interface NoteEditorProps {
  doc: NoteDocument;
  onSaved: (updated: NoteDocument) => void;
  onDelete?: (id: string) => void;
}

// Default schema with the codeBlock spec swapped for one with shiki syntax
// highlighting and the full supported-language list from @blocknote/code-block.
// Cast needed: defaultBlockSpecs doesn't satisfy the BlockSpecs index signature
// under exactOptionalPropertyTypes (known BlockNote typing gap). Runtime shape is
// identical to the default schema, so we type it as such.
const editorSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any) as ReturnType<typeof BlockNoteSchema.create>;

function extractTitle(blocks: { type: string; content?: unknown }[]): string {
  for (const block of blocks) {
    if (block.type === 'heading') {
      const content = block.content;
      if (Array.isArray(content)) {
        const text = (content as { text?: string }[])
          .map((c) => c.text ?? '')
          .join('');
        if (text.trim() !== '') return text.trim();
      }
    }
  }
  return UNTITLED_DOCUMENT;
}

function extractPlainText(blocks: { type: string; content?: unknown; children?: unknown[] }[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (Array.isArray(block.content)) {
      const text = (block.content as { text?: string }[]).map((c) => c.text ?? '').join('');
      if (text.trim()) parts.push(text.trim());
    }
    if (Array.isArray(block.children)) {
      parts.push(extractPlainText(block.children as typeof blocks));
    }
  }
  return parts.join(' ');
}

/** Detects whether pasted plain text looks like source code rather than prose. */
function detectPastedCode(text: string): { isCode: boolean; language: string; formatted: string } {
  const trimmed = text.trim();

  // Valid JSON → pretty-print it
  if (/^[[{]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return { isCode: true, language: 'json', formatted: JSON.stringify(parsed, null, 2) };
    } catch { /* fall through to heuristics */ }
  }

  // Obvious signatures
  if (/^<\?xml/i.test(trimmed)) return { isCode: true, language: 'xml', formatted: trimmed };
  if (/^#!\s*\/(usr\/)?bin\//.test(trimmed)) return { isCode: true, language: 'shellscript', formatted: trimmed };
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s/i.test(trimmed) && /;\s*$/m.test(trimmed)) {
    return { isCode: true, language: 'sql', formatted: trimmed };
  }

  // General heuristic: multi-line + indentation + high code-punctuation density
  const lines = trimmed.split('\n');
  if (lines.length >= 3) {
    const indented = lines.filter((l) => /^(\s{2,}|\t)/.test(l)).length;
    const punct = (trimmed.match(/[{}();=<>[\]]|=>|::|->/g) ?? []).length;
    const punctDensity = punct / trimmed.length;
    if (indented / lines.length >= 0.3 && punctDensity >= 0.02) {
      let language = 'text';
      if (/\b(function|const|let|=>|import\s.+from)\b/.test(trimmed)) language = 'typescript';
      else if (/\b(def |import |print\()/.test(trimmed)) language = 'python';
      else if (/^[\w-]+:\s/m.test(trimmed) && !/[{;]/.test(trimmed)) language = 'yaml';
      return { isCode: true, language, formatted: trimmed };
    }
  }

  return { isCode: false, language: 'text', formatted: text };
}

export const NoteEditor: React.FC<NoteEditorProps> = ({ doc, onSaved, onDelete }) => {
  const [contentType, setContentType] = useState<ContentType>(doc.contentType);
  const [githubModalOpen, setGithubModalOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const editorScrollRef = useRef<HTMLDivElement>(null);

  // Taxonomy tags for this note
  const { data: noteTagObjects = [] } = useNoteTags(doc.id);
  const setNoteTagsMutation = useSetNoteTags(doc.id);
  const taxonomyTagIds = noteTagObjects.map((t) => t.id);
  const flatTags = useFlatTags();
  const [notification, setNotification] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);
  const [githubPath, setGithubPath] = useState<string | undefined>(doc.githubPath);

  const savedDocRef = useRef<NoteDocument>(doc);
  const contentTypeRef = useRef<ContentType>(doc.contentType);
  const githubPathRef = useRef<string | undefined>(doc.githubPath);
  const onSavedRef = useRef<(updated: NoteDocument) => void>(onSaved);

  useEffect(() => { contentTypeRef.current = contentType; }, [contentType]);
  useEffect(() => { githubPathRef.current = githubPath; }, [githubPath]);
  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);

  let parsedInitial: object[] | undefined;
  try {
    const parsed = JSON.parse(doc.contentJson) as unknown;
    parsedInitial = Array.isArray(parsed) && parsed.length > 0 ? (parsed as object[]) : undefined;
  } catch {
    parsedInitial = undefined;
  }

  const editor = useCreateBlockNote(
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      initialContent: parsedInitial as any,
      schema: editorSchema,
      pasteHandler: ({ event, editor: ed, defaultPasteHandler }) => {
        const plain = event.clipboardData?.getData('text/plain');
        const html = event.clipboardData?.getData('text/html');
        // Only intercept plain-text pastes (no rich HTML source)
        if (plain && !html) {
          const cursorBlock = ed.getTextCursorPosition().block;
          // Pasting inside an existing code block: insert raw text unchanged
          if (cursorBlock.type === 'codeBlock') {
            ed.insertInlineContent([plain]);
            return true;
          }
          const detected = detectPastedCode(plain);
          if (detected.isCode) {
            ed.insertBlocks(
              [{ type: 'codeBlock', props: { language: detected.language }, content: detected.formatted }],
              cursorBlock,
              'after',
            );
            return true;
          }
        }
        return defaultPasteHandler();
      },
      uploadFile: async (file: File): Promise<string> => {
        // Upload to Azure Blob Storage via the dedicated /api/images endpoint and
        // use the returned (small) SAS URL — do NOT inline images as base64 data
        // URLs, since that bloats contentJson past the backend's 1MB body limit
        // and causes note saves to fail with a 413.
        try {
          const result = await api.uploadImage(file);
          if (!result.success) {
            throw new Error(result.error.message);
          }
          return result.data.blobUrl;
        } catch (err) {
          setNotification({
            kind: 'error',
            msg: err instanceof Error ? `Image upload failed: ${err.message}` : 'Image upload failed',
          });
          setTimeout(() => { setNotification(null); }, SAVED_BANNER_DURATION_MS * 2);
          throw err;
        }
      },
    },
    [doc.id],
  );

  const editorRef = useRef(editor);
  useEffect(() => { editorRef.current = editor; }, [editor]);

  // Register as the "active" BlockNote editor so the global right-click menu
  // can read table/text selections directly from the editor (native
  // window.getSelection() doesn't reflect ProseMirror table cell selections).
  useEffect(() => {
    setActiveBlockNoteEditor(editor);
    return () => { setActiveBlockNoteEditor(null); };
  }, [editor]);

  const isDirtyRef = useRef(false);

  // Formatting toolbar — tracks the block type / inline styles at the cursor so
  // the bottom toolbar buttons can toggle formatting and show their active state.
  interface ToolbarState {
    blockType: string;
    level?: number;
    bold: boolean;
    italic: boolean;
  }
  const [toolbarState, setToolbarState] = useState<ToolbarState>({ blockType: 'paragraph', bold: false, italic: false });

  const updateToolbarState = useCallback(() => {
    const ed = editorRef.current;
    const block = ed.getTextCursorPosition().block;
    const styles = ed.getActiveStyles();
    const level = (block.props as { level?: number }).level;
    setToolbarState({
      blockType: block.type,
      ...(level !== undefined && { level }),
      bold: Boolean(styles.bold),
      italic: Boolean(styles.italic),
    });
  }, []);

  const toggleHeading = useCallback((level: 1 | 2): void => {
    const ed = editorRef.current;
    const block = ed.getTextCursorPosition().block;
    const isActive = block.type === 'heading' && (block.props as { level?: number }).level === level;
    ed.updateBlock(block, isActive ? { type: 'paragraph' } : { type: 'heading', props: { level } });
    ed.focus();
    updateToolbarState();
    isDirtyRef.current = true;
  }, [updateToolbarState]);

  const toggleBlockType = useCallback((type: 'bulletListItem' | 'numberedListItem' | 'checkListItem' | 'codeBlock' | 'quote'): void => {
    const ed = editorRef.current;
    const block = ed.getTextCursorPosition().block;
    const isActive = block.type === type;
    ed.updateBlock(block, isActive ? { type: 'paragraph' } : { type });
    ed.focus();
    updateToolbarState();
    isDirtyRef.current = true;
  }, [updateToolbarState]);

  const toggleInlineStyle = useCallback((style: 'bold' | 'italic'): void => {
    const ed = editorRef.current;
    ed.toggleStyles({ [style]: true });
    ed.focus();
    updateToolbarState();
    isDirtyRef.current = true;
  }, [updateToolbarState]);

  // Word count + reading time + block count
  const [wordCount, setWordCount] = useState(0);
  const [blockCount, setBlockCount] = useState(0);
  const readingTime = Math.max(1, Math.round(wordCount / 200));

  const updateStats = useCallback(() => {
    const blocks = editorRef.current.document as { type: string; content?: unknown; children?: unknown[] }[];
    const text = extractPlainText(blocks);
    const wc = text.split(/\s+/).filter(Boolean).length;
    setWordCount(wc);
    setBlockCount(blocks.length);
  }, []);

  const doSave = useCallback(async () => {
    if (!isDirtyRef.current) return;
    isDirtyRef.current = false;
    const currentEditor = editorRef.current;
    const blocks = currentEditor.document as { type: string; content?: unknown }[];
    const title = extractTitle(blocks);
    const contentJson = JSON.stringify(currentEditor.document);
    const updated: NoteDocument = {
      ...savedDocRef.current,
      title,
      contentType: contentTypeRef.current,
      contentJson,
      ...(githubPathRef.current !== undefined && { githubPath: githubPathRef.current }),
    };
    const ok = await saveNote(updated).catch((err: unknown) => {
      console.error('[NoteEditor] save failed:', err);
      return false;
    });
    if (ok) {
      savedDocRef.current = updated;
      onSavedRef.current(updated);
      setNotification({ kind: 'success', msg: 'Saved' });
      setTimeout(() => { setNotification(null); }, SAVED_BANNER_DURATION_MS);
    } else {
      isDirtyRef.current = true;
      setNotification({ kind: 'error', msg: 'Save failed — will retry' });
      setTimeout(() => { setNotification(null); }, SAVED_BANNER_DURATION_MS * 2);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = editor.onChange(() => {
      isDirtyRef.current = true;
      updateStats();
      updateToolbarState();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { void doSave(); }, 3_000);
    });
    updateStats(); // initial
    return () => {
      unsubscribe();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    };
  }, [editor, doSave, updateStats, updateToolbarState]);

  useEffect(() => {
    const unsubscribe = editor.onSelectionChange(() => { updateToolbarState(); });
    updateToolbarState(); // initial
    return () => { unsubscribe(); };
  }, [editor, updateToolbarState]);

  useEffect(() => {
    const timer = setInterval(() => { void doSave(); }, AUTOSAVE_INTERVAL_MS);
    return () => { clearInterval(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!exportMenuOpen) return;
    const close = (e: MouseEvent): void => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) setExportMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [exportMenuOpen]);

  function slugifyTitle(title: string): string {
    const trimmed = title.trim().length > 0 ? title.trim() : UNTITLED_DOCUMENT;
    return trimmed.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'note';
  }

  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleExportMarkdown(): Promise<void> {
    setExportMenuOpen(false);
    setExporting(true);
    try {
      const markdown = editor.blocksToMarkdownLossy(editor.document);
      const header = `# ${savedDocRef.current.title || UNTITLED_DOCUMENT}\n\n`;
      const blob = new Blob([header + markdown], { type: 'text/markdown;charset=utf-8' });
      downloadBlob(blob, `${slugifyTitle(savedDocRef.current.title)}.md`);
      setNotification({ kind: 'success', msg: 'Exported as Markdown' });
    } catch (err) {
      console.error('[NoteEditor] markdown export failed:', err);
      setNotification({ kind: 'error', msg: 'Export failed' });
    } finally {
      setExporting(false);
      setTimeout(() => { setNotification(null); }, SAVED_BANNER_DURATION_MS);
    }
  }

  async function handleExportImage(): Promise<void> {
    setExportMenuOpen(false);
    setExporting(true);
    try {
      const node = editorScrollRef.current;
      if (node === null) throw new Error('editor not mounted');
      const dataUrl = await toPng(node, {
        backgroundColor: '#161616',
        pixelRatio: 2,
        cacheBust: true,
      });
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      downloadBlob(blob, `${slugifyTitle(savedDocRef.current.title)}.png`);
      setNotification({ kind: 'success', msg: 'Exported as Image' });
    } catch (err) {
      console.error('[NoteEditor] image export failed:', err);
      setNotification({ kind: 'error', msg: 'Export failed' });
    } finally {
      setExporting(false);
      setTimeout(() => { setNotification(null); }, SAVED_BANNER_DURATION_MS);
    }
  }

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') { void doSave(); }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => { document.removeEventListener('visibilitychange', handleVisibilityChange); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { void doSave(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleGitHubConfirm(filePath: string, commitMessage: string): Promise<void> {
    setGithubModalOpen(false);
    const markdown = await editorRef.current.blocksToMarkdownLossy(editorRef.current.document);
    const result = await pushToGitHub({ markdown, filePath, commitMessage });
    if (result.success) {
      setGithubPath(filePath);
      void doSave();
      setNotification({ kind: 'success', msg: `Pushed to GitHub: ${filePath}` });
    } else {
      setNotification({ kind: 'error', msg: result.error ?? 'Push failed' });
    }
    setTimeout(() => { setNotification(null); }, SAVED_BANNER_DURATION_MS * 2);
  }

  const defaultCommitMsg = `Add note: ${savedDocRef.current.title}`;
  const defaultFilePath = githubPathRef.current ?? `content/notes/${doc.id}.md`;

  // GitHub status
  const ghStatus = githubPath != null ? 'synced' : 'not-pushed';
  const ghDotColor = ghStatus === 'synced' ? 'var(--kh-accent)' : '#525252';

  // Applied tags for metadata panel
  const appliedTags = flatTags.filter((t) => taxonomyTagIds.includes(t.id));

  return (
    <div className="notes-editor-panel">
      {/* Centre: editor column */}
      <div className="notes-editor-centre">
        {/* Top bar */}
        <div className="notes-top-bar">
          <div className="notes-export-anchor" ref={exportMenuRef}>
            <button
              className="notes-export-link"
              disabled={exporting}
              onClick={() => { setExportMenuOpen((v) => !v); }}
            >
              <Export size={14} /> {exporting ? 'Exporting…' : 'Export'}
            </button>
            {exportMenuOpen && (
              <ul className="kb-menu" role="menu">
                <li role="menuitem">
                  <button className="kb-menu__item" onClick={() => { void handleExportMarkdown(); }}>
                    <DocumentExport size={16} /> Export as Markdown (.md)
                  </button>
                </li>
                <li role="menuitem">
                  <button className="kb-menu__item" onClick={() => { void handleExportImage(); }}>
                    <ImageIcon size={16} /> Export as Image (.png)
                  </button>
                </li>
              </ul>
            )}
          </div>
          <button className="notes-push-link" onClick={() => { setGithubModalOpen(true); }}>
            Push to GitHub
          </button>
          {onDelete && (
            <button
              className="notes-delete-link"
              onClick={() => {
                if (!window.confirm(`Delete "${savedDocRef.current.title}"? This cannot be undone.`)) return;
                onDelete(doc.id);
              }}
            >
              <TrashCan size={14} /> Delete
            </button>
          )}
        </div>

        {notification !== null && (
          <span className={`notes-save-status notes-save-status--${notification.kind}`}>
            {notification.msg}
          </span>
        )}

        {/* Editor scroll area — data-ctx-* enables right-click → Send to Canvas with note context */}
        <div
          className="notes-editor-scroll"
          ref={editorScrollRef}
          data-ctx-title={doc.title}
          data-ctx-type="hub_ref"
          data-ctx-ref-id={doc.id}
          data-ctx-ref-type="note"
          data-ctx-source={`Note · ${contentType}`}
          {...(appliedTags.length > 0 ? { 'data-ctx-tags': appliedTags.map((t) => t.colour ? `${t.name}|${t.colour}` : t.name).join(',') } : {})}
          {...(appliedTags.length > 0 ? { 'data-ctx-tag-ids': appliedTags.map((t) => t.id).join(',') } : {})}
        >
          <div className="notes-editor-inner">
            <BlockNoteViewWrapper
              editor={editor}
              theme={BLOCKNOTE_G100_THEME}
            />
          </div>
        </div>

        {/* Bottom toolbar */}
        <div className="notes-bottom-toolbar">
          <button
            type="button"
            className={`notes-tb-btn${toolbarState.blockType === 'heading' && toolbarState.level === 1 ? ' notes-tb-btn--active' : ''}`}
            title="Heading 1"
            onClick={() => { toggleHeading(1); }}
          >
            H1
          </button>
          <button
            type="button"
            className={`notes-tb-btn${toolbarState.blockType === 'heading' && toolbarState.level === 2 ? ' notes-tb-btn--active' : ''}`}
            title="Heading 2"
            onClick={() => { toggleHeading(2); }}
          >
            H2
          </button>
          <span className="notes-tb-sep" />
          <button
            type="button"
            className={`notes-tb-btn${toolbarState.bold ? ' notes-tb-btn--active' : ''}`}
            title="Bold"
            onClick={() => { toggleInlineStyle('bold'); }}
          >
            B
          </button>
          <button
            type="button"
            className={`notes-tb-btn${toolbarState.italic ? ' notes-tb-btn--active' : ''}`}
            title="Italic"
            onClick={() => { toggleInlineStyle('italic'); }}
          >
            I
          </button>
          <span className="notes-tb-sep" />
          <button
            type="button"
            className={`notes-tb-btn${toolbarState.blockType === 'checkListItem' ? ' notes-tb-btn--active' : ''}`}
            title="Checklist"
            onClick={() => { toggleBlockType('checkListItem'); }}
          >
            [ ]
          </button>
          <button
            type="button"
            className={`notes-tb-btn${toolbarState.blockType === 'bulletListItem' ? ' notes-tb-btn--active' : ''}`}
            title="Bullet list"
            onClick={() => { toggleBlockType('bulletListItem'); }}
          >
            •—
          </button>
          <button
            type="button"
            className={`notes-tb-btn${toolbarState.blockType === 'numberedListItem' ? ' notes-tb-btn--active' : ''}`}
            title="Numbered list"
            onClick={() => { toggleBlockType('numberedListItem'); }}
          >
            1.—
          </button>
          <span className="notes-tb-sep" />
          <button
            type="button"
            className={`notes-tb-btn${toolbarState.blockType === 'codeBlock' ? ' notes-tb-btn--active' : ''}`}
            title="Code block"
            onClick={() => { toggleBlockType('codeBlock'); }}
          >
            &lt;/&gt;
          </button>
          <button
            type="button"
            className={`notes-tb-btn${toolbarState.blockType === 'quote' ? ' notes-tb-btn--active' : ''}`}
            title="Quote"
            onClick={() => { toggleBlockType('quote'); }}
          >
            ❝
          </button>
          <span className="notes-tb-stats">{wordCount} words · {readingTime} min read</span>
        </div>
      </div>

      {/* Right: metadata panel */}
      <MetadataPanel
        doc={doc}
        contentType={contentType}
        onContentTypeChange={(value) => { setContentType(value); isDirtyRef.current = true; }}
        taxonomyTagIds={taxonomyTagIds}
        appliedTags={appliedTags}
        onTagIdsChange={(ids) => { void setNoteTagsMutation.mutate(ids); }}
        wordCount={wordCount}
        readingTime={readingTime}
        blockCount={blockCount}
        ghStatus={ghStatus}
        ghDotColor={ghDotColor}
        githubPath={githubPath}
        onPushToGitHub={() => { setGithubModalOpen(true); }}
      />

      <GitHubModal
        open={githubModalOpen}
        defaultFilePath={defaultFilePath}
        defaultCommitMessage={defaultCommitMsg}
        onClose={() => { setGithubModalOpen(false); }}
        onConfirm={(fp, msg) => { void handleGitHubConfirm(fp, msg); }}
      />
    </div>
  );
};
