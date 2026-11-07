/**
 * components/athena/AthenaNews.tsx — the short "What's new" list at the top of Athena, shown after
 * opening her from a badged launcher. Each row links to where the item lives.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Close } from '@carbon/icons-react';
import { useAthenaContext } from '../../context/AthenaContext';

const TONE_LABEL = { proposal: 'Proposal', paused: 'Paused work', reply: 'Answer' } as const;

export const AthenaNews: React.FC = () => {
  const { news, showNews } = useAthenaContext();
  if (!news || news.length === 0) return null;
  const remove = (id: string): void => { const rest = news.filter((n) => n.id !== id); showNews(rest.length ? rest : null); };
  return (
    <section className="kh-athena-news" aria-labelledby="kh-athena-news-title">
      <header className="kh-athena-news__header">
        <h2 id="kh-athena-news-title">What's new</h2>
        <button type="button" className="kh-athena-news__close" aria-label="Dismiss what's new" onClick={() => { showNews(null); }}>
          <Close size={16} />
        </button>
      </header>
      <ul className="kh-athena-news__list">
        {news.map((n) => (
          <li key={n.id}>
            <Link to={n.to} className={`kh-athena-news__item kh-athena-news__item--${n.tone}`} onClick={() => { remove(n.id); }}>
              <span className="kh-athena-news__tone">{TONE_LABEL[n.tone]}</span>
              <span className="kh-athena-news__label">{n.label}</span>
              {n.detail && <span className="kh-athena-news__detail">{n.detail}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
};
