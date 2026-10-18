import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { requireApiData } from '../services/apiError';
import { ENTITY_LINK_LABELS, type EntityLinkTarget } from './entityLinks';
import { openLinkPreview } from './linkPreview';
import { fetchNote } from './noteStorage';
import { NoteWriting, NoteWritingBoundary } from './NotePopout';
import { NoteBacklinks } from './NoteBacklinks';
import { DataNotice } from '../components/DataNotice';
import { Close, ArrowLeft, Launch } from '@carbon/icons-react';

function ProjectLinkPreview({ projectId }: { projectId: string }): React.ReactElement {
  const projectQuery = useQuery({
    queryKey: ['projects'],
    queryFn: async () => requireApiData(await api.getProjects()),
    staleTime: 15_000,
  });
  const project = projectQuery.data?.find(item => item.id === projectId);
  const notesQuery = useQuery({
    queryKey: ['project-preview-notes', projectId, project?.tagId],
    enabled: projectQuery.isSuccess,
    queryFn: async () => requireApiData(await api.getNoteSummaries(1, 6, {
      projectId, sort: 'modified', ...(project?.tagId && { projectTagIds: project.tagId }),
    })),
    staleTime: 15_000,
  });
  return <>
    {projectQuery.isPending && <p className="link-preview__text" role="status">Loading project...</p>}
    {projectQuery.error && <DataNotice title="Could not load project information" error={projectQuery.error} onRetry={() => { void projectQuery.refetch(); }} />}
    {projectQuery.isSuccess && !project && <p className="link-preview__text">This project is no longer available.</p>}
    {project && <>
      {project.description && <p className="link-preview__text">{project.description}</p>}
      {project.goal && <section className="link-preview__section">
        <h3>Goal</h3><p className="link-preview__text">{project.goal}</p>
      </section>}
      {!project.description && !project.goal && <p className="link-preview__context">No project overview has been recorded.</p>}
      <dl className="link-preview__details">
        <div><dt>Status</dt><dd>{project.lifecycleState}</dd></div>
        {project.role && <div><dt>Your role</dt><dd>{project.role}</dd></div>}
        {project.ownership && <div><dt>Ownership</dt><dd>{project.ownership}</dd></div>}
        {project.startDate && <div><dt>Started</dt><dd>{project.startDate}</dd></div>}
        {project.targetEndDate && <div><dt>Target date</dt><dd>{project.targetEndDate}</dd></div>}
      </dl>
      {project.expectedOutputs.length > 0 && <section className="link-preview__section">
        <h3>Expected outputs</h3>
        <ul className="link-preview__outputs">{project.expectedOutputs.map((output, index) => <li key={index}>{output}</li>)}</ul>
      </section>}
      {project.links.some(link => /^https?:\/\//i.test(link.url)) && <section className="link-preview__section">
        <h3>Project resources</h3>
        {project.links.filter(link => /^https?:\/\//i.test(link.url)).map((link, index) => <a className="conn-item" key={`${link.url}-${index}`} href={link.url} target="_blank" rel="noopener noreferrer">
          <span className="conn-item__title">{link.label || link.url}</span>
        </a>)}
      </section>}
    </>}
    <section className="link-preview__section">
      <h3>Project notes</h3>
      {projectQuery.isSuccess && notesQuery.isPending && <p className="link-preview__context" role="status">Loading project notes...</p>}
      {notesQuery.error && <DataNotice title="Could not load project notes" error={notesQuery.error} onRetry={() => { void notesQuery.refetch(); }} />}
      {notesQuery.data?.items.length === 0 && <p className="link-preview__context">No notes are filed to this project.</p>}
      {notesQuery.data?.items.map(note => {
        const href = `/think?noteId=${encodeURIComponent(note.id)}`;
        return <a className="conn-item link-preview__source" href={href} key={note.id} onClick={event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if (openLinkPreview({ type: 'note', id: note.id, title: note.title, href })) event.preventDefault();
        }}>
          <span className="conn-item__title">{note.title}</span>
          <span className="conn-item__reason">{note.preview || 'Open this note to read its contents.'}</span>
        </a>;
      })}
      {notesQuery.data && notesQuery.data.total > notesQuery.data.items.length && <p className="link-preview__context">Showing the six most recently updated notes of {notesQuery.data.total}.</p>}
    </section>
  </>;
}

export function LinkPreviewContent({ target, onBack, onClose }: {
  target: EntityLinkTarget; onBack?: (() => void) | undefined; onClose: () => void;
}): React.ReactElement {
  const navigate = useNavigate();
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['link-preview', target.type, target.id],
    enabled: target.type !== 'project',
    queryFn: async () => {
      if (target.type === 'note') {
        const note = await fetchNote(target.id);
        if (!note) throw new Error('This note is no longer available.');
        return { summary: '', details: [], contentJson: note.contentJson };
      }
      return requireApiData(await api.getLinkPreview(target.type, target.id));
    },
    staleTime: 15_000,
  });
  const external = /^https?:\/\//i.test(target.href);
  return <div className="link-preview">
    <header className="link-preview__header">
      {onBack && <button type="button" className="notes-meta-tabs__collapse link-preview__back" aria-label="Back to previous link" title="Back to previous link" onClick={onBack}><ArrowLeft size={16} /></button>}
      <h2>{target.title}</h2>
      <span className="conn-item__type">{ENTITY_LINK_LABELS[target.type]}</span>
      <button type="button" className="notes-meta-tabs__collapse" aria-label="Close preview" title="Close preview (Esc)" onClick={onClose}><Close size={16} /></button>
    </header>
    {target.type === 'project' ? <ProjectLinkPreview key={target.id} projectId={target.id} /> : <>
    {isPending && <p>Loading...</p>}
    {error && <DataNotice title="Could not load this item" error={error} onRetry={() => { void refetch(); }} />}
    {data && <>
      {data.details.length > 0 && <dl className="link-preview__details">
        {data.details.map(d => <div key={d.label}><dt>{d.label}</dt><dd>{d.value}</dd></div>)}
      </dl>}
      {'contentJson' in data
        ? <NoteWritingBoundary key={target.id}><NoteWriting contentJson={data.contentJson} /></NoteWritingBoundary>
        : <p className="link-preview__text">{data.summary || 'No description yet.'}</p>}
    </>}
    </>}
    <NoteBacklinks type={target.type} noteId={target.id} />
    <button type="button" className="notes-meta-gh-action link-preview__open" onClick={() => {
      if (external) window.open(target.href, '_blank', 'noopener,noreferrer'); else navigate(target.href);
    }}>Open full {ENTITY_LINK_LABELS[target.type].toLowerCase()}<Launch size={14} /></button>
  </div>;
}
