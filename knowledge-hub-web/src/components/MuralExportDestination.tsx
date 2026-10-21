import React, { useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type MuralBoardOption, type MuralList } from '../services/api';
import { describeApiError } from '../services/apiError';
import { MuralBoardPicker, MURAL_BOARDS_QUERY } from './MuralBoardPicker';

export const MURAL_ROOMS_QUERY = ['mural-rooms'] as const;

export const MuralExportDestination: React.FC<{
  value: string; title: string; disabled: boolean; onChange: (url: string) => void;
}> = ({ value, title, disabled, onChange }) => {
  const id = useId();
  const cache = useQueryClient();
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [previous, setPrevious] = useState(value);
  const [name, setName] = useState(title.slice(0, 300));
  const [roomId, setRoomId] = useState('');
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState('');
  const rooms = useQuery({
    queryKey: MURAL_ROOMS_QUERY, enabled: mode === 'new', retry: false, staleTime: 60_000,
    queryFn: async () => {
      const response = await api.getMuralRooms();
      if (!response.success) throw new Error(response.error.message);
      return response.data;
    },
  });
  const locked = disabled || busy;
  async function create(): Promise<void> {
    if (locked || creating.current || !roomId || !name.trim()) return;
    creating.current = true; setBusy(true); setError('');
    try {
      const response = await api.createMuralBoard({ roomId: Number(roomId), title: name.trim() });
      if (!response.success) throw new Error(response.error.message);
      const board = { ...response.data, workspace: rooms.data?.items.find(room => room.id === Number(roomId))?.workspace ?? response.data.workspace };
      cache.setQueryData<MuralList<MuralBoardOption>>(MURAL_BOARDS_QUERY, old => ({
        items: [...(old?.items ?? []).filter(item => item.id !== board.id), board]
          .sort((a, b) => a.workspace.localeCompare(b.workspace) || a.title.localeCompare(b.title)),
        warnings: old?.warnings ?? [],
      }));
      onChange(board.url); setPrevious(board.url); setCreated(board.title); setMode('existing');
    } catch (err) { setError(`${describeApiError(err)} Check the room in Mural before creating another board.`); }
    finally { creating.current = false; setBusy(false); }
  }
  return <div className="mural-export-destination">
    <div className="mural-export-destination__modes" role="group" aria-label="Mural destination">
      <button type="button" aria-pressed={mode === 'existing'} disabled={locked} onClick={() => {
        if (mode !== 'existing') { setMode('existing'); onChange(previous); }
      }}>Add to existing Mural</button>
      <button type="button" aria-pressed={mode === 'new'} disabled={locked} onClick={() => {
        if (mode !== 'new') { setPrevious(value); onChange(''); setMode('new'); setCreated(''); }
      }}>Create a new Mural</button>
    </div>
    {mode === 'existing' ? <MuralBoardPicker value={value} disabled={locked} onChange={onChange} /> : <>
      <label className="mural-integration__field" htmlFor={`${id}-room`}>Room
        <select id={`${id}-room`} value={roomId} disabled={locked || rooms.isPending || !rooms.data?.items.length}
          onChange={event => { setRoomId(event.target.value); }}>
          <option value="" disabled>{rooms.isPending ? 'Loading rooms...' : 'Choose a room'}</option>
          {[...new Set(rooms.data?.items.map(room => room.workspace) ?? [])].map(workspace =>
            <optgroup key={workspace} label={workspace}>{rooms.data?.items.filter(room => room.workspace === workspace).map(room =>
              <option key={room.id} value={room.id}>{room.name}</option>)}</optgroup>)}
        </select>
      </label>
      {rooms.isPending && <p className="dg-popover__hint" role="status">Loading your Mural rooms...</p>}
      {rooms.isError && <p className="mural-board-picker__error" role="alert">{describeApiError(rooms.error)}</p>}
      {rooms.data?.warnings.map(warning => <p className="dg-popover__hint" key={warning} role="status">{warning}</p>)}
      {rooms.isSuccess && rooms.data.items.length === 0 && <p className="dg-popover__hint">No rooms found. Create a room in Mural, then refresh. Mural requires room-owner permission to create a board.</p>}
      <div className="mural-board-picker__actions"><button type="button" disabled={locked || rooms.isFetching}
        onClick={() => { void rooms.refetch(); }}>Refresh rooms</button></div>
      <label className="mural-integration__field" htmlFor={`${id}-name`}>New Mural name
        <input id={`${id}-name`} value={name} maxLength={300} disabled={locked}
          onChange={event => { setName(event.target.value); }} />
      </label>
      <p className="dg-popover__hint">Create an empty board in a room you own, then send the diagram below. Existing boards are unchanged.</p>
      <button type="button" className="dg-primary-btn" disabled={locked || !roomId || !name.trim() || Boolean(error)}
        onClick={() => { void create(); }}>{busy ? 'Creating Mural...' : 'Create and select Mural'}</button>
      {error && <div className="mural-board-picker__status">
        <p className="mural-board-picker__error" role="alert">{error}</p>
        <div className="mural-board-picker__actions"><button type="button" disabled={locked}
          onClick={() => { setError(''); }}>I checked Mural; allow another attempt</button></div>
      </div>}
    </>}
    {created && <p className="dg-popover__hint" role="status">Created "{created}" and selected it. Send the diagram below when ready.</p>}
  </div>;
};
