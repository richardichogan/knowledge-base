import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type CanvasFullApi, type CanvasSummaryApi } from '../../services/api';

export function DiagramMetadata({ canvas, onSaved }: {
  canvas: CanvasFullApi;
  onSaved: (summary: CanvasSummaryApi) => void;
}): React.ReactElement {
  const [title, setTitle] = useState(canvas.title);
  const [description, setDescription] = useState(canvas.description ?? '');
  const [project, setProject] = useState(canvas.project ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setTitle(canvas.title);
    setDescription(canvas.description ?? '');
    setProject(canvas.project ?? '');
  }, [canvas.id, canvas.title, canvas.description, canvas.project]);
  const projects = useQuery({
    queryKey: ['projects', 'diagram-properties'],
    queryFn: async () => {
      const response = await api.getProjects();
      if (!response.success) throw new Error(response.error.message);
      return response.data;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  const changed = title.trim() !== canvas.title || description !== (canvas.description ?? '') || project !== (canvas.project ?? '');
  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (title.trim() === '') { setError('Enter a diagram title.'); return; }
    setSaving(true);
    setError(null);
    try {
      const response = await api.updateCanvas(canvas.id, { title: title.trim(), description, project: project || null });
      if (!response.success) throw new Error(response.error.message);
      onSaved(response.data);
    } catch (cause) {
      setError(`Could not save diagram properties: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSaving(false);
    }
  }
  return <form className="dg-metadata" aria-label="Diagram metadata" onSubmit={(event) => { void save(event); }}>
    <h4 className="dg-metadata__heading">Diagram</h4>
    <label className="dg-properties__field">Title
      <input aria-label="Diagram title property" maxLength={200} value={title} disabled={saving}
        onChange={(event) => { setTitle(event.target.value); }} />
    </label>
    <label className="dg-properties__field">Description
      <textarea aria-label="Diagram description" rows={3} maxLength={10000} value={description} disabled={saving}
        onChange={(event) => { setDescription(event.target.value); }} />
    </label>
    <label className="dg-properties__field">Project
      <select aria-label="Diagram project" value={project} disabled={saving || projects.isPending}
        onChange={(event) => { setProject(event.target.value); }}>
        <option value="">No project</option>
        {project !== '' && !projects.data?.some(item => item.id === project) && <option value={project}>{project}</option>}
        {projects.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    <p className="dg-properties__hint">Project grounds this diagram's Athena conversation. Choose No project to remove that restriction on the next message.</p>
    {projects.error !== null && <div className="dg-metadata__error" role="alert">
      Could not load projects: {projects.error.message}
      <button type="button" className="dg-text-btn" onClick={() => { void projects.refetch(); }}>Retry projects</button>
    </div>}
    {error !== null && <p className="dg-metadata__error" role="alert">{error}</p>}
    <button className="dg-metadata__save" type="submit" disabled={saving || !changed}>{saving ? 'Saving…' : 'Save diagram properties'}</button>
  </form>;
}
