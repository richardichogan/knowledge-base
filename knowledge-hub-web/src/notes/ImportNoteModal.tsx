/**
 * notes/ImportNoteModal.tsx — import a file (Markdown, text, Word, Excel,
 * PowerPoint, or PDF) directly into Think as a new note. Extracts the file's
 * text, lets the user adjust the title, project, and tags before saving —
 * distinct from Athena's per-response "save to Think" action.
 *
 * Carbon APIs confirmed from installed source (see GitHubModal.tsx for the
 * same confirmations): Modal, TextInput.
 */

import React, { useState } from 'react';
import { Modal, TextInput, InlineLoading, InlineNotification } from '@carbon/react';
import { api } from '../services/api';
import { useProjects } from '../hooks/useProjects';
import { TagPicker } from '../components/TagPicker';
import { useFlatTags } from '../hooks/useTaxonomy';
import { createNote } from './noteStorage';
import { markdownToNoteBlocks } from './markdownToBlocks';
import type { NoteDocument } from './types';

const ACCEPTED_EXTENSIONS = /\.(md|markdown|txt|docx|xlsx|pptx|pdf)$/i;

interface ImportNoteModalProps {
  open: boolean;
  onClose: () => void;
  onImported: (doc: NoteDocument) => void;
}

export const ImportNoteModal: React.FC<ImportNoteModalProps> = ({ open, onClose, onImported }) => {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extractedText, setExtractedText] = useState('');

  const { data: projects = [] } = useProjects();
  const flatTags = useFlatTags();
  const appliedTags = flatTags.filter((t) => tagIds.includes(t.id));

  function reset(): void {
    setFile(null);
    setTitle('');
    setProjectId('');
    setTagIds([]);
    setError(null);
    setExtractedText('');
  }

  function handleClose(): void {
    reset();
    onClose();
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const selected = e.target.files?.[0];
    e.target.value = '';
    if (!selected) return;

    if (!ACCEPTED_EXTENSIONS.test(selected.name)) {
      setError('Please choose a Markdown (.md), text (.txt), Word (.docx), Excel (.xlsx), PowerPoint (.pptx), or PDF file.');
      return;
    }

    setError(null);
    setFile(selected);
    setTitle(selected.name.replace(/\.[^.]+$/, ''));
    setExtracting(true);
    try {
      if (/\.(md|markdown|txt)$/i.test(selected.name)) {
        const text = (await selected.text()).trim();
        if (text === '') throw new Error('the file is empty');
        setExtractedText(text);
      } else {
        const res = await api.uploadDocument(selected, projectId || 'personal');
        if (!res.success) throw new Error(res.error?.message ?? 'could not read the file');
        setExtractedText(res.data.text);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFile(null);
    } finally {
      setExtracting(false);
    }
  }

  async function handleSubmit(): Promise<void> {
    if (!file || extractedText.trim() === '') {
      setError('Choose a file to import first.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const note = await createNote(
        {
          title: title.trim() || file.name.replace(/\.[^.]+$/, ''),
          contentType: 'note',
          contentJson: JSON.stringify(markdownToNoteBlocks(extractedText)),
        },
        projectId || undefined,
      );
      if (!note) throw new Error('could not save the note');
      if (tagIds.length > 0) {
        await api.setNoteTags(note.id, tagIds);
      }
      reset();
      onImported(note);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      modalHeading="Import into Think"
      modalLabel="Think"
      primaryButtonText={saving ? 'Importing…' : 'Import'}
      secondaryButtonText="Cancel"
      size="sm"
      primaryButtonDisabled={!file || extracting || saving}
      onRequestClose={handleClose}
      onRequestSubmit={() => { void handleSubmit(); }}
    >
      {error !== null && (
        <>
          <InlineNotification kind="error" title="Import failed" subtitle={error} lowContrast hideCloseButton />
          <div className="notes-modal-spacer" />
        </>
      )}

      <label className="notes-import-file-label" htmlFor="import-note-file">
        {file ? file.name : 'Choose a file to import'}
      </label>
      <input
        id="import-note-file"
        type="file"
        accept=".md,.markdown,.txt,.docx,.xlsx,.pptx,.pdf"
        className="notes-import-file-input"
        onChange={(e) => { void handleFileSelected(e); }}
      />
      {extracting && <InlineLoading description="Extracting text…" />}

      <div className="notes-modal-spacer" />
      <TextInput
        id="import-note-title"
        labelText="Title"
        value={title}
        onChange={(e) => { setTitle(e.target.value); }}
        placeholder="Note title"
        disabled={!file}
      />

      <div className="notes-modal-spacer" />
      <p className="notes-meta-section-label">Project</p>
      <select
        title="Project"
        className="notes-meta-type-select"
        value={projectId}
        disabled={!file}
        onChange={(e) => { setProjectId(e.target.value); }}
      >
        <option value="">No project</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>{project.name}</option>
        ))}
      </select>

      <div className="notes-modal-spacer" />
      <p className="notes-meta-section-label">Tags</p>
      <div className="notes-meta-tags-chips">
        {appliedTags.map((t) => (
          <span key={t.id} className="notes-meta-tag-chip">{t.name}</span>
        ))}
        <TagPicker
          selectedIds={tagIds}
          onChange={setTagIds}
          trigger={<button type="button" className="notes-tag-picker-trigger" disabled={!file}>+ Add tag</button>}
        />
      </div>
    </Modal>
  );
};
