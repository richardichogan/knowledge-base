import React, { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { requireApiData } from '../services/apiError';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { DataNotice } from '../components/DataNotice';
import { fetchNote, saveNote } from './noteStorage';
import { entityLinkHref, linkPlainMentions } from './entityLinks';
import { openLinkPreview } from './linkPreview';

export function UnlinkedMentions({ noteId }: { noteId: string }): React.ReactElement {
  const client = useQueryClient();
  const [linked, setLinked] = useState<string | null>(null);
  const list = useInfiniteQuery({
    queryKey: ['unlinked-mentions', noteId],
    queryFn: async ({ pageParam }) => requireApiData(await api.getUnlinkedNoteMentions(noteId, pageParam)),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => last.hasMore ? pages.length + 1 : undefined,
    refetchInterval: 30_000,
  });
  const link = useMutation({
    mutationFn: async (sourceId: string) => {
      const [source, targets] = await Promise.all([fetchNote(sourceId), api.getLinkTargets('', 'note', noteId).then(requireApiData)]);
      const target = targets[0];
      if (!source || !target) throw new Error('This note is no longer available.');
      const converted = linkPlainMentions(JSON.parse(source.contentJson), target);
      if (!converted.count) throw new Error('The mention has changed. Refresh this list before linking.');
      await saveNote({ ...source, contentJson: JSON.stringify(converted.blocks) });
      return source.title;
    },
    onSuccess: title => {
      setLinked(`Linked from ${title}.`);
      void client.invalidateQueries({ queryKey: ['note-backlinks'] });
      void client.invalidateQueries({ queryKey: ['unlinked-mentions'] });
      void client.invalidateQueries({ queryKey: ['notes-list'] });
      void client.invalidateQueries({ queryKey: ['link-preview'] });
    },
  });
  return <CollapsibleSection label="Unlinked mentions">
    <div className="note-backlinks">
      {list.isPending && <p role="status">Finding mentions...</p>}
      {list.error && <DataNotice title="Could not load unlinked mentions" error={list.error} onRetry={() => { void list.refetch(); }} />}
      {link.error && <DataNotice title="The mention was not linked" error={link.error} />}
      {linked && <p role="status">{linked}</p>}
      {list.data && !list.data.pages[0]?.items.length && <p>No unlinked mentions in other notes.</p>}
      {list.data?.pages.flatMap(page => page.items).map(item => <div className="note-backlinks__mention" key={item.id}>
        <Link className="note-backlinks__link" to={entityLinkHref('note', item.id)} onClick={event => {
          if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && openLinkPreview(item)) event.preventDefault();
        }}>{item.title}</Link>
        <button type="button" className="note-backlinks__button" disabled={link.isPending}
          onClick={() => { link.mutate(item.id); }}>{link.isPending && link.variables === item.id ? 'Linking...' : 'Link it'}</button>
      </div>)}
      {list.hasNextPage && <button type="button" className="note-backlinks__button" disabled={list.isFetching}
        onClick={() => { void list.fetchNextPage(); }}>More mentions</button>}
    </div>
  </CollapsibleSection>;
}
