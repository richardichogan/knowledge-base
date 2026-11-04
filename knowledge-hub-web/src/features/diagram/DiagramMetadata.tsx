import React, { useEffect, useState } from 'react';
import { useProjects } from '../../hooks/useProjects';
import { ProjectOptions } from '../../components/ProjectOptions';
import { api, type CanvasFullApi, type CanvasSummaryApi } from '../../services/api';
import { DiagramDescriptionEditor } from './DiagramDescriptionEditor';

export function DiagramMetadata({ canvas, onSaved }: {
  canvas: CanvasFullApi;
  onSaved: (summary: CanvasSummaryApi) => void;
}): React.ReactElement {
  const [title, setTitle] = useState(canvas.title);
  const [description, setDescription] = useState(canvas.description ?? '');
  const [project, setProject] = useState(canvas.project ?? '');
  const [usedIn, setUsedIn] = useState<string[]>(canvas.usedInProjectIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setTitle(canvas.title);
    setDescription(canvas.description ?? '');
    setProject(canvas.project ?? '');
    setUsedIn(canvas.usedInProjectIds ?? []);
  }, [canvas.id, canvas.title, canvas.description, canvas.project, canvas.usedInProjectIds]);
  const projects = useProjects();
  const savedUsedIn = canvas.usedInProjectIds ?? [];
  const usedInChanged = usedIn.length !== savedUsedIn.length || usedIn.some(id => !savedUsedIn.includes(id));
  const changed = title.trim() !== canvas.title || description !== (canvas.description ?? '') || project !== (canvas.project ?? '') || usedInChanged;
  const usedInChoices = (projects.data ?? []).filter(item => item.id !== project);
  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (title.trim() === '') { setError('Enter a diagram title.'); return; }
    setSaving(true);
    setError(null);
    try {
      const response = await api.updateCanvas(canvas.id, {
        title: title.trim(), description, project: project || null,
        ...(usedInChanged || project !== (canvas.project ?? '') ? { usedInProjectIds: usedIn.filter(id => id !== project) } : {}),
      });
      if (!response.success) throw new Error(response.error.message);
      onSaved(response.data);
    } catch (cause) {
      setError(`Could not save diagram properties: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSaving(false);
    }
  }
  return <details className="dg-section" open>
  <summary className="dg-section__summary">Diagram properties</summary>
  <form className="dg-metadata" aria-label="Diagram metadata" onSubmit={(event) => { void save(event); }}>
    <label className="dg-properties__field">Title
      <input aria-label="Diagram title property" maxLength={200} value={title} disabled={saving}
        onChange={(event) => { setTitle(event.target.value); }} />
    </label>
    <DiagramDescriptionEditor label="Diagram description" rows={3} value={description} disabled={saving}
      onChange={value => { setDescription(value); }} />
    <label className="dg-properties__field">Project
      <select aria-label="Diagram project" value={project} disabled={saving || projects.isPending}
        onChange={(event) => { setProject(event.target.value); }}>
        <option value="">No project</option>
        {project !== '' && !projects.data?.some(item => item.id === project) && <option value={project}>{project}</option>}
        <ProjectOptions projects={projects.data ?? []} selected={project} />
      </select>
    </label>
    <fieldset className="dg-properties__field dg-metadata__used-in" disabled={saving || projects.isPending}>
      <legend>Also used in</legend>
      {usedInChoices.length === 0 && <p className="dg-properties__hint">No other projects.</p>}
      {usedInChoices.map(item => <label key={item.id} className="dg-metadata__check">
        <input type="checkbox" checked={usedIn.includes(item.id)}
          onChange={(event) => { setUsedIn(event.target.checked ? [...usedIn, item.id] : usedIn.filter(id => id !== item.id)); }} />
        {item.name}
      </label>)}
    </fieldset>
    <p className="dg-properties__hint">Project grounds this diagram's Athena conversation. Choose No project to remove that restriction on the next message.</p>
    {projects.error !== null && <div className="dg-metadata__error" role="alert">
      Could not load projects: {projects.error.message}
      <button type="button" className="dg-text-btn" onClick={() => { void projects.refetch(); }}>Retry projects</button>
    </div>}
    {error !== null && <p className="dg-metadata__error" role="alert">{error}</p>}
    <button className="dg-metadata__save" type="submit" disabled={saving || !changed}>{saving ? 'Saving…' : 'Save diagram properties'}</button>
  </form>
  </details>;
}
