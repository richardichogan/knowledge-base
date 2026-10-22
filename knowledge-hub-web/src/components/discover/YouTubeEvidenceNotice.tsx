import React from 'react';
import { Launch } from '@carbon/icons-react';
import type { DiscoverItem } from '../../services/api';

/** Separates video evidence availability from independently sourced subject background. */
export function YouTubeEvidenceNotice({ item }: { item: Pick<DiscoverItem, 'contentBasis' | 'relatedArticles'> }): React.ReactElement {
  return <>
    {item.contentBasis === 'description-only' && <p className="dc-explore__hint">YouTube video: description only. Captions may be unavailable or not yet checked. Any secondary background sources are not a transcript; spoken claims have not been verified.</p>}
    {item.contentBasis === 'captions' && <p className="dc-explore__hint">YouTube public captions retrieved. Captions may be automatically generated, incomplete or inaccurate; consult the video before quoting.</p>}
    {(item.relatedArticles?.length ?? 0) > 0 && (
      <section className="dc-explore__section">
        <h3>Related background reading</h3>
        <p className="dc-explore__hint">Sources found about the subject, not a transcript or verification of what the video says.</p>
        <ul className="dc-explore__list dc-explore__reading">
          {item.relatedArticles?.map(article => (
            <li key={article.url}><a href={article.url} target="_blank" rel="noreferrer">{article.title} <Launch size={14} /></a></li>
          ))}
        </ul>
      </section>
    )}
  </>;
}
