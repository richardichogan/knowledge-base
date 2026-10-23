import React from 'react';
import type { AthenaMood } from '../../chat/athenaMood';

export interface AthenaRibbonElement extends HTMLElement { mood: AthenaMood; level: number | null }

export const AthenaRibbon: React.FC<{
  mood?: AthenaMood;
  size?: number;
  track?: boolean;
  silent?: boolean;
  still?: boolean;
  interaction?: 'idle' | 'typing' | 'voice' | undefined;
  label?: string;
  className?: string;
  ribbonRef?: React.RefObject<AthenaRibbonElement>;
}> = ({ mood = 'resting', size = 32, track = false, silent = true, still = false, interaction, label, className = '', ribbonRef }) =>
  React.createElement('athena-ribbon', {
    ref: ribbonRef, mood, size: String(size), interaction, label, class: `athena-ribbon ${className}`.trim(),
    ...(track && { track: '' }), ...(silent && { silent: '' }), ...(still && { still: '' }),
  });
