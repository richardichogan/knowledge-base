import React, { useState } from 'react';
import { Button, Checkbox, InlineLoading, Tag, TextInput } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataNotice } from '../components/DataNotice';
import { api } from '../services/api';
import type { PacketCandidate, ReviewPacket, ReviewPacketItem } from '../services/api';
import { describeApiError, requireApiData } from '../services/apiError';

const TYPE_LABEL = { note: 'Note', output: 'Output', decision: 'Decision' } as const;
const STATE_LABEL: Record<ReviewPacketItem['state'], string> = { current: 'Unchanged', changed: 'Changed since capture', missing: 'No longer available' };

function download(filename: string, markdown: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const key = (c: { sourceType: string; sourceId: string }): string => `${c.sourceType}:${c.sourceId}`;

const PacketView: React.FC<{ projectId: string; packetId: string; onDeleted: () => void }> = ({ projectId, packetId, onDeleted }) => {
  const qc = useQueryClient();
  const [acknowledge, setAcknowledge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const packet = useQuery<ReviewPacket>({
    queryKey: ['review-packet', projectId, packetId],
    queryFn: async () => requireApiData(await api.getReviewPacket(projectId, packetId)),
    retry: false, refetchOnWindowFocus: false,
  });
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['review-packet', projectId, packetId] });
    void qc.invalidateQueries({ queryKey: ['review-packets', projectId] });
  };
  const act = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => { await run(); },
    onSuccess: () => { setError(null); refresh(); },
    onError: (err) => setError(describeApiError(err)),
  });

  if (packet.isLoading) return <InlineLoading description="Loading packet…" />;
  if (packet.error || !packet.data) return <DataNotice title="The packet could not be loaded." error={packet.error} onRetry={() => { void packet.refetch(); }} />;
  const p = packet.data;
  const approved = p.status === 'approved';

  return (
    <div className="pcp-packet">
      {error && <DataNotice title="That did not complete." error={error} />}
      {p.staleCount > 0 && !approved && (
        <p className="pcp-stale" role="status">{p.staleCount} source{p.staleCount === 1 ? '' : 's'} changed or went missing since this packet was created. The packet still holds the captured copy.</p>
      )}
      <ol className="pcp-packet__items">
        {p.items.map((item) => (
          <li key={item.position}>
            <Checkbox id={`pk-${p.id}-${item.position}`} labelText={`Reviewed: ${item.label}`} checked={item.checked} disabled={approved || act.isPending}
              onChange={(_, { checked }) => act.mutate(() => api.setReviewPacketItemChecked(projectId, p.id, item.position, checked).then(requireApiData))} />
            <span className="pcp-meta">
              <Tag size="sm" type="gray">{TYPE_LABEL[item.sourceType]}</Tag>{' '}
              <Tag size="sm" type={item.state === 'current' ? 'green' : 'red'}>{STATE_LABEL[item.state]}</Tag>{' '}
              captured {item.capturedIdentity} · <a href={item.href}>Open source</a>
            </span>
          </li>
        ))}
      </ol>
      <div className="pcp-packet__actions">
        <Button size="sm" kind="tertiary" disabled={act.isPending}
          onClick={() => act.mutate(async () => { const out = requireApiData(await api.exportReviewPacket(projectId, p.id)); download(out.filename, out.markdown); })}>
          Export Markdown
        </Button>
        {!approved && (
          <>
            {p.staleCount > 0 && (
              <Checkbox id={`ack-${p.id}`} labelText="Approve even though sources changed" checked={acknowledge} onChange={(_, { checked }) => setAcknowledge(checked)} />
            )}
            <Button size="sm" disabled={act.isPending || (p.staleCount > 0 && !acknowledge)}
              onClick={() => act.mutate(() => api.approveReviewPacket(projectId, p.id, acknowledge).then(requireApiData))}>
              Record approval
            </Button>
          </>
        )}
        <Button size="sm" kind="danger--ghost" disabled={act.isPending}
          onClick={() => act.mutate(async () => { await api.deleteReviewPacket(projectId, p.id); onDeleted(); })}>Delete</Button>
      </div>
      <p className="pcp-meta">{approved ? 'Approval is recorded only. Nothing is published, posted or started.' : 'Recording approval does not publish, post or start any work.'}</p>
    </div>
  );
};

const Builder: React.FC<{ projectId: string; onCreated: (id: string) => void }> = ({ projectId, onCreated }) => {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const candidates = useQuery({
    queryKey: ['packet-candidates', projectId],
    queryFn: async () => requireApiData(await api.getPacketCandidates(projectId)),
    retry: false, refetchOnWindowFocus: false,
  });
  const create = useMutation({
    mutationFn: async () => {
      const byKey = new Map((candidates.data?.items ?? []).map((c: PacketCandidate) => [key(c), c]));
      const items = selected.flatMap((k) => { const c = byKey.get(k); return c ? [{ sourceType: c.sourceType, sourceId: c.sourceId }] : []; });
      return requireApiData(await api.createReviewPacket(projectId, { title: title.trim(), items }));
    },
    onSuccess: (made) => {
      setError(null); setTitle(''); setSelected([]);
      void qc.invalidateQueries({ queryKey: ['review-packets', projectId] });
      onCreated(made.id);
    },
    onError: (err) => setError(describeApiError(err)),
  });

  if (candidates.isLoading) return <InlineLoading description="Loading sources…" />;
  if (candidates.error || !candidates.data) return <DataNotice title="Sources could not be loaded." error={candidates.error} onRetry={() => { void candidates.refetch(); }} />;
  const items = candidates.data.items;
  return (
    <form className="pcp-builder" onSubmit={(e) => { e.preventDefault(); if (title.trim() !== '' && selected.length > 0) create.mutate(); }}>
      <TextInput id="pk-title" labelText="Packet title" size="sm" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      {items.length === 0 ? <p className="pcp-empty">This project has no notes, outputs or decisions to include yet.</p> : (
        <fieldset className="pcp-builder__sources">
          <legend>Choose what to include (the order you pick is the packet order)</legend>
          {items.map((c) => {
            const k = key(c);
            const at = selected.indexOf(k);
            return (
              <Checkbox key={k} id={`pk-src-${k}`} labelText={`${at >= 0 ? `${at + 1}. ` : ''}${TYPE_LABEL[c.sourceType]}: ${c.label}`} checked={at >= 0}
                onChange={(_, { checked }) => setSelected((prev) => (checked ? [...prev, k] : prev.filter((x) => x !== k)))} />
            );
          })}
        </fieldset>
      )}
      {error && <DataNotice title="The packet was not created. Your selection is kept." error={error} />}
      <Button type="submit" size="sm" disabled={title.trim() === '' || selected.length === 0 || create.isPending}>Create packet</Button>
    </form>
  );
};

export const ReviewPackets: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [openId, setOpenId] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const list = useQuery({
    queryKey: ['review-packets', projectId],
    queryFn: async () => requireApiData(await api.getReviewPackets(projectId)),
    retry: false, refetchOnWindowFocus: false,
  });
  return (
    <section className="pcp-block" aria-label="Review packets">
      <h3>Review packets{list.data && <span className="pcp-count">{list.data.length}</span>}</h3>
      <p className="pcp-meta">A packet is a fixed copy of the notes, outputs and decisions you choose, for review. It never publishes or starts anything.</p>
      {list.isLoading ? <InlineLoading description="Loading packets…" /> : list.error ? (
        <DataNotice title="Review packets could not be loaded." error={list.error} onRetry={() => { void list.refetch(); }} />
      ) : (
        <ul className="pcp-list">
          {list.data?.map((p) => (
            <li key={p.id}>
              <Button kind="ghost" size="sm" aria-expanded={openId === p.id} onClick={() => setOpenId(openId === p.id ? null : p.id)}>{p.title}</Button>
              <span className="pcp-meta">{p.itemCount} items · {p.status === 'approved' ? 'Approved' : 'Draft'}</span>
              {openId === p.id && <PacketView projectId={projectId} packetId={p.id} onDeleted={() => setOpenId(null)} />}
            </li>
          ))}
        </ul>
      )}
      {building
        ? <Builder projectId={projectId} onCreated={(id) => { setBuilding(false); setOpenId(id); }} />
        : <Button size="sm" kind="tertiary" onClick={() => setBuilding(true)}>New review packet</Button>}
    </section>
  );
};
