const DAYS_PER_WEEK = 7;
const SUNDAY_TO_MONDAY_OFFSET = 6;
const ISO_DATE_LENGTH = 10;
export function ukClock(now = new Date()): { day: string; hour: number; weekday: string; week: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find(part => part.type === type)?.value ?? '';
  const day = `${value('year')}-${value('month')}-${value('day')}`;
  const midnight = new Date(`${day}T00:00:00Z`);
  midnight.setUTCDate(midnight.getUTCDate() - ((midnight.getUTCDay() + SUNDAY_TO_MONDAY_OFFSET) % DAYS_PER_WEEK));
  return { day, hour: Number(value('hour')), weekday: value('weekday'), week: midnight.toISOString().slice(0, ISO_DATE_LENGTH) };
}
