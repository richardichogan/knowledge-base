/**
 * components/library/OneDriveStatus.tsx — OneDrive (IBM Alliance tenant)
 * connection strip on the Library page: connect / reconnect, last sync,
 * document count, errors, and "Sync now". Makes an expired sign-in visible
 * instead of failing silently in the background.
 */
import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, API_BASE_URL } from '../../services/api';

function ago(iso: string | null): string {
  if (iso === null) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins.toString()}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours.toString()}h ago` : `${Math.round(hours / 24).toString()}d ago`;
}

export const OneDriveStatus: React.FC = () => {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Result of the sign-in redirect (?onedrive=connected|error).
  useEffect(() => {
    const result = params.get('onedrive');
    if (result === null) return;
    setNotice(result === 'connected'
      ? { kind: 'ok', text: `OneDrive connected as ${params.get('account') ?? 'you'} — first sync started.` }
      : { kind: 'error', text: `OneDrive connection failed: ${params.get('reason') ?? 'unknown error'}` });
    ['onedrive', 'account', 'reason'].forEach((k) => { params.delete(k); });
    setParams(params, { replace: true });
  }, [params, setParams]);

  const { data } = useQuery({
    queryKey: ['alliance-status'],
    queryFn: async () => { const r = await api.getAllianceStatus(); return r.success ? r.data : null; },
    refetchInterval: (q) => (q.state.data?.syncRunning === true ? 5_000 : 60_000),
  });

  if (data == null || !data.configured) return null;
  const connectHref = `${API_BASE_URL}/auth/alliance`;

  return (
    <div className={`onedrive-status${data.connected ? '' : ' onedrive-status--disconnected'}`} role="status">
      <span className={`onedrive-status__dot${data.connected ? ' onedrive-status__dot--ok' : ''}`} aria-hidden="true" />
      <span className="onedrive-status__label">OneDrive (Alliance)</span>
      {data.connected ? (
        <span className="onedrive-status__detail">
          {data.account} · {data.sync.documentCount} document{data.sync.documentCount === 1 ? '' : 's'} from /{data.root}
          {' · '}{data.syncRunning ? 'syncing…' : `synced ${ago(data.sync.lastSyncAt)}`}
        </span>
      ) : (
        <span className="onedrive-status__detail">{data.lastError ?? 'Not connected'}</span>
      )}
      {(notice !== null || (data.connected && data.sync.lastError)) && (
        <span className={`onedrive-status__notice onedrive-status__notice--${notice?.kind ?? 'error'}`}>
          {notice?.text ?? data.sync.lastError}
        </span>
      )}
      <span className="onedrive-status__spacer" />
      {data.connected ? (
        <button
          type="button"
          className="kb-import-btn"
          disabled={data.syncRunning}
          onClick={() => { void api.syncOneDrive().then(() => qc.invalidateQueries({ queryKey: ['alliance-status'] })); }}
        >
          {data.syncRunning ? 'Syncing…' : 'Sync now'}
        </button>
      ) : null}
      <a className="kb-import-btn" href={connectHref}>{data.connected ? 'Reconnect' : 'Connect OneDrive'}</a>
    </div>
  );
};
