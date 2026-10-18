/**
 * HandoffDialog — sends a use case's spec to GitHub (for GitHub Copilot to build) or to
 * Athena Build, then shows the prompt to paste into GitHub Copilot.
 */
import React, { useId, useState } from 'react';
import { Copy, Launch } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import { AppDialog } from '../../components/AppDialog';
import { useHandoffUseCase } from '../../hooks/useUseCases';
import { describeApiError } from '../../services/apiError';
import type { HandoffResult, UseCaseDetail } from '../../types/useCases';
import { defaultHandoffPath } from './useCaseView';

type Mode = 'github' | 'build';

export const HandoffDialog: React.FC<{ useCase: UseCaseDetail; onClose: () => void }> = ({ useCase, onClose }) => {
  const id = useId();
  const [mode, setMode] = useState<Mode>('github');
  const [repo, setRepo] = useState(useCase.handoffRepo ?? useCase.repo ?? '');
  const [path, setPath] = useState(useCase.handoffPath ?? defaultHandoffPath(useCase.title, useCase.productKind));
  const [result, setResult] = useState<HandoffResult | null>(null);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const handoff = useHandoffUseCase();
  const repoValid = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo.trim());

  const submit = (): void => {
    if (!repoValid || handoff.isPending) return;
    handoff.mutate({ id: useCase.id, input: { mode, repo: repo.trim(), ...(mode === 'github' ? { path: path.trim() } : {}) } }, {
      onSuccess: (r) => { setResult(r); },
    });
  };
  const copy = async (text: string): Promise<void> => {
    try { await navigator.clipboard.writeText(text); setCopied('copied'); } catch { setCopied('failed'); }
  };

  if (result !== null) {
    return (
      <AppDialog key="done" title="Handed off" tone="success" wide onClose={onClose} actions={
        <button type="button" className="kh-btn-accent" data-dialog-autofocus onClick={onClose}>Done</button>}>
        {result.mode === 'github' ? (
          <div className="kh-uc-handoff">
            <p className="kh-uc-handoff__lead">
              The spec is publishing to <strong>{result.path}</strong> in {repo.trim()}.
              {result.url !== null && <> <a className="kh-uc-link" href={result.url} target="_blank" rel="noreferrer">Open on GitHub <Launch size={14} /></a></>}
            </p>
            <label className="kh-uc-field" htmlFor={`${id}-prompt`}>
              <span className="kh-uc-field__label">Paste this into GitHub Copilot in that repository</span>
              <textarea id={`${id}-prompt`} className="kh-uc-input kh-uc-input--area kh-uc-input--mono" rows={10} readOnly value={result.prompt ?? ''} />
            </label>
            <div className="kh-uc-row">
              <button type="button" className="kh-btn-ghost" onClick={() => { void copy(result.prompt ?? ''); }}>
                <Copy size={16} /> {copied === 'copied' ? 'Copied' : 'Copy prompt'}
              </button>
              {copied === 'failed' && <span className="kh-uc-error" role="alert">Copy was blocked; select the text and copy it instead.</span>}
            </div>
          </div>
        ) : (
          <p className="kh-uc-handoff__lead">
            An Athena Build spec was created for {repo.trim()}. Review its task plan before starting it.{' '}
            <Link className="kh-uc-link" to="/build" onClick={onClose}>Open Build</Link>
          </p>
        )}
      </AppDialog>
    );
  }

  return (
    <AppDialog key="form" title="Hand off the spec" wide onClose={onClose} actions={<>
      <button type="button" className="kh-btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="kh-btn-accent" disabled={!repoValid || handoff.isPending || (mode === 'github' && path.trim() === '')} onClick={submit}>
        {handoff.isPending ? 'Handing off…' : mode === 'github' ? 'Push spec to GitHub' : 'Create Build spec'}
      </button>
    </>}>
      <form className="kh-uc-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <fieldset className="kh-uc-modes">
          <legend className="kh-uc-field__label">Who builds it</legend>
          <label className={`kh-uc-mode${mode === 'github' ? ' kh-uc-mode--active' : ''}`}>
            <input type="radio" name={`${id}-mode`} value="github" checked={mode === 'github'} onChange={() => { setMode('github'); }} data-dialog-autofocus />
            <span className="kh-uc-mode__title">GitHub Copilot</span>
            <span className="kh-uc-mode__hint">Pushes the spec into the repo and gives you a prompt to start the work.</span>
          </label>
          <label className={`kh-uc-mode${mode === 'build' ? ' kh-uc-mode--active' : ''}`}>
            <input type="radio" name={`${id}-mode`} value="build" checked={mode === 'build'} onChange={() => { setMode('build'); }} />
            <span className="kh-uc-mode__title">Athena Build</span>
            <span className="kh-uc-mode__hint">Creates a Build spec that splits the work into tasks for cloud agents.</span>
          </label>
        </fieldset>
        <label className="kh-uc-field" htmlFor={`${id}-repo`}>
          <span className="kh-uc-field__label">Repository (owner/name)</span>
          <input id={`${id}-repo`} className="kh-uc-input" value={repo} placeholder="owner/name" aria-invalid={repo !== '' && !repoValid}
            onChange={(e) => { setRepo(e.target.value); }} />
        </label>
        {mode === 'github' && (
          <label className="kh-uc-field" htmlFor={`${id}-path`}>
            <span className="kh-uc-field__label">File path in the repository</span>
            <input id={`${id}-path`} className="kh-uc-input kh-uc-input--mono" value={path} onChange={(e) => { setPath(e.target.value); }} />
          </label>
        )}
        {handoff.isError && <p className="kh-uc-error" role="alert">{describeApiError(handoff.error)}</p>}
      </form>
    </AppDialog>
  );
};
