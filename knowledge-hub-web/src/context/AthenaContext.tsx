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

import React, { createContext, useContext, useState } from 'react';

export interface AthenaPageContext {
  /** e.g. "content-item", "task", "note", "spark", "document" */
  type: string;
  /** Display title shown in the panel header and splash */
  title: string;
  /** Optional snippet of summary/body/detail for the AI */
  detail?: string;
}

interface AthenaContextValue {
  pageContext: AthenaPageContext | null;
  setAthenaContext: (ctx: AthenaPageContext | null) => void;
}

const AthenaContext = createContext<AthenaContextValue>({
  pageContext: null,
  setAthenaContext: () => undefined,
});

export const AthenaContextProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [pageContext, setPageContext] = useState<AthenaPageContext | null>(null);

  return (
    <AthenaContext.Provider value={{ pageContext, setAthenaContext: setPageContext }}>
      {children}
    </AthenaContext.Provider>
  );
};

export function useAthenaContext(): AthenaContextValue {
  return useContext(AthenaContext);
}
