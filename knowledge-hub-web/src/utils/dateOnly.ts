export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dateOnlyToLocal(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || year === undefined || month === undefined || day === undefined) throw new Error('Invalid date-only value');
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime()) || localDateKey(date) !== value) throw new Error('Invalid date-only value');
  return date;
}
