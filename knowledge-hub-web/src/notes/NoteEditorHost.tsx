import React, { createContext, useCallback, useContext, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AthenaRibbon } from '../components/athena/AthenaRibbon';
import { MetadataPanel, type MetadataPanelProps } from './MetadataPanel';

interface EditorChrome {
  metadata: MetadataPanelProps;
  showMetadata: boolean;
  actions: React.ReactNode;
  actionsSlot: HTMLElement | null | undefined;
  header: React.ReactNode;
  viewToggle: React.ReactNode;
  loading: boolean;
}

const EditorHostContext = createContext<((chrome: EditorChrome | null) => void) | null>(null);

/** Workspace-owned chrome stays mounted while document-local editors change. */
export const NoteEditorHost: React.FC<{ enabled: boolean; loading: boolean; children: React.ReactNode }> = ({ enabled, loading, children }) => {
  const [binding, setBinding] = useState<{ chrome: EditorChrome; active: boolean } | null>(null);
  const publish = useCallback((chrome: EditorChrome | null) => {
    setBinding(previous => chrome ? { chrome, active: true } : previous ? { ...previous, active: false } : null);
  }, []);
  const chrome = binding?.chrome;
  const pending = enabled && (loading || !binding?.active || chrome?.loading === true);
  const actions = chrome && <fieldset className="notes-editor-lock" disabled={pending} aria-label="Document actions">
    {chrome.actions}
  </fieldset>;
  return <EditorHostContext.Provider value={publish}>
    <div className="notes-editor-panel notes-editor-host">
      <div className="notes-editor-centre">
        {enabled && chrome && (chrome.actionsSlot ? createPortal(actions, chrome.actionsSlot) : actions)}
        {enabled && <fieldset className="notes-editor-lock" disabled={pending} aria-label="Document navigation">
          {chrome?.header}
          {chrome?.viewToggle}
        </fieldset>}
        <div className="notes-editor-host__document" aria-busy={pending}>
          {children}
          {pending && <div className="notes-editor-host__loading" role="status" aria-label="Loading note">
            <AthenaRibbon size={88} mood="resting" label="Loading note" />
            <span>Loading note...</span>
          </div>}
        </div>
      </div>
      <div className="notes-editor-host__metadata" hidden={!enabled || !chrome?.showMetadata}>
        {chrome && <MetadataPanel {...chrome.metadata} writingBusy={pending || chrome.metadata.writingBusy === true} />}
      </div>
    </div>
  </EditorHostContext.Provider>;
};

export function useHostedNoteEditor(chrome: EditorChrome): boolean {
  const publish = useContext(EditorHostContext);
  // Updating the host does not rerender its unchanged children or reset their document-local state.
  useLayoutEffect(() => { publish?.(chrome); });
  useLayoutEffect(() => () => { publish?.(null); }, [publish]);
  return publish !== null;
}
