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

import React, { createContext, useContext, useState, useCallback, useRef, useMemo } from 'react';
import type { BackgroundWorkContext } from '../types/agentJobs';

export interface AthenaPageContext {
  designId?: string;
  designTab?: 'use_case' | 'spec' | 'architecture' | 'diagram';
  revision?: number;
  selectedIds?: { nodes: string[]; edges: string[] };
  saveState?: string;
  workContentId?: string;
  workContent?: import('../types/workContent').WorkContent;
  podcastEpisodeId?: string;
  podcastTab?: string;
  buildSpecId?: string;
  useCaseId?: string;
  /** e.g. "content-item", "task", "note", "spark", "document" */
  type: string;
  /** Display title shown in the panel header and splash */
  title: string;
  /** Optional snippet of summary/body/detail for the AI */
  detail?: string;
  /**
   * Stable id of the underlying item (e.g. the note id), when known. Used by
   * the Think-embedded Athena panel to remember which chat belongs to which
   * note. The server validates this identity against linked Design assets.
   */
  id?: string;
  /** Stable conversation owner while a nested diagram changes the active context. */
  conversationId?: string;
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

export interface ThinkNavigationContext {
  selectedTag: { id: string; path: string; filterTagIds: string[] } | null;
  selectedContentType: { id: string; label: string } | null;
  folders: Array<{ id: string; name: string; parentId: string | null }>;
  totalFolders: number;
  foldersHasMore: boolean;
  listCollapsed: boolean;
  filtersCollapsed: boolean;
  folderStatus: 'loading' | 'error' | 'ready';
  folderError?: string;
  search: string;
  sort: string;
  notes: Array<{ id: string; title: string }>;
  loadedNotes: number;
  totalNotes: number;
  hasMore: boolean;
  listStatus: 'loading' | 'error' | 'ready';
  listError?: string;
}

export interface NoteFilingContext {
  noteId: string;
  status: 'loading' | 'error' | 'ready';
  tags: Array<{ id: string; path: string; parentId: string | null }>;
  error?: string;
}

export function withThinkContext(page: AthenaPageContext | null, navigation: ThinkNavigationContext | null,
  filing: NoteFilingContext | null): AthenaPageContext | null {
  if (!navigation) return page;
  const active = page ?? { type: 'notes', title: 'Think' };
  const detail = [
    'Think navigation: the Filters section combines a content-type filter and tag folders; both apply to the list together. Tag folders are filters over existing tags, not physical folders. Parent folders include child tags. selectedContentType restricts the list to one content type. Listed notes are summaries, not evidence that their bodies were read. Read saved records before making content-specific claims. Use read_note_tags for current filing and paginated folder retrieval, and set_note_tags for requested filing changes.',
    JSON.stringify(navigation),
    filing?.noteId === active.id ? `Saved note filing: ${JSON.stringify(filing)}` : undefined,
    active.detail,
  ].filter(Boolean).join('\n\n');
  return { ...active, detail };
}

interface AthenaContextValue {
  backgroundWork: BackgroundWorkContext | null;
  setBackgroundWork: (context: BackgroundWorkContext | null) => void;
  pageContext: AthenaPageContext | null;
  setAthenaContext: (ctx: AthenaPageContext | null) => void;
  setThinkNavigation: (context: ThinkNavigationContext | null) => void;
  setNoteFiling: (context: NoteFilingContext | null) => void;
  request: { prompt: string; sequence: number } | null;
  openAthena: (prompt: string, context: AthenaPageContext) => void;
  clearAthenaRequest: () => void;
  launchSequence: number;
  hasEmbeddedAthena: boolean;
  launchAthena: () => void;
  registerAthenaLauncher: (launcher: () => void) => () => void;
  /** The floating chat window is open (pages without an embedded Athena panel). */
  floatOpen: boolean;
  setFloatOpen: (open: boolean) => void;
  /** "What's new" items shown at the top of Athena after opening her from a badged launcher. */
  news: AthenaNewsItem[] | null;
  showNews: (items: AthenaNewsItem[] | null) => void;
}

export interface AthenaNewsItem { id: string; label: string; detail?: string; to: string; tone: 'proposal' | 'paused' | 'reply' }

const AthenaContext = createContext<AthenaContextValue>({
  backgroundWork: null,
  setBackgroundWork: () => undefined,
  pageContext: null,
  setAthenaContext: () => undefined,
  setThinkNavigation: () => undefined,
  setNoteFiling: () => undefined,
  request: null,
  openAthena: () => undefined,
  clearAthenaRequest: () => undefined,
  launchSequence: 0,
  hasEmbeddedAthena: false,
  launchAthena: () => undefined,
  registerAthenaLauncher: () => () => undefined,
  floatOpen: false,
  setFloatOpen: () => undefined,
  news: null,
  showNews: () => undefined,
});

export const AthenaContextProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [backgroundWork, setBackgroundWork] = useState<BackgroundWorkContext | null>(null);
  const [pageContext, setPageContext] = useState<AthenaPageContext | null>(null);
  const [thinkNavigation, setThinkNavigation] = useState<ThinkNavigationContext | null>(null);
  const [noteFiling, setNoteFiling] = useState<NoteFilingContext | null>(null);
  const effectivePageContext = useMemo(() => withThinkContext(pageContext, thinkNavigation, noteFiling),
    [pageContext, thinkNavigation, noteFiling]);
  const [request, setRequest] = useState<AthenaContextValue['request']>(null);
  const requestSequence = useRef(0);
  const [launchSequence, setLaunchSequence] = useState(0);
  const [hasEmbeddedAthena, setHasEmbeddedAthena] = useState(false);
  const embeddedLauncher = useRef<(() => void) | null>(null);
  const [floatOpen, setFloatOpen] = useState(false);
  const [news, showNews] = useState<AthenaNewsItem[] | null>(null);
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
    <AthenaContext.Provider value={{ backgroundWork, setBackgroundWork, pageContext: effectivePageContext,
      setAthenaContext: setPageContext, setThinkNavigation, setNoteFiling, request, openAthena, clearAthenaRequest,
      launchSequence, hasEmbeddedAthena, launchAthena, registerAthenaLauncher,
      floatOpen, setFloatOpen, news, showNews }}>
      {children}
    </AthenaContext.Provider>
  );
};

export function useAthenaContext(): AthenaContextValue {
  return useContext(AthenaContext);
}
