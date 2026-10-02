/**
 * utils/tableExport.ts — "Download as Excel" on any table rendered by
 * renderMarkdown (chat replies, Outputs, canvas previews, documents …): one
 * click handler for the whole page, so every place that shows a table gets it.
 * The table's rows, as shown, become an .xlsx file built by the server.
 */

let installed = false;

export function installTableExport(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-xlsx-table]');
    if (btn) downloadTableAsExcel(btn);
  });
}

function downloadTableAsExcel(btn: HTMLButtonElement): void {
  const table = btn.closest('.kh-table-block')?.querySelector('table');
  if (!table || btn.disabled) return;
  const rows = [...table.rows].map((tr) => [...tr.cells].map((cell) => (cell.textContent ?? '').trim()));
  const header = rows[0]?.slice(0, 3).filter(Boolean).join(', ') ?? '';
  const filename = `Athena table${header !== '' ? ` - ${header}` : ''} ${new Date().toISOString().slice(0, 10)}`;
  const original = btn.textContent;
  btn.textContent = 'Preparing…';
  btn.disabled = true;
  // Loaded on demand: the API client isn't needed until someone downloads.
  void import('../services/api')
    .then(({ api }) => api.exportXlsx(filename, [{ name: 'Table', rows }]))
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filename.replace(/[^\w .,-]/g, '').slice(0, 80)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { URL.revokeObjectURL(url); }, 10_000);
      btn.textContent = 'Downloaded';
    })
    .catch(() => { btn.textContent = 'Couldn’t create the file'; })
    .finally(() => {
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2_000);
    });
}
