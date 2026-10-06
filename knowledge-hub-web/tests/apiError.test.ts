import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeApiError } from '../src/services/apiError';

test('project saves show server validation details rather than the generic HTTP status', () => {
  assert.equal(describeApiError({
    isAxiosError: true,
    message: 'Request failed with status code 422',
    response: { data: { success: false, error: { message: 'goal must be a string of at most 2000 characters' } } },
  }), 'goal must be a string of at most 2000 characters');
});

test('malformed server errors and network failures retain their original message', () => {
  const error = Object.assign(new Error('Network Error'), { isAxiosError: true, response: { data: 'Unavailable' } });
  assert.equal(describeApiError(error), 'Network Error');
  assert.equal(describeApiError(new Error('Save failed')), 'Save failed');
});
