import React, { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { describeApiError } from '../services/apiError';
import './muralIntegration.scss';

export const MURAL_BOARDS_QUERY = ['mural-boards'] as const;

export const MuralBoardPicker: React.FC<{
  value: string; onChange: (url: string) => void; disabled?: boolean; label?: string;
}> = ({ value, onChange, disabled = false, label = 'Destination board' }) => {
  const id = useId();
  const [manual, setManual] = useState(false);
  const query = useQuery({
    queryKey: MURAL_BOARDS_QUERY,
    queryFn: async () => {
      const response = await api.getMuralBoards();
      if (!response.success) throw new Error(response.error.message);
      return response.data;
    },
    staleTime: 60_000,
    retry: false,
  });
  const boards = query.data?.items ?? [];
  const workspaces = [...new Set(boards.map(board => board.workspace))];
  const listed = boards.some(board => board.url === value);
  const safeDestination = /^https:\/\/app\.mural\.co\/t\/[a-z0-9_-]+\/m\/[a-z0-9_-]+\/\d+(?:\/[a-f0-9]+)?\/?(?:[?#].*)?$/i.test(value);
  return <div className="mural-board-picker">
    <label className="mural-integration__field" htmlFor={id}>
      {label}
      {manual ? <input id={id} type="url" value={value} required disabled={disabled} maxLength={2048}
        placeholder="https://app.mural.co/t/.../m/..." onChange={event => { onChange(event.target.value); }} />
        : <select id={id} value={value} disabled={disabled || query.isPending || boards.length === 0}
          aria-describedby={`${id}-status`} onChange={event => { onChange(event.target.value); }}>
          <option value="" disabled>{query.isPending ? 'Loading boards...' : 'Choose a board'}</option>
          {value && !listed && <option value={value}>Current destination (not listed)</option>}
          {workspaces.map(workspace => <optgroup key={workspace} label={workspace}>
            {boards.filter(board => board.workspace === workspace).map(board =>
              <option key={board.id} value={board.url} disabled={board.archived}>
                {board.title || 'Untitled board'}{board.archived ? ' (archived)' : ''}
              </option>)}
          </optgroup>)}
        </select>}
    </label>
    <div id={`${id}-status`} className="mural-board-picker__status">
      {query.isPending && <p role="status">Loading boards from your Mural workspaces...</p>}
      {query.isError && <p className="mural-board-picker__error" role="alert">{describeApiError(query.error)}</p>}
      {query.data?.warnings.map(warning => <p key={warning} role="status">{warning}</p>)}
      {query.isSuccess && boards.length === 0 && <p>No boards were found for this Mural account. Create one in Mural or enter its URL.</p>}
      {!manual && value && !listed && !query.isPending && <p>The current destination is not in this list. Choose a board above or use its URL.</p>}
    </div>
    <div className="mural-board-picker__actions">
      <button type="button" disabled={disabled} onClick={() => { setManual(!manual); }}>
        {manual ? 'Choose from my boards' : 'Enter board URL'}
      </button>
      <button type="button" disabled={disabled || query.isFetching} onClick={() => { void query.refetch(); }}>
        {query.isFetching ? 'Refreshing...' : 'Refresh boards'}
      </button>
      {safeDestination && <a href={value} target="_blank" rel="noreferrer">Open destination</a>}
    </div>
  </div>;
};
