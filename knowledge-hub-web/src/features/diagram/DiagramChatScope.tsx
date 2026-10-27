import React, { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AthenaPageContext } from '../../context/AthenaContext';
import { ThinkAthenaPanel } from '../../notes/ThinkAthenaPanel';

interface ChatTarget {
  key: string; element: HTMLDivElement; context: AthenaPageContext;
  prompt: { prompt: string; sequence: number } | undefined;
}
interface Scope { update: (target: ChatTarget) => void; remove: (key: string) => void }
const DiagramChatContext = createContext<Scope | null>(null);
export function useDiagramChatScope(): Scope | null { return useContext(DiagramChatContext); }

export function DiagramChatProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [host] = useState(() => document.createElement('div'));
  const [targets, setTargets] = useState<ChatTarget[]>([]);
  const last = useRef<ChatTarget>();
  const scope = useMemo<Scope>(() => ({
    update: target => { setTargets(current => current.some(item => item.key === target.key)
      ? current.map(item => item.key === target.key ? target : item) : [...current, target]); },
    remove: key => { setTargets(current => current.filter(item => item.key !== key)); },
  }), []);
  const active = targets[targets.length - 1];
  const activeElement = active?.element;
  if (active) last.current = active;
  useLayoutEffect(() => {
    host.className = 'dg-chat-host';
    if (activeElement) {
      if (host.parentElement !== activeElement) activeElement.appendChild(host);
    }
    else host.remove();
  }, [host, activeElement]);
  // A stable portal container preserves the actual chat component, draft and live turn.
  return <DiagramChatContext.Provider value={scope}>
    {children}
    {last.current && createPortal(<ThinkAthenaPanel pageContext={last.current.context} promptRequest={last.current.prompt} />, host)}
  </DiagramChatContext.Provider>;
}

export function DiagramChatTarget({ context, prompt, visible }: {
  context: AthenaPageContext; prompt: ChatTarget['prompt']; visible: boolean;
}): React.ReactElement {
  const scope = useContext(DiagramChatContext);
  const key = useId();
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (visible && element.current) scope?.update({ key, element: element.current, context, prompt });
    else scope?.remove(key);
  }, [scope, key, context, prompt, visible]);
  useEffect(() => () => { scope?.remove(key); }, [scope, key]);
  return <div className="dg-chat-target" ref={element} />;
}
