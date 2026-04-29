/**
 * notes/NoteEditor.tsx — BlockNote editor canvas with autosave, top bar,
 * bottom toolbar, right metadata panel, and GitHub push modal.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCreateBlockNote } from '@blocknote/react';
import '@blocknote/mantine/style.css';
import { BlockNoteViewWrapper } from './BlockNoteViewWrapper';
import { GitHubModal } from './GitHubModal';
import { CreateTaskFromSelectionModal } from './CreateTaskFromSelectionModal';
import { pushToGitHub } from './githubSync';
import { saveNote } from './noteStorage';
import {
  AUTOSAVE_INTERVAL_MS,
  SAVED_BANNER_DURATION_MS,
  BLOCKNOTE_G100_THEME,
  UNTITLED_DOCUMENT,
  CONTENT_TYPE_OPTIONS,
} from './constants';
import type { ContentType } from './constants';
import type { NoteDocument } from './types';
import { useNoteTags, useSetNoteTags, useFlatTags } from '../hooks/useTaxonomy';
import { TagPicker } from '../components/TagPicker';

interface NoteEditorProps {
  doc: NoteDocument;
  onSaved: (updated: NoteDocument) => void;
}

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

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export const NoteEditor: React.FC<NoteEditorProps> = ({ doc, onSaved }) => {
  const [contentType, setContentType] = useState<ContentType>(doc.contentType);
  const [githubModalOpen, setGithubModalOpen] = useState(false);
  const [createTaskSelection, setCreateTaskSelection] = useState<string | null>(null);

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
      uploadFile: async (file: File): Promise<string> => {
        // Upload to blob storage via backend — returns a permanent URL
        // instead of storing base64 inline (which breaks on 2+ images due to 1mb body limit)
        const arrayBuffer = await file.arrayBuffer();
        const response = await fetch(
          `${import.meta.env['VITE_API_BASE_URL'] ?? ''}/api/images`,
          {
            method: 'POST',
            headers: {
              'Content-Type': file.type || 'application/octet-stream',
              'Authorization': `Bearer ${(import.meta.env['VITE_API_TOKEN'] as string | undefined) ?? ''}`,
            },
            body: arrayBuffer,
          },
        );
        if (!response.ok) throw new Error(`Image upload failed: ${response.status.toString()}`);
        const json = await response.json() as { success: boolean; data?: { blobUrl: string } };
        if (!json.success || json.data === undefined) throw new Error('Image upload returned no URL');
        return json.data.blobUrl;
      },
    },
    [doc.id],
  );

  const editorRef = useRef(editor);
  useEffect(() => { editorRef.current = editor; }, [editor]);
  const isDirtyRef = useRef(false);

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
    const ok = await saveNote(updated);
    if (ok) {
      savedDocRef.current = updated;
      onSavedRef.current(updated);
      setNotification({ kind: 'success', msg: 'Saved' });
      setTimeout(() => { setNotification(null); }, SAVED_BANNER_DURATION_MS);
    } else {
      isDirtyRef.current = true;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = editor.onChange(() => {
      isDirtyRef.current = true;
      updateStats();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { void doSave(); }, 3_000);
    });
    updateStats(); // initial
    return () => {
      unsubscribe();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    };
  }, [editor, doSave, updateStats]);

  useEffect(() => {
    const timer = setInterval(() => { void doSave(); }, AUTOSAVE_INTERVAL_MS);
    return () => { clearInterval(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
          <select
            title="Content type"
            className="notes-type-select"
            value={contentType}
            onChange={(e) => { setContentType(e.target.value as ContentType); isDirtyRef.current = true; }}
          >
            {CONTENT_TYPE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          <button className="notes-push-link" onClick={() => { setGithubModalOpen(true); }}>
            Push to GitHub
          </button>
        </div>

        {notification !== null && (
          <span className={`notes-save-status notes-save-status--${notification.kind}`}>
            {notification.msg}
          </span>
        )}

        {/* Editor scroll area */}
        <div className="notes-editor-scroll">
          <div className="notes-editor-inner">
            <BlockNoteViewWrapper
              editor={editor}
              theme={BLOCKNOTE_G100_THEME}
              onCreateTask={(text) => { setCreateTaskSelection(text); }}
            />
          </div>
        </div>

        {/* Bottom toolbar */}
        <div className="notes-bottom-toolbar">
          <span className="notes-tb-btn">H1</span>
          <span className="notes-tb-btn">H2</span>
          <span className="notes-tb-sep" />
          <span className="notes-tb-btn">B</span>
          <span className="notes-tb-btn">I</span>
          <span className="notes-tb-sep" />
          <span className="notes-tb-btn">[ ]</span>
          <span className="notes-tb-btn">•—</span>
          <span className="notes-tb-btn">1.—</span>
          <span className="notes-tb-sep" />
          <span className="notes-tb-btn">&lt;/&gt;</span>
          <span className="notes-tb-btn">❝</span>
          <span className="notes-tb-stats">{wordCount} words · {readingTime} min read</span>
        </div>
      </div>

      {/* Right: metadata panel */}
      <div className="notes-meta-panel">
        <div className="notes-meta-section">
          <p className="notes-meta-section-label">Created</p>
          <p className="notes-meta-section-value">{formatDateTime(doc.createdAt)}</p>
        </div>

        <div className="notes-meta-section">
          <p className="notes-meta-section-label">Modified</p>
          <p className="notes-meta-section-value">{formatDateTime(doc.updatedAt)}</p>
        </div>

        <div className="notes-meta-section">
          <p className="notes-meta-section-label">Tags</p>
          <div className="notes-meta-tags-chips">
            {appliedTags.map((t) => (
              <span key={t.id} className="notes-meta-tag-chip">{t.name}</span>
            ))}
            <TagPicker
              selectedIds={taxonomyTagIds}
              onChange={(ids) => { void setNoteTagsMutation.mutate(ids); }}
              trigger={<button className="notes-tag-picker-trigger">+ Add tag</button>}
            />
          </div>
        </div>

        <div className="notes-meta-section">
          <p className="notes-meta-section-label">Stats</p>
          <div className="notes-meta-stat-row">
            <span className="notes-meta-stat-label">Words</span>
            <span className="notes-meta-stat-value">{wordCount}</span>
          </div>
          <div className="notes-meta-stat-row">
            <span className="notes-meta-stat-label">Reading time</span>
            <span className="notes-meta-stat-value">{readingTime} min</span>
          </div>
          <div className="notes-meta-stat-row">
            <span className="notes-meta-stat-label">Blocks</span>
            <span className="notes-meta-stat-value">{blockCount}</span>
          </div>
        </div>

        <div className="notes-meta-section">
          <p className="notes-meta-section-label">GitHub</p>
          <div className="notes-meta-gh-status">
            <div className="notes-meta-gh-dot" ref={(el) => { if (el) el.style.background = ghDotColor; }} />
            <div>
              <span className="notes-meta-gh-heading">{ghStatus === 'synced' ? 'Synced' : 'Not pushed'}</span>
              <span className="notes-meta-gh-text">
                {ghStatus === 'synced' ? githubPath : 'Push to content-store to sync'}
              </span>
            </div>
          </div>
          <button className="kh-btn-accent notes-meta-gh-push" onClick={() => { setGithubModalOpen(true); }}>
            ↑ Push to content-store
          </button>
        </div>

        <div className="notes-meta-section">
          <p className="notes-meta-section-label">Content type</p>
          <p className="notes-meta-section-value">{contentType}</p>
        </div>
      </div>

      <GitHubModal
        open={githubModalOpen}
        defaultFilePath={defaultFilePath}
        defaultCommitMessage={defaultCommitMsg}
        onClose={() => { setGithubModalOpen(false); }}
        onConfirm={(fp, msg) => { void handleGitHubConfirm(fp, msg); }}
      />

      {createTaskSelection !== null && (
        <CreateTaskFromSelectionModal
          selectedText={createTaskSelection}
          onClose={() => { setCreateTaskSelection(null); }}
          onCreated={(taskTitle) => {
            setCreateTaskSelection(null);
            setNotification({ kind: 'success', msg: `Task created: ${taskTitle}` });
            setTimeout(() => { setNotification(null); }, SAVED_BANNER_DURATION_MS * 2);
          }}
        />
      )}
    </div>
  );
};
