import { createReactBlockSpec } from '@blocknote/react';

export const SOURCE_CAPTION_TYPE = 'sourceCaption';
export const SOURCE_CAPTION_LABEL = 'Source: ';

export const sourceCaptionSpec = createReactBlockSpec(
  { type: SOURCE_CAPTION_TYPE, propSchema: {}, content: 'inline' },
  {
    render: ({ contentRef }) => (
      <div className="kh-source-caption">
        <span className="kh-source-caption__label" contentEditable={false}>Source:</span>
        <div className="kh-source-caption__text" ref={contentRef} role="textbox" aria-label="Source of the block above" />
      </div>
    ),
    toExternalHTML: ({ contentRef }) => (
      <p>{SOURCE_CAPTION_LABEL}<span ref={contentRef} /></p>
    ),
  },
)();
