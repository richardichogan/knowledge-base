import React, { useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark } from '@carbon/icons-react';
import { api, type DiscoverItem } from '../../services/api';
import { requireApiData } from '../../services/apiError';
import type { ParkingSelection } from '../../types/discover';
import { hasParkingDestination, parkingLabel } from '../../features/discover/parkingLot';
import { DataNotice } from '../DataNotice';
import '../../styles/discoverParking.scss';

export function DiscoverParkingAction({ item }: { item: DiscoverItem }): React.ReactElement {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ParkingSelection | null>(null);
  const [message, setMessage] = useState('');
  const pending = useRef(false);
  const client = useQueryClient();
  const key = ['discover-parking', item.id];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => requireApiData(await api.getDiscoverParking(item.id)),
    initialData: item.parking,
    enabled: open,
  });
  const saved = query.data;
  const selection = draft ?? saved ?? { newsletter: false, podcast: false };
  const mutation = useMutation({
    mutationFn: async (value: ParkingSelection | null) => value === null
      ? requireApiData(await api.removeDiscoverParking(item.id))
      : requireApiData(await api.saveDiscoverParking(item.id, value)),
    onSuccess: (record) => {
      client.setQueryData(key, record);
      void client.invalidateQueries({ queryKey: ['discover'] });
      setMessage(record ? `Parked for ${parkingLabel(record).toLowerCase()}.` : 'Removed from the parking lot. Article unchanged.');
      setDraft(null);
      setOpen(false);
    },
    onSettled: () => { pending.current = false; },
  });
  const change = (value: ParkingSelection | null): void => {
    if (pending.current) return;
    pending.current = true;
    mutation.mutate(value);
  };
  return <div className="dc-parking" onClick={event => { event.stopPropagation(); }} onKeyDown={event => { event.stopPropagation(); }}>
    <div className="dc-parking__heading">
      {saved && <span className="dc-parking__label">{parkingLabel(saved)}</span>}
      <button type="button" className="dc-parking__button" aria-expanded={open} aria-controls={panelId}
        disabled={mutation.isPending} onClick={() => { setOpen(value => !value); setDraft(null); setMessage(''); mutation.reset(); }}>
        <Bookmark size={14} /> {saved ? 'Edit parking' : 'Park for later'}
      </button>
    </div>
    {message && <p className="dc-parking__status" role="status">{message}</p>}
    {open && <div id={panelId} className="dc-parking__editor" aria-busy={query.isFetching || mutation.isPending}>
      {query.isPending && <p className="dc-parking__hint" role="status">Loading parking selection...</p>}
      {query.isError && <DataNotice title="Parking selection unavailable" error={query.error}
        onRetry={() => { void query.refetch(); }} busy={query.isFetching} />}
      {query.isSuccess && <form onSubmit={event => { event.preventDefault(); if (hasParkingDestination(selection) && !query.isFetching) change(selection); }}>
        <fieldset disabled={mutation.isPending || query.isFetching}>
          <legend>Keep for a future...</legend>
          <div className="dc-parking__choices">
            <label><input type="checkbox" checked={selection.newsletter}
              onChange={event => { setDraft({ ...selection, newsletter: event.target.checked }); }} />Newsletter</label>
            <label><input type="checkbox" checked={selection.podcast}
              onChange={event => { setDraft({ ...selection, podcast: event.target.checked }); }} />Podcast</label>
          </div>
        </fieldset>
        <p className="dc-parking__hint">Choose either or both. This does not schedule, publish or change the article's status.</p>
        <div className="dc-parking__actions">
          <button type="submit" className="dc-parking__button dc-parking__button--primary"
            disabled={mutation.isPending || query.isFetching || !hasParkingDestination(selection)}>
            {mutation.isPending ? 'Saving...' : 'Save to parking lot'}
          </button>
          {saved && <button type="button" className="dc-parking__button" disabled={mutation.isPending || query.isFetching}
            onClick={() => { change(null); }}>Remove from parking lot</button>}
        </div>
      </form>}
      {mutation.isError && <DataNotice title="Parking change was not saved — your choices are retained" error={mutation.error} />}
    </div>}
  </div>;
}
