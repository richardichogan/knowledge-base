import React from 'react';
import { Close, Renew } from '@carbon/icons-react';
import { useAppUpdate } from '../hooks/useAppUpdate';

/** Slim bar offering a reload when a newer Athena build has been deployed. */
export const AppUpdateBar: React.FC<{ className?: string }> = ({ className }) => {
  const { available, dismiss } = useAppUpdate();
  if (!available) return null;
  return (
    <div className={`kh-update-bar${className ? ` ${className}` : ''}`} role="status">
      <Renew size={16} className="kh-update-bar__icon" aria-hidden="true" />
      <span className="kh-update-bar__text">A new version of Athena is available</span>
      <button type="button" className="kh-update-bar__reload" onClick={() => { window.location.reload(); }}>
        Reload
      </button>
      <button type="button" className="kh-update-bar__dismiss" aria-label="Dismiss update notice" onClick={dismiss}>
        <Close size={16} />
      </button>
    </div>
  );
};
