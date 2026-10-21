import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autocueScriptText } from '../src/features/autocue/scriptText';
import { presentationScript } from '../src/features/autocue/presentationScript';
import { AUTOCUE_FONT_KEY, AUTOCUE_SENSITIVITY_KEY, readAutocueSettings } from '../src/features/autocue/settings';

test('teleprompters retain authored line breaks, blank blocks and inline formatting boundaries', () => {
  const document = JSON.stringify([
    { type: 'paragraph', content: [{ text: 'Opening ' }, { text: 'emphasis', styles: { bold: true } },
      { type: 'hardBreak' }, { text: 'Next line\nThird line' }] },
    { type: 'paragraph', content: [] },
    { type: 'paragraph', content: [{ type: 'link', content: [{ text: 'Closing' }] }] },
  ]);
  const expected = 'Opening emphasis\nNext line\nThird line\n\n\n\nClosing';
  assert.equal(autocueScriptText(document), expected);
  assert.equal(presentationScript(document).text, expected);
  assert.equal(autocueScriptText('First line\r\nSecond line\r\n\r\nNew paragraph'), 'First line\nSecond line\n\nNew paragraph');
  assert.throws(() => autocueScriptText('{}'), /block document/);
});

test('font size and sensitivity survive reopening a browser teleprompter session', () => {
  const values = new Map([[AUTOCUE_FONT_KEY, '80'], [AUTOCUE_SENSITIVITY_KEY, '0.12']]);
  const storage = { getItem: (key: string) => values.get(key) ?? null };
  const first = readAutocueSettings(storage, 0.05, null);
  const reopened = readAutocueSettings(storage, 0.05, null);
  assert.deepEqual(reopened, { fontSize: 80, sensitivity: 0.12, error: '' });
  assert.deepEqual(first, reopened);
  assert.equal(readAutocueSettings(storage, 0.05, '0.2').sensitivity, 0.2);
  assert.deepEqual(readAutocueSettings({ getItem: () => null }, 0.25, null),
    { fontSize: 64, sensitivity: 0.25, error: '' });
  values.set(AUTOCUE_FONT_KEY, 'Infinity');
  values.set(AUTOCUE_SENSITIVITY_KEY, '-10');
  const invalid = readAutocueSettings(storage, 0.05, null);
  assert.equal(invalid.fontSize, 64);
  assert.equal(invalid.sensitivity, 0.05);
  assert.match(invalid.error, /invalid teleprompter setting/);
  assert.throws(() => readAutocueSettings({ getItem: () => { throw new Error('Storage blocked'); } }, 0.05, null), /Storage blocked/);
});
