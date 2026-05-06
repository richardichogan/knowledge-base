/**
 * components/sparks/SparkCaptureButton.tsx
 * Flash icon button that sits alongside Discover card actions.
 * Clicking toggles the InlineSparkCapture component.
 */
import React, { useState } from 'react';
import { Flash } from '@carbon/icons-react';
import { InlineSparkCapture } from './InlineSparkCapture';

interface SparkCaptureButtonProps {
  sourceId: string;
  sourceType: string;
  initialTags?: string[];
}

export const SparkCaptureButton: React.FC<SparkCaptureButtonProps> = ({
  sourceId, sourceType, initialTags = [],
}) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className={`dc-action dc-action--spark${open ? ' dc-action--spark-active' : ''}`}
        title="Capture a spark"
        onClick={() => { setOpen((v) => !v); }}
      >
        <Flash size={14} /> Spark
      </button>
      {open && (
        <InlineSparkCapture
          sourceId={sourceId}
          sourceType={sourceType}
          initialTags={initialTags}
          onClose={() => { setOpen(false); }}
        />
      )}
    </>
  );
};
