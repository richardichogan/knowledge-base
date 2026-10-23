import React from 'react';
import type { AthenaMarkState } from '../../chat/athenaMotion';

export interface AthenaMarkElement extends HTMLElement { level: number }

export const AthenaMark: React.FC<{
  state: AthenaMarkState;
  mode?: 'text' | 'voice';
  markRef?: React.RefObject<AthenaMarkElement>;
}> = ({ state, mode = 'text', markRef }) => React.createElement('athena-mark', {
  ref: markRef, state, mode, size: '28', variant: 'ticks', silent: '',
});
