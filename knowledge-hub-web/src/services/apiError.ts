import { isAxiosError } from 'axios';
import type { ApiResponse, ApiSuccess } from '../types/apiResponse';

export function requireApiSuccess<T>(response: ApiResponse<T>): ApiSuccess<T> {
  if (!response.success) throw new Error(response.error.message);
  return response;
}

export function requireApiData<T>(response: ApiResponse<T>): T {
  return requireApiSuccess(response).data;
}

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
