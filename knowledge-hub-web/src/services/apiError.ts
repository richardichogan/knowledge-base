import { isAxiosError } from 'axios';

export function describeApiError(error: unknown): string {
  if (isAxiosError(error)) {
    const body: unknown = error.response?.data;
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const detail = body.error;
      if (typeof detail === 'object' && detail !== null && 'message' in detail &&
        typeof detail.message === 'string') return detail.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
