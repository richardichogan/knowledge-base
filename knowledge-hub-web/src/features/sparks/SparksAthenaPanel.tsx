/**
 * features/sparks/SparksAthenaPanel.tsx
 * Athena side panel for the Sparks page, with the user's themes and loose sparks as page context.
 */
import React, { useMemo } from 'react';
import type { AthenaPageContext } from '../../context/AthenaContext';
import { ThinkAthenaPanel } from '../../notes/ThinkAthenaPanel';
import { useLooseSparks, useSparkThemes } from './sparkQueries';
import { sparksContextDetail } from './sparkUtils';

export const SparksAthenaPanel: React.FC<{
  onBusyChange: (busy: boolean) => void;
  promptRequest?: { prompt: string; sequence: number } | undefined;
}> = ({ onBusyChange, promptRequest }) => {
  const { themes } = useSparkThemes();
  const { sparks } = useLooseSparks();
  const pageContext = useMemo<AthenaPageContext>(() => ({
    type: 'spark', title: 'Sparks', id: 'sparks', detail: sparksContextDetail(themes, sparks),
  }), [themes, sparks]);
  return <ThinkAthenaPanel pageContext={pageContext} onBusyChange={onBusyChange} promptRequest={promptRequest} />;
};
