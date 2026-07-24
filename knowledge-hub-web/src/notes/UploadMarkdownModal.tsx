/**
 * notes/UploadMarkdownModal.tsx
 *
 * Lets the user drop in a markdown file (podcast notes, newsletter draft,
 * etc.) and does two things with it, both via existing AI infrastructure:
 *   1. Asks the AI to suggest 0-5 concrete tasks implied by the content —
 *      shown as an editable, checkbox-able preview so nothing is created
 *      without the user's OK.
 *   2. Adds the full document to the Think library (same Postgres `notes`
 *      table + BlockNote schema used by "+ New note"), tagged with a
 *      docType the AI also suggests (podcast, newsletter, etc.).
 */

import React, { useRef, useState } from 'react';
import { BlockNoteEditor } from '@blocknote/core';
import { Document, TrashCan, CheckmarkFilled } from '@carbon/icons-react';
import { api } from '../services/api';
import { createNote } from './noteStorage';
import { CONTENT_TYPE_OPTIONS, type ContentType } from './constants';
import { PROJECTS } from '../config/projects';

interface Props {
  onClose: () => void;
  onDone: (noteId: string | null, taskCount: number) => void;
}

interface CandidateTask {
  title: string;
  description: string;
  projectId: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  dueDate: string;
  selected: boolean;
}

interface AiExtraction {
  docTitle?: string;
  docType?: string;
  tasks?: Array<{ title?: string; description?: string; projectId?: string; priority?: string; dueDate?: string }>;
}

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
type Stage = 'pick' | 'analyzing' | 'review' | 'saving';

function buildExtractionPrompt(fileName: string, text: string): string {
  return `You are a note-triage assistant. A user uploaded a markdown file — typically podcast notes or a newsletter draft. Read it and:
1. Suggest a short document title (docTitle).
2. Classify it as one of: ${CONTENT_TYPE_OPTIONS.map((o) => o.id).join(', ')} (docType).
3. Extract 0-5 concrete, action-oriented tasks implied by the content, if any (not every note has tasks — return an empty array if none apply). For each: title (max 10 words, imperative), description (1-2 sentences), priority (low|normal|high|urgent), dueDate (ISO YYYY-MM-DD only if a date is mentioned/implied, else omit), and the best matching projectId from: ${PROJECTS.map((p) => `${p.id} (${p.name})`).join(', ')}.

Return ONLY a JSON object, no markdown fences, no explanation:
{ "docTitle": string, "docType": string, "tasks": [{ "title": string, "description": string, "priority": string, "dueDate"?: string, "projectId": string }] }

Filename: ${fileName}

Content:
"""
${text.slice(0, 8000)}
"""`;
}

export const UploadMarkdownModal: React.FC<Props> = ({ onClose, onDone }) => {
  const [fileName, setFileName] = useState<string | null>(null);
  const [rawContent, setRawContent] = useState('');
  const [docTitle, setDocTitle] = useState('');
  const [docType, setDocType] = useState<ContentType>('note');
  const [tasks, setTasks] = useState<CandidateTask[]>([]);
  const [stage, setStage] = useState<Stage>('pick');
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File): Promise<void> {
    if (!/\.(md|markdown)$/i.test(file.name)) {
      setError('Please choose a .md or .markdown file.');
      return;
    }
    setError(null);
    setFileName(file.name);
    const text = await file.text();
    setRawContent(text);
    setDocTitle(file.name.replace(/\.(md|markdown)$/i, '').replace(/[-_]/g, ' ').trim() || 'Untitled');
    setStage('analyzing');

    try {
      const res = await api.chat({ message: buildExtractionPrompt(file.name, text) });
      if (res.success) {
        const raw = res.data.reply.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        const parsed = JSON.parse(raw) as AiExtraction;
        if (typeof parsed.docTitle === 'string' && parsed.docTitle.trim() !== '') setDocTitle(parsed.docTitle.trim());
        if (typeof parsed.docType === 'string' && CONTENT_TYPE_OPTIONS.some((o) => o.id === parsed.docType)) {
          setDocType(parsed.docType as ContentType);
        }
        const extracted: CandidateTask[] = (Array.isArray(parsed.tasks) ? parsed.tasks : []).map((t) => ({
          title: typeof t.title === 'string' && t.title.trim() !== '' ? t.title.trim() : 'Untitled task',
          description: typeof t.description === 'string' ? t.description.trim() : '',
          projectId: typeof t.projectId === 'string' && PROJECTS.some((p) => p.id === t.projectId) ? t.projectId : 'personal',
          priority: PRIORITIES.includes(t.priority as typeof PRIORITIES[number]) ? (t.priority as CandidateTask['priority']) : 'normal',
          dueDate: typeof t.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate) ? t.dueDate : '',
          selected: true,
        }));
        setTasks(extracted);
      } else {
        setError('AI analysis failed — you can still add this to the library without tasks.');
      }
    } catch {
      setError('AI analysis failed — you can still add this to the library without tasks.');
    } finally {
      setStage('review');
    }
  }

  function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  }

  function onDrop(e: React.DragEvent): void {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  function updateTask(i: number, patch: Partial<CandidateTask>): void {
    setTasks((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }

  function removeTask(i: number): void {
    setTasks((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleConfirm(): Promise<void> {
    setStage('saving');
    setError(null);
    try {
      const toCreate = tasks.filter((t) => t.selected && t.title.trim() !== '');
      for (const t of toCreate) {
        // eslint-disable-next-line no-await-in-loop -- sequential to keep task ordering stable and avoid API rate spikes
        await api.createTask({
          title: t.title.trim(),
          ...(t.description.trim() !== '' && { body: t.description.trim() }),
          projectId: t.projectId,
          priority: t.priority,
          ...(t.dueDate !== '' && { dueDate: t.dueDate }),
        });
      }

      const headless = BlockNoteEditor.create();
      const blocks = await headless.tryParseMarkdownToBlocks(rawContent);
      const note = await createNote({
        title: docTitle.trim() !== '' ? docTitle.trim() : (fileName ?? 'Untitled'),
        contentType: docType,
        contentJson: JSON.stringify(blocks),
      });

      onDone(note?.id ?? null, toCreate.length);
    } catch {
      setError('Something went wrong saving — please try again.');
      setStage('review');
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal-panel umd-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Upload markdown file"
      >
        <h2 className="modal-title">Upload note</h2>

        {stage === 'pick' && (
          <div
            className={`umd-dropzone${dragOver ? ' umd-dropzone--active' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') fileInputRef.current?.click(); }}
          >
            <Document size={32} className="umd-dropzone-icon" />
            <p className="umd-dropzone-title">Drop a .md file here, or click to choose</p>
            <p className="umd-dropzone-hint">Podcast notes, newsletter drafts, meeting notes — anything markdown.</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,text/markdown"
              className="umd-file-input"
              onChange={onFileInputChange}
            />
          </div>
        )}

        {stage === 'analyzing' && (
          <div className="umd-analyzing">
            <div className="umd-spinner" />
            <p>Reading <strong>{fileName}</strong> and suggesting tasks…</p>
          </div>
        )}

        {(stage === 'review' || stage === 'saving') && (
          <>
            <div className="umd-doc-summary">
              <div className="umd-field">
                <label className="umd-label" htmlFor="umd-title">Document title</label>
                <input
                  id="umd-title"
                  className="umd-input"
                  value={docTitle}
                  onChange={(e) => setDocTitle(e.target.value)}
                  disabled={stage === 'saving'}
                />
              </div>
              <div className="umd-field">
                <label className="umd-label" htmlFor="umd-type">Type</label>
                <select
                  id="umd-type"
                  className="umd-select"
                  value={docType}
                  onChange={(e) => setDocType(e.target.value as ContentType)}
                  disabled={stage === 'saving'}
                >
                  {CONTENT_TYPE_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {error !== null && <p className="umd-error">{error}</p>}

            <div className="umd-tasks-header">
              <span>Suggested tasks</span>
              <span className="umd-tasks-count">{tasks.filter((t) => t.selected).length} of {tasks.length} selected</span>
            </div>

            {tasks.length === 0 ? (
              <p className="umd-no-tasks">No tasks suggested from this content — it'll just be added to your library.</p>
            ) : (
              <div className="umd-task-list">
                {tasks.map((t, i) => (
                  <div key={i} className={`umd-task-card${t.selected ? ' umd-task-card--selected' : ''}`}>
                    <button
                      className="umd-task-toggle"
                      onClick={() => updateTask(i, { selected: !t.selected })}
                      aria-label={t.selected ? 'Deselect task' : 'Select task'}
                      disabled={stage === 'saving'}
                    >
                      <CheckmarkFilled size={18} />
                    </button>
                    <div className="umd-task-body">
                      <input
                        className="umd-task-title"
                        value={t.title}
                        onChange={(e) => updateTask(i, { title: e.target.value })}
                        disabled={stage === 'saving'}
                      />
                      <textarea
                        className="umd-task-desc"
                        value={t.description}
                        onChange={(e) => updateTask(i, { description: e.target.value })}
                        rows={2}
                        disabled={stage === 'saving'}
                      />
                      <div className="umd-task-meta-row">
                        <select
                          className={`umd-task-priority umd-task-priority--${t.priority}`}
                          value={t.priority}
                          onChange={(e) => updateTask(i, { priority: e.target.value as CandidateTask['priority'] })}
                          disabled={stage === 'saving'}
                        >
                          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                        <select
                          className="umd-task-project"
                          value={t.projectId}
                          onChange={(e) => updateTask(i, { projectId: e.target.value })}
                          disabled={stage === 'saving'}
                        >
                          {PROJECTS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                        <input
                          type="date"
                          className="umd-task-due"
                          value={t.dueDate}
                          onChange={(e) => updateTask(i, { dueDate: e.target.value })}
                          disabled={stage === 'saving'}
                        />
                      </div>
                    </div>
                    <button
                      className="umd-task-remove"
                      onClick={() => removeTask(i)}
                      aria-label="Remove suggested task"
                      disabled={stage === 'saving'}
                    >
                      <TrashCan size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          <button className="umd-btn-secondary" onClick={onClose} disabled={stage === 'saving'}>Cancel</button>
          {(stage === 'review' || stage === 'saving') && (
            <button className="umd-btn-primary" onClick={() => void handleConfirm()} disabled={stage === 'saving'}>
              {stage === 'saving' ? 'Saving…' : 'Add to library'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
