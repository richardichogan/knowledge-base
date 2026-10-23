import React from 'react';
import type { AthenaMarkState } from '../../chat/athenaMotion';
import { AthenaRibbon, type AthenaRibbonElement } from './AthenaRibbon';

export type AthenaMarkElement = AthenaRibbonElement;

export const AthenaMark: React.FC<{
  state: AthenaMarkState;
  mode?: 'text' | 'voice';
  markRef?: React.RefObject<AthenaMarkElement>;
  size?: number;
}> = ({ state, markRef, size = 32 }) => <AthenaRibbon {...(markRef && { ribbonRef: markRef })} mood={state} size={size} />;
