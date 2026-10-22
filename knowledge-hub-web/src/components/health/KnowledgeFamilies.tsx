import React from 'react';
import { InlineNotification } from '@carbon/react';
import type { HealthFamilies, HealthSection } from '../../services/api';
import {
  countCell, errorSummary, extractionSummary, FAMILY_STATE_LABEL, SEMANTIC_STATE_LABEL, stateTone,
} from '../../pages/knowledgeHealthModel';

const number = new Intl.NumberFormat('en-GB');
const when = (iso: string | null): string => (iso === null ? 'Never' : new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }));

/**
 * Per-family capability and coverage for Knowledge health. A section that cannot be read affects only
 * this section; unmeasured values say so instead of showing zero or a percentage.
 */
export const KnowledgeFamilies: React.FC<{ section: HealthSection<HealthFamilies> | undefined }> = ({ section }) => {
  if (section === undefined) {
    return <p className="kh-health__note">This server does not report per-family coverage yet.</p>;
  }
  if (!section.available) {
    return <InlineNotification kind="warning" title="Coverage unavailable" subtitle={section.message} lowContrast hideCloseButton />;
  }
  const { families, semantic, orchestrationEnabled } = section.data;
  return (
    <>
      <dl className="kh-health__stats">
        <div><dt>Semantic search</dt><dd className="kh-health__stat-text">{SEMANTIC_STATE_LABEL[semantic.state]}</dd></div>
        <div><dt>Indexing work pending</dt><dd>{countCell(semantic.work.pending, number.format)}</dd></div>
        <div><dt>Indexing work failed</dt><dd>{countCell(semantic.work.failed, number.format)}</dd></div>
        <div><dt>Orchestration</dt><dd className="kh-health__stat-text">{orchestrationEnabled ? 'On' : 'Off (previous tools)'}</dd></div>
        <div><dt>Last successful sync</dt><dd className="kh-health__stat-text">{when(section.data.lastSuccessfulSyncAt)}</dd></div>
      </dl>
      <p className="kh-health__note">
        {semantic.message} A connected provider does not mean everything is indexed. Eligible counts are not recorded, so no coverage
        percentage is shown.
      </p>
      <div className="kh-health__table-wrap" tabIndex={0} role="region" aria-label="Knowledge coverage by record family">
        <table className="kh-health__table kh-health__table--families">
          <thead>
            <tr>
              <th>Family</th><th>State</th><th>Capabilities</th><th>Indexed</th><th>Eligible</th><th>Pending</th><th>Failed</th>
              <th>Extraction</th><th>Last indexed</th><th>Errors</th>
            </tr>
          </thead>
          <tbody>
            {families.map((family) => (
              <tr key={family.kind}>
                <td><strong>{family.kind}</strong><div className="kh-health__note">{family.reason}</div></td>
                <td><span className={`kh-health__state kh-health__state--${stateTone(family.state)}`}>{FAMILY_STATE_LABEL[family.state]}</span></td>
                <td>{family.capabilities.join(', ')}</td>
                <td>{countCell(family.counts.indexed, number.format)}</td>
                <td>{countCell(family.counts.eligible, number.format)}</td>
                <td>{countCell(family.counts.pending, number.format)}</td>
                <td>{countCell(family.counts.failed, number.format)}</td>
                <td>{extractionSummary(family, number.format)}</td>
                <td>{family.sources.length === 0 ? 'Read live' : when(family.lastIndexedAt)}</td>
                <td>{errorSummary(family)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};
