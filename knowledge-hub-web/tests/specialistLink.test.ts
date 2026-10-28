import test from 'node:test';
import assert from 'node:assert/strict';
import { specialistLink } from '../src/navigation/specialistLink';

test('a blog notification opens over the current workspace and retains its query and hash', () => {
  assert.equal(
    specialistLink('?blogJob=123', 'https://athena.example/think?noteId=abc#section'),
    '/think?noteId=abc&blogJob=123#section',
  );
  assert.equal(specialistLink('/think?design=123', 'https://athena.example/plan'), '/think?design=123');
});
