import React from 'react';
import { createReactInlineContentSpec } from '@blocknote/react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { requireApiData } from '../services/apiError';
import { entityLinkHref, type EntityLinkType } from './entityLinks';
import { linkLabel, setLinkLabel } from './linkLabels';
import { openLinkPreview } from './linkPreview';

function EntityMention({ type, id }: { type: EntityLinkType; id: string }): React.ReactElement {
  const navigate = useNavigate();
  const { data, error, isPending } = useQuery({
    queryKey: ['entity-link', type, id],
    queryFn: async () => {
      const result = requireApiData(await api.getLinkTargets('', type, id));
      const title = result[0]?.title;
      setLinkLabel(type, id, title);
      return result[0] ?? null;
    },
    staleTime: 15_000,
    retry: 1,
  });
  const text = error ? 'Link lookup failed' : isPending ? `Loading ${type}...` : data?.title ?? `Unavailable ${type}`;
  return <span className="note-mention-wrap" contentEditable={false}>
    <a className={`note-mention${!data ? ' note-mention--unavailable' : ''}`}
      href={data?.href ?? entityLinkHref(type, id)} aria-disabled={!data}
      title={error ? 'Could not look up this link. Reopen the note to retry.' : undefined}
      onClick={event => {
        if (!data || (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0)) {
          event.preventDefault();
          if (data && !openLinkPreview(data)) {
            if (/^https?:\/\//i.test(data.href)) window.open(data.href, '_blank', 'noopener,noreferrer');
            else navigate(data.href);
          }
        }
      }}>{text}</a>
  </span>;
}

function externalLink(type: EntityLinkType, id: string): React.ReactElement {
  return <a href={new URL(entityLinkHref(type, id), window.location.origin).href}>
    {linkLabel(type, id)}
  </a>;
}

export const noteMentionSpec = createReactInlineContentSpec({
  type: 'noteMention',
  propSchema: { noteId: { default: '' } },
  content: 'none',
}, {
  render: ({ inlineContent }) => <EntityMention type="note" id={inlineContent.props.noteId} />,
  toExternalHTML: ({ inlineContent }) => externalLink('note', inlineContent.props.noteId),
});

export const entityMentionSpec = createReactInlineContentSpec({
  type: 'entityMention',
  propSchema: { entityType: { default: 'spark', values: ['spark', 'diagram', 'project', 'task', 'usecase', 'article'] }, entityId: { default: '' } },
  content: 'none',
}, {
  render: ({ inlineContent }) => <EntityMention type={inlineContent.props.entityType} id={inlineContent.props.entityId} />,
  toExternalHTML: ({ inlineContent }) => externalLink(inlineContent.props.entityType, inlineContent.props.entityId),
});
