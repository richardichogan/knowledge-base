import React, { createContext, useContext, useEffect, useState } from 'react';
import { Button } from '@carbon/react';

const PAGE_SIZE = 25;
export const HealthTablePageContext = createContext<((label: string, page: number, total: number) => void) | null>(null);

export const HealthDataTable: React.FC<{
  label: string;
  headers: React.ReactNode;
  rows: React.ReactNode[];
  className?: string;
}> = ({ label, headers, rows, className = '' }) => {
  const [requestedPage, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pages - 1);
  const start = page * PAGE_SIZE;
  const reportPage = useContext(HealthTablePageContext);
  useEffect(() => { reportPage?.(label, page + 1, rows.length); }, [reportPage, label, page, rows.length]);
  return (
    <div className="kh-health__paged-table">
      <div className="kh-health__table-wrap" tabIndex={0} role="region" aria-label={label}>
        <table className={`kh-health__table ${className}`}>
          <thead>{headers}</thead>
          <tbody>{rows.slice(start, start + PAGE_SIZE)}</tbody>
        </table>
      </div>
      <nav className="kh-health__pagination kh-health__actions" aria-label={`${label} pagination`}>
        <span aria-live="polite">{rows.length === 0 ? '0 rows' : `${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length} rows`} · 25 per page</span>
        <Button size="sm" kind="ghost" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label={`Previous page: ${label}`}>Previous</Button>
        <span>Page {page + 1} of {pages}</span>
        <Button size="sm" kind="ghost" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} aria-label={`Next page: ${label}`}>Next</Button>
      </nav>
    </div>
  );
};
