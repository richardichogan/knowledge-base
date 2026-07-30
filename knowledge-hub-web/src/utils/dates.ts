/**
 * Small date helpers shared across features (working-day math, ISO formatting).
 */

/** Returns a new Date, `days` working days (Mon–Fri) after `from`. */
export function addWorkingDays(from: Date, days: number): Date {
  const result = new Date(from);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return result;
}

/** Formats a Date as YYYY-MM-DD. */
export function toISODateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
