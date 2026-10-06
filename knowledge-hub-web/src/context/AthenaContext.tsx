/**
 * AthenaContext — lets any page broadcast its current selection to
 * the FloatingAIChat widget so Athena is automatically primed with context.
 *
 * Usage (from a page/component that has a selected item):
 *   const { setAthenaContext } = useAthenaContext();
 *   setAthenaContext({ type: 'content-item', title: item.title, detail: item.summary });
 *
 * Clear on unmount or deselection:
 *   setAthenaContext(null);
 */

import React, { createContext, useContext, useState, useCallback, useRef } from 'react';

export interface AthenaPageContext {
  /** e.g. "content-item", "task", "note", "spark", "document" */
  type: string;
  /** Display title shown in the panel header and splash */
  title: string;
  /** Optional snippet of summary/body/detail for the AI */
  detail?: string;
  /**
   * Stable id of the underlying item (e.g. the note id), when known. Used by
   * the Think-embedded Athena panel to remember which chat belongs to which
   * note — not sent to the backend as part of the LLM-facing context.
   */
  id?: string;
  /**
   * Project the underlying item belongs to (e.g. the note's project). The
   * Think-embedded Athena panel grounds the conversation in it instead of
   * offering its own project picker.
   */
  projectId?: string;
  /**
   * Descriptions of images embedded in the item (vision analysis / OCR).
   * Sent alongside `detail`, never trimmed by the backend's excerpting.
   */
  images?: string;
  /** Mind map: the selected idea (Athena's map outline marks it). */
  selectedId?: string;
}

interface AthenaContextValue {
  pageContext: AthenaPageContext | null;
  setAthenaContext: (ctx: AthenaPageContext | null) => void;
  request: { prompt: string; sequence: number } | null;
  openAthena: (prompt: string, context: AthenaPageContext) => void;
  clearAthenaRequest: () => void;
  launchSequence: number;
  hasEmbeddedAthena: boolean;
  launchAthena: () => void;
  registerAthenaLauncher: (launcher: () => void) => () => void;
}

const AthenaContext = createContext<AthenaContextValue>({
  pageContext: null,
  setAthenaContext: () => undefined,
  request: null,
  openAthena: () => undefined,
  clearAthenaRequest: () => undefined,
  launchSequence: 0,
  hasEmbeddedAthena: false,
  launchAthena: () => undefined,
  registerAthenaLauncher: () => () => undefined,
});

export const AthenaContextProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [pageContext, setPageContext] = useState<AthenaPageContext | null>(null);
  const [request, setRequest] = useState<AthenaContextValue['request']>(null);
  const requestSequence = useRef(0);
  const [launchSequence, setLaunchSequence] = useState(0);
  const [hasEmbeddedAthena, setHasEmbeddedAthena] = useState(false);
  const embeddedLauncher = useRef<(() => void) | null>(null);
  const registerAthenaLauncher = useCallback((launcher: () => void): (() => void) => {
    embeddedLauncher.current = launcher;
    setHasEmbeddedAthena(true);
    return () => {
      if (embeddedLauncher.current !== launcher) return;
      embeddedLauncher.current = null;
      setHasEmbeddedAthena(false);
    };
  }, []);
  const launchAthena = useCallback((): void => {
    if (embeddedLauncher.current !== null) embeddedLauncher.current();
    else setLaunchSequence((value) => value + 1);
  }, []);
  const openAthena = useCallback((prompt: string, context: AthenaPageContext): void => {
    setPageContext(context);
    setRequest({ prompt, sequence: ++requestSequence.current });
  }, []);
  const clearAthenaRequest = useCallback(() => { setRequest(null); }, []);

  return (
    <AthenaContext.Provider value={{ pageContext, setAthenaContext: setPageContext, request, openAthena, clearAthenaRequest,
      launchSequence, hasEmbeddedAthena, launchAthena, registerAthenaLauncher }}>
      {children}
    </AthenaContext.Provider>
  );
};

export function useAthenaContext(): AthenaContextValue {
  return useContext(AthenaContext);
}
