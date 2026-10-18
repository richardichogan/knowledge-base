import React from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { requireApiData } from '../services/apiError';
import { CollapsibleSection } from '../components/CollapsibleSection';
import type { EntityLinkType } from './entityLinks';
import { openLinkPreview } from './linkPreview';

export function NoteBacklinks({ noteId, type = 'note' }: { noteId: string; type?: EntityLinkType }): React.ReactElement {
  const { data, isPending, error, refetch, fetchNextPage, hasNextPage, isFetching } = useInfiniteQuery({
    queryKey: ['note-backlinks', type, noteId],
    queryFn: async ({ pageParam }) => requireApiData(await api.getEntityBacklinks(type, noteId, pageParam)),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => last.hasMore ? pages.length + 1 : undefined,
    refetchInterval: 30_000,
    retry: 1,
  });
  return <CollapsibleSection label="Backlinks">
    <div className="note-backlinks">
      {isPending && <p role="status">Loading backlinks...</p>}
      {error && <p role="alert">Could not load backlinks. <button className="note-backlinks__button" type="button"
        disabled={isFetching} onClick={() => { void refetch(); }}>Retry</button></p>}
      {data && !data.pages[0]?.items.length && <p>No notes link here yet. Type @ or [[ in another note to add a link.</p>}
      {data?.pages.flatMap(page => page.items).map(item => <Link key={item.id} className="note-backlinks__link" to={item.href}
        onClick={event => {
          if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0 && openLinkPreview(item)) event.preventDefault();
        }}>{item.title}</Link>)}
      {hasNextPage && <button className="note-backlinks__button" type="button" disabled={isFetching}
        onClick={() => { void fetchNextPage(); }}>More backlinks</button>}
    </div>
  </CollapsibleSection>;
}
