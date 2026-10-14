/**
 * features/sparks/RelatedSparks.tsx
 * Sparks captured from, or connected to, a note — shown in the note's Connections side tab.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Idea } from '@carbon/icons-react';
import { api } from '../../services/api';
import { formatSparkDate } from './sparkUtils';

export const RelatedSparks: React.FC<{ refId: string; refType: string }> = ({ refId, refType }) => {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['sparks', 'related', refType, refId],
    queryFn: () => api.listRelatedSparks(refId, refType),
    staleTime: 30_000,
  });
  const sparks = data?.success ? data.data : [];
  if (isLoading || sparks.length === 0) return null;
  return (
    <section className="related-sparks" aria-label="Related sparks">
      <div className="related-sparks__head">
        <h3 className="related-sparks__title"><Idea size={14} /> Sparks</h3>
        <button type="button" className="related-sparks__open" onClick={() => { void navigate('/think?view=sparks'); }}>Open Sparks</button>
      </div>
      <ul className="related-sparks__list">
        {sparks.map((s) => (
          <li key={s.id} className="related-sparks__item">
            <p className="related-sparks__body">{s.body}</p>
            <span className="related-sparks__meta">
              {s.relation === 'captured' ? 'Captured here' : 'Connected'} · {formatSparkDate(s.createdAt)}
              {s.clusterId !== null && ' · In a theme'}
              {s.usedType && ` · Used in ${s.usedType}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
};
