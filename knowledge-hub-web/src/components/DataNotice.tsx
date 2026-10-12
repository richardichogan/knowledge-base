import React from 'react';
import { Button, InlineNotification } from '@carbon/react';
import { describeApiError } from '../services/apiError';

export const DataNotice: React.FC<{
  title: string; error: unknown; onRetry?: () => void; busy?: boolean;
}> = ({ title, error, onRetry, busy = false }) => (
  <div className="kh-data-notice">
    <InlineNotification kind="error" title={title} subtitle={describeApiError(error)} lowContrast hideCloseButton />
    {onRetry !== undefined && <Button kind="ghost" size="sm" disabled={busy} onClick={onRetry}>Retry</Button>}
  </div>
);
