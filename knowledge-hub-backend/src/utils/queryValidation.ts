import { ValidationError } from '../types/errors.js';

export function positiveInteger(value: unknown, name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ValidationError(`${name} must be a positive integer`, { [name]: 'Must be a positive integer' });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ValidationError(`${name} must be a positive integer`, { [name]: 'Must be a positive integer' });
  }
  return Math.min(parsed, maximum);
}

export function queryDate(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const validShape = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value);
  if (!validShape || typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(`${value.slice(0, 'YYYY-MM-DD'.length)}T00:00:00Z`).toISOString().slice(0, 'YYYY-MM-DD'.length) !== value.slice(0, 'YYYY-MM-DD'.length)) {
    throw new ValidationError(`${name} must be a valid date`, { [name]: 'Must be a valid date' });
  }
  return new Date(value).toISOString();
}
