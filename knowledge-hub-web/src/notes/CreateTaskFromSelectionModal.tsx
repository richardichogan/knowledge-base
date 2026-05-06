/**
 * notes/CreateTaskFromSelectionModal.tsx
 *
 * Opens when the user highlights text in the BlockNote editor and clicks
 * "Create Task". Uses AI to pre-fill title, description and suggest a project,
 * then creates the task via the API.
 */

import React, { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { PROJECTS } from '../config/projects';
import type { TaskDestination } from '../types/task';

interface Props {
  selectedText: string;
  onClose: () => void;
  onCreated: (taskTitle: string) => void;
}

interface AiSuggestion {
  title: string;
  description: string;
  projectId: string;
}

export const CreateTaskFromSelectionModal: React.FC<Props> = ({
  selectedText,
  onClose,
  onCreated,
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('personal');
  const [destination, setDestination] = useState<TaskDestination>('todo');
  const [aiLoading, setAiLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // Ask AI to suggest title, description and project
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const prompt = `You are a task extraction assistant. Given the following text from a note, extract a concise task.
Return ONLY a JSON object with these fields:
- title: short action-oriented task title (max 10 words)
- description: a 1-3 sentence description of what needs to be done
- projectId: the best matching project id from this list: ${PROJECTS.map((p) => `${p.id} (${p.name})`).join(', ')}

Text:
"""
${selectedText.slice(0, 1500)}
"""

Respond with only the JSON object, no markdown, no explanation.`;

        const res = await api.chat({ message: prompt });
        if (cancelled) return;

        if (res.success && res.data) {
          const raw = res.data.reply.trim().replace(/^```json\s*/, '').replace(/```$/, '').trim();
          const suggestion = JSON.parse(raw) as AiSuggestion;
          setTitle(suggestion.title ?? '');
          setDescription(suggestion.description ?? '');
          const matchedProject = PROJECTS.find((p) => p.id === suggestion.projectId);
          if (matchedProject) setProjectId(matchedProject.id);
        } else {
          // Fallback: use first 80 chars of selected text as title
          setTitle(selectedText.slice(0, 80).trim());
          setDescription(selectedText.slice(0, 500).trim());
        }
      } catch {
        if (!cancelled) {
          setTitle(selectedText.slice(0, 80).trim());
          setDescription(selectedText.slice(0, 500).trim());
        }
      } finally {
        if (!cancelled) {
          setAiLoading(false);
          setTimeout(() => titleRef.current?.focus(), 50);
        }
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(): Promise<void> {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.createTask({
        title: title.trim(),
        ...(description.trim() && { body: description.trim() }),
        destination,
        projectContext: projectId,
      });
      if (res.success) {
        onCreated(title.trim());
      } else {
        setError('Failed to create task. Please try again.');
      }
    } catch {
      setError('Failed to create task. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleCreate();
  }

  return (
    <div className="ctsm-overlay" onClick={onClose} onKeyDown={handleKeyDown} role="presentation">
      <div
        className="ctsm-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Create task from selection"
      >
        <div className="ctsm-header">
          <span className="ctsm-title">Create Task</span>
          {aiLoading && <span className="ctsm-ai-badge">✦ AI filling…</span>}
          <button className="ctsm-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="ctsm-selected-preview">
          <span className="ctsm-preview-label">From selection:</span>
          <span className="ctsm-preview-text">"{selectedText.slice(0, 120)}{selectedText.length > 120 ? '…' : ''}"</span>
        </div>

        <div className="ctsm-field">
          <label className="ctsm-label" htmlFor="ctsm-title">Title</label>
          <input
            id="ctsm-title"
            ref={titleRef}
            className="ctsm-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={aiLoading ? 'AI is thinking…' : 'Task title'}
            disabled={aiLoading}
          />
        </div>

        <div className="ctsm-field">
          <label className="ctsm-label" htmlFor="ctsm-desc">Description</label>
          <textarea
            id="ctsm-desc"
            className="ctsm-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={aiLoading ? 'AI is thinking…' : 'Task description'}
            disabled={aiLoading}
            rows={4}
          />
        </div>

        <div className="ctsm-row">
          <div className="ctsm-field ctsm-field--half">
            <label className="ctsm-label" htmlFor="ctsm-project">Project</label>
            <select
              id="ctsm-project"
              className="ctsm-select"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={aiLoading}
            >
              {PROJECTS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="ctsm-field ctsm-field--half">
            <label className="ctsm-label" htmlFor="ctsm-dest">Destination</label>
            <select
              id="ctsm-dest"
              className="ctsm-select"
              value={destination}
              onChange={(e) => setDestination(e.target.value as TaskDestination)}
            >
              <option value="todo">To-do list</option>
              <option value="github-issue">GitHub Issue</option>
            </select>
          </div>
        </div>

        {error !== null && <p className="ctsm-error">{error}</p>}

        <div className="ctsm-actions">
          <button className="ctsm-btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="ctsm-btn-primary"
            onClick={() => void handleCreate()}
            disabled={aiLoading || saving || !title.trim()}
          >
            {saving ? 'Creating…' : 'Create Task'}
          </button>
        </div>

        <p className="ctsm-hint">⌘↵ to create · Esc to cancel</p>
      </div>
    </div>
  );
};
