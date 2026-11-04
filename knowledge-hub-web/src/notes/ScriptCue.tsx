import React from 'react';
import { createReactInlineContentSpec } from '@blocknote/react';

export const scriptCueSpec = createReactInlineContentSpec({
  type: 'scriptCue',
  propSchema: { cue: { default: 'pause', values: ['pause', 'beat'] } },
  content: 'none',
}, {
  render: ({ inlineContent }) => <span className="kh-script-cue" contentEditable={false}
    aria-label={`${inlineContent.props.cue} visual delivery cue`}>{inlineContent.props.cue.toUpperCase()}</span>,
  toExternalHTML: ({ inlineContent }) => <span data-script-cue={inlineContent.props.cue}>{`[${inlineContent.props.cue}]`}</span>,
  parse: (element): { cue: 'pause' | 'beat' } | undefined => {
    const cue = element.dataset['scriptCue'];
    return cue === 'pause' || cue === 'beat' ? { cue } : undefined;
  },
});
