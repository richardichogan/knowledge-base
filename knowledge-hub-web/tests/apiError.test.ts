import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeApiError, requireApiData, requireApiSuccess } from '../src/services/apiError';

test('project saves show server validation details rather than the generic HTTP status', () => {
  assert.equal(describeApiError({
    isAxiosError: true,
    message: 'Request failed with status code 422',
    response: { data: { success: false, error: { message: 'goal must be a string of at most 2000 characters' } } },
  }), 'goal must be a string of at most 2000 characters');
});

test('failed envelopes throw, while valid empty responses remain valid empty data', () => {
  const failure = { success: false as const, error: { code: 'TEST', message: 'Unavailable, not empty' } };
  assert.throws(() => requireApiData(failure), /Unavailable, not empty/);
  assert.throws(() => requireApiSuccess(failure), /Unavailable, not empty/);
  assert.deepEqual(requireApiData({ success: true, data: [] }), []);
  assert.equal(requireApiData({ success: true, data: null }), null);
  assert.equal(requireApiData({ success: true, data: undefined }), undefined);
});

test('malformed server errors and network failures retain their original message', () => {
  const error = Object.assign(new Error('Network Error'), { isAxiosError: true, response: { data: 'Unavailable' } });
  assert.equal(describeApiError(error), 'Network Error');
  assert.equal(describeApiError(new Error('Save failed')), 'Save failed');
  assert.equal(describeApiError(new Error('The diagram could not be saved. Retry before continuing.')),
    'The diagram could not be saved. Retry before continuing.');
});
