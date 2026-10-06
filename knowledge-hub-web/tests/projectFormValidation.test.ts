import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseExpectedOutputs, validateProjectContext } from '../src/services/projectFormValidation';

test('expected outputs preserve full descriptions and more than 30 entries', () => {
  const outputs = Array.from({ length: 40 }, (_, i) => `Deliverable ${i}: ${'Detailed scope. '.repeat(200)}`);
  assert.deepEqual(parseExpectedOutputs(`\r\n${outputs.join('\r\n\r\n')}\r\n`), outputs.map((value) => value.trim()));
});

test('remaining context limits match backend validation without truncating input', () => {
  assert.equal(validateProjectContext({ goal: 'g'.repeat(2000), role: 'r'.repeat(200), ownership: 'o'.repeat(200) }), null);
  for (const field of ['goal', 'role', 'ownership'] as const) {
    const input = { goal: '', role: '', ownership: '', [field]: 'x'.repeat(field === 'goal' ? 2001 : 201) };
    const original = input[field];
    assert.match(validateProjectContext(input)!, /Your text has not been changed/);
    assert.equal(input[field], original);
  }
});
