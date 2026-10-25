import React, { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AppDialog } from '../../components/AppDialog';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { diagramSvg } from '../diagram/diagramExport';
import type { DesignDetail, DesignPackage, DesignPublication } from '../../types/designs';

export const DesignHandoff: React.FC<{ design: DesignDetail; prepare: () => Promise<void>; onClose: () => void }> = ({ design, prepare, onClose }) => {
  const [snapshot, setSnapshot] = useState<DesignPackage | null>(null);
  const [repo, setRepo] = useState('');
  const [folder, setFolder] = useState('design');
  const [confirmation, setConfirmation] = useState<DesignPublication | null>(null);
  const [commitUrl, setCommitUrl] = useState<string | null>(null);
  const [repoPage, setRepoPage] = useState(1);
  const repositories = useQuery({ queryKey: ['github-note-repositories', repoPage], queryFn: async () => requireApiData(await api.getNoteGitHubRepositories(repoPage)) });
  const create = useMutation({
    mutationFn: async () => {
      await prepare();
      const current = requireApiData(await api.getDesign(design.id));
      const diagrams = current.assets.filter(asset => asset.role === 'diagram');
      const diagram = current.selections.diagram ? diagrams.find(asset => asset.sourceId === current.selections.diagram) : diagrams.length === 1 ? diagrams[0] : undefined;
      if (diagrams.length && !diagram) throw new Error('Choose the diagram version for handoff in the Diagram tab.');
      let exported: { diagramId?: string; diagramRevision?: number; diagramSvg?: string } = {};
      if (diagram) {
        const saved = requireApiData(await api.getDiagram(diagram.sourceId));
        const assets = new Map<string, Blob>();
        for (const node of saved.document.nodes) {
          if (node.kind === 'image' && node.assetId && !assets.has(node.assetId)) assets.set(node.assetId, await api.getDiagramAsset(diagram.sourceId, node.assetId));
        }
        exported = { diagramId: diagram.sourceId, diagramRevision: saved.revision, diagramSvg: await diagramSvg(saved.document, assets, 'white') };
      }
      return requireApiData(await api.createDesignPackage(design.id, exported));
    },
    onSuccess: result => { setSnapshot(result); setConfirmation(null); setCommitUrl(null); },
  });
  const download = useMutation({
    mutationFn: async () => {
      if (!snapshot) throw new Error('Prepare a snapshot first.');
      const blob = await api.downloadDesignPackage(design.id, snapshot.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = `design-${snapshot.id}.zip`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
    },
  });
  const preparePublication = useMutation({
    mutationFn: async () => {
      if (!snapshot) throw new Error('Prepare a snapshot first.');
      return requireApiData(await api.prepareDesignPublication(design.id, snapshot.id, repo, folder));
    },
    onSuccess: setConfirmation,
  });
  const publish = useMutation({
    mutationFn: async () => {
      if (!snapshot || !confirmation) throw new Error('Review the publication destination first.');
      return requireApiData(await api.publishDesignPackage(design.id, snapshot.id, confirmation.id));
    },
    onSuccess: result => { setCommitUrl(result.commitUrl); },
  });
  const busy = create.isPending || download.isPending || preparePublication.isPending || publish.isPending;
  const error = create.error ?? download.error ?? preparePublication.error ?? publish.error;
  return <AppDialog title="Copilot Design package" wide onClose={onClose} actions={
    <button type="button" className="kh-btn-ghost" disabled={busy} onClick={onClose}>Close</button>}>
    <div className="kh-design-handoff">
      <p>Keep Markdown requirements, interactive HTML intent and diagram context separate. Download and GitHub use the exact same immutable snapshot; no AI runs during export.</p>
      <button type="button" className="kh-btn-accent" disabled={busy} onClick={() => { create.mutate(); }}>
        {create.isPending ? 'Preparing package...' : snapshot ? 'Create a new snapshot' : 'Prepare snapshot'}</button>
      {snapshot && <>
        <p className={snapshot.manifest.ready ? 'kh-design-hint' : 'kh-uc-error'} role="status">
          {snapshot.manifest.ready ? 'Current complete package.' : 'Incomplete / open decisions — not labelled ready.'}
          {snapshot.manifest.missingInputs.length > 0 && ` Missing: ${snapshot.manifest.missingInputs.join(', ')}.`}
          {snapshot.manifest.pendingFeedback > 0 && ` ${snapshot.manifest.pendingFeedback} unaccepted feedback item(s).`}
        </p>
        {snapshot.manifest.openDecisions.length > 0 && <ul>{snapshot.manifest.openDecisions.map((item, index) => <li key={index}>{item}</li>)}</ul>}
        <p className="kh-design-hint">Snapshot {snapshot.id}</p>
        <ul className="kh-design-files">{snapshot.manifest.files.map(file => <li key={file.path}><strong>{file.path}</strong><span>{file.role}</span></li>)}<li><strong>manifest.json</strong><span>IDs, revisions and file hashes</span></li></ul>
        <button type="button" className="kh-btn-ghost" disabled={busy} onClick={() => { download.mutate(); }}>{download.isPending ? 'Downloading...' : 'Download archive'}</button>
        <h3>Publish this snapshot to GitHub</h3>
        <label className="kh-uc-field"><span className="kh-uc-field__label">Configured writable repository</span>
          <select className="kh-uc-input" disabled={busy || repositories.isLoading || !!commitUrl} value={repo} onChange={event => { setRepo(event.target.value); setConfirmation(null); }}>
            <option value="">Choose a repository</option>
            {repo && !repositories.data?.items.some(item => item.name === repo) && <option value={repo}>{repo}</option>}
            {repositories.data?.items.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select></label>
        {(repoPage > 1 || repositories.data?.hasMore) && <div className="kh-design-actions">
          <button type="button" className="kh-btn-ghost" disabled={repoPage === 1 || busy} onClick={() => { setRepoPage(value => value - 1); }}>Previous repositories</button>
          <button type="button" className="kh-btn-ghost" disabled={!repositories.data?.hasMore || busy} onClick={() => { setRepoPage(value => value + 1); }}>More repositories</button>
        </div>}
        {repositories.isError && <p className="kh-uc-error" role="alert">{describeApiError(repositories.error)} <button type="button" className="kh-btn-ghost" onClick={() => { void repositories.refetch(); }}>Retry</button></p>}
        <label className="kh-uc-field"><span className="kh-uc-field__label">Destination folder</span>
          <input className="kh-uc-input" disabled={busy || !!commitUrl} maxLength={160} value={folder} onChange={event => { setFolder(event.target.value); setConfirmation(null); }} /></label>
        {!commitUrl && <button type="button" className="kh-btn-ghost" disabled={busy || !repo || !folder.trim()} onClick={() => { preparePublication.mutate(); }}>
          {preparePublication.isPending ? 'Checking destination...' : 'Review publication destination'}</button>}
        {confirmation && !commitUrl && <div className="kh-design-confirmation">
          <h4>Confirm publication</h4>
          <p>Publish snapshot <strong>{snapshot.id}</strong> to <strong>{confirmation.repo}</strong>, branch <strong>{confirmation.branch}</strong>, folder <strong>{confirmation.folder}</strong>.</p>
          <p>One coherent commit. Unrelated files are preserved. A changed destination blocks publication.</p>
          <button type="button" className="kh-btn-accent" disabled={busy} onClick={() => { publish.mutate(); }}>{publish.isPending ? 'Publishing and verifying...' : 'Confirm and publish package'}</button>
        </div>}
        {commitUrl && <p role="status">Package published and verified. <a className="kh-uc-link" href={commitUrl} target="_blank" rel="noreferrer">Open the commit</a></p>}
      </>}
      {error && <p className="kh-uc-error" role="alert">{describeApiError(error)}</p>}
    </div>
  </AppDialog>;
};
