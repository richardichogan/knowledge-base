import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import {
  createPowerPointFile, createWordFile, deliverySlides, extractDeliverableContent,
  type DeliveryContent,
} from '../src/work/officeExport.js';

const markdown = '## Evidence\n\n- **Saved evidence**, not inferred completion.\n\n## Comparison\n\n| Topic | Status |\n| --- | --- |\n| Source | Read |\n';
const content: DeliveryContent = {
  title: 'Outcome brief', markdown, revision: 1, noteRevision: 1, taskId: null, fileStem: 'Outcome brief',
};

test('OFFICE-01: only a nonempty final deliverable section can be exported', () => {
  assert.equal(extractDeliverableContent(`# Instructions\n\nKeep this private.\n\n# Deliverable content\n\n${markdown}`), markdown.trim());
  for (const body of [
    '# Instructions\n\nNo finished content.',
    '# Deliverable content\n\n',
    '## Deliverable content\n\nText.',
    '# Deliverable content\n\nText.\n\n# More instructions\n\nDo not export.',
    '# Deliverable content\n\nText.\n\n# Deliverable content\n\nDuplicate.',
    '# Deliverable content\n\n![Image](https://example.com/image.png)',
    '# Deliverable content\n\n![Image][source]\n\n[source]: https://example.com/image.png',
    '# Deliverable content\n\n<video src="https://example.com/video.mp4"></video>',
  ]) assert.throws(() => extractDeliverableContent(body), body);
});

test('OFFICE-02: slide boundaries and readability limits are enforced', () => {
  assert.equal(deliverySlides(markdown).length, 2);
  assert.throws(() => deliverySlides('Content with no slide heading.'));
  assert.throws(() => deliverySlides(`## Slide\n\n${'x'.repeat(1801)}`));
  assert.throws(() => deliverySlides(`## ${'x'.repeat(121)}\n\nText.`));
  assert.throws(() => deliverySlides(`## Slide\n\nText.\n\n| One |\n| --- |\n| Cell |`));
  assert.throws(() => deliverySlides(Array.from({ length: 61 }, (_, index) => `## Slide ${index}\n\nText.`).join('\n\n')));
});

test('OFFICE-03: output is editable OOXML with content and tables, not screenshots', async () => {
  const word = await JSZip.loadAsync(await createWordFile(content), { checkCRC32: true });
  const document = await word.file('word/document.xml')!.async('string');
  assert.match(document, /Saved evidence/);
  assert.match(document, /<w:tbl>/);
  assert.match(document, /<w:b/);
  const deck = await JSZip.loadAsync(await createPowerPointFile(content), { checkCRC32: true });
  const slides = Object.keys(deck.files).filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path));
  assert.equal(slides.length, 2);
  const first = await deck.file(slides[0]!)!.async('string');
  const second = await deck.file(slides[1]!)!.async('string');
  assert.match(first, /Saved evidence/);
  assert.match(second, /<a:tbl>/);
  assert.doesNotMatch(first, /<p:pic>/);
  assert.ok(deck.file('ppt/notesSlides/notesSlide1.xml'));
});
