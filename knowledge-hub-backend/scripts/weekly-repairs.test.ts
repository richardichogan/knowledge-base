import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findWeeklyTropes, fixDashes } from '../src/ai/styleCheck.js';
process.env.DATABASE_URL = 'postgresql://isolated.invalid/weekly-repairs';
const { applyWeeklyRepairs } = await import('../src/jobs/weeklyRepairs.js');

test('only the exact authored sentence changes; quotes, titles and surrounding prose stay byte-identical', () => {
  const citation = '[Process, policy, and evidence](https://example.com/news)';
  const original = `Opening stays.\n\nThis quietly changed. ${citation} says “Fast — but safe”. Ending stays.`;
  const result = applyWeeklyRepairs({ bodyMarkdown: original }, { edits: [
    { field: 'bodyMarkdown', before: 'This quietly changed.', after: 'This changed.' },
  ] }, ['bodyMarkdown'], []);
  assert.equal(result.content.bodyMarkdown, original.replace('This quietly changed.', 'This changed.'));
  assert.equal(result.rejected.length, 0);
  assert.equal(fixDashes(`${citation} “Fast — but safe”`), `${citation} “Fast — but safe”`);
});
test('only invalid edits are rejected; source titles, quotes and echoed source wording cannot be rewritten', () => {
  const content = { bodyMarkdown: 'Opening stays. Bad wording. Another sentence. “Fast — but safe”. Source exact wording.' };
  const edits = [
    { field: 'bodyMarkdown', before: 'Bad wording.', after: 'Better wording.' },
    { field: 'bodyMarkdown', before: 'Opening stays. Bad wording.', after: 'Entirely different.' },
    { field: 'bodyMarkdown', before: '“Fast — but safe”', after: '“Fast, but safe”' },
    { field: 'bodyMarkdown', before: 'Source exact wording.', after: 'Source new wording.' },
  ];
  const result = applyWeeklyRepairs(content, { edits }, ['bodyMarkdown'], [{ summary: 'Source exact wording.' }]);
  assert.equal(result.content.bodyMarkdown, content.bodyMarkdown.replace('Bad wording.', 'Better wording.'));
  assert.equal(result.rejected.length, 3);
});
test('weekly factual enumerations and exact quoted/source text are not regex style failures', () => {
  assert.deepEqual(findWeeklyTropes('Azure, Teams, and GitHub received updates.'), []);
  assert.deepEqual(findWeeklyTropes('[Quietly changing](https://example.com) and “This resonates”.'), []);
  assert.ok(findWeeklyTropes('This quietly changed.').length > 0);
});
test('partial replacements inside protected full-field spans are rejected', () => {
  const bodyMarkdown = '“Fast and safe”. Read [Source title](https://example.com/news). Source exact wording.';
  for (const before of ['Fast', 'Source title', 'example', 'exact']) {
    const result = applyWeeklyRepairs({ bodyMarkdown }, {
      edits: [{ field: 'bodyMarkdown', before, after: 'changed' }],
    }, ['bodyMarkdown'], [{ summary: 'Source exact wording.' }]);
    assert.equal(result.content.bodyMarkdown, bodyMarkdown);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]!.error, /protected/);
  }
});
test('unchanged surrounding context is removed without generating replacement text', () => {
  const before = 'Opening stays. Microsoft added open source models with fine tuning support. Ending stays.';
  const after = 'Opening stays. Microsoft added open-source models with fine-tuning support. Ending stays.';
  const result = applyWeeklyRepairs({ bodyMarkdown: before }, {
    edits: [{ field: 'bodyMarkdown', before, after }],
  }, ['bodyMarkdown'], []);
  assert.equal(result.content.bodyMarkdown, after);
  assert.equal(result.rejected.length, 0);
});
test('a punctuation-damaged citation can be restored only to its exact same-URL source title', () => {
  const url = 'https://techcommunity.microsoft.com/t5/microsoft-entra-blog/story/ba-p/4515964';
  const title = 'AI agents are coming—are your identity controls prepared?';
  const damaged = `[AI agents are coming, are your identity controls prepared?](${url})`;
  const exact = `[${title}](${url})`;
  const before = `On the identity side, the Microsoft Entra team published ${damaged}.`;
  const bodyMarkdown = `${before}\n\nSources: ${damaged}`;
  const sources = [{ title, url }];
  const result = applyWeeklyRepairs({ bodyMarkdown }, { edits: [
    { field: 'bodyMarkdown', before, after: before.replace(damaged, exact) },
    { field: 'bodyMarkdown', before: `Sources: ${damaged}`, after: `Sources: ${exact}` },
  ] }, ['bodyMarkdown'], sources);
  assert.equal(result.content.bodyMarkdown, bodyMarkdown.replaceAll(damaged, exact));
  assert.equal(result.rejected.length, 0);
  assert.equal(result.applied.length, 2);
  assert.equal(applyWeeklyRepairs({ bodyMarkdown: exact }, { edits: [
    { field: 'bodyMarkdown', before: exact, after: damaged },
  ] }, ['bodyMarkdown'], sources).rejected.length, 1, 'source punctuation cannot be removed again');
});
test('citation restoration never authorises URL, claim, shortened-label or ambiguous-source changes', () => {
  const url = 'https://example.com/news';
  const damaged = `[Agents, are you ready?](${url})`;
  const title = 'Agents—are you ready?';
  const exact = `[${title}](${url})`;
  const content = { bodyMarkdown: `Read ${damaged}. Unrelated wording.` };
  for (const [before, after, sources] of [
    [damaged, exact.replace(url, 'https://example.com/other'), [{ title, url }]],
    [content.bodyMarkdown, content.bodyMarkdown.replace(damaged, exact).replace('Unrelated', 'Different'), [{ title, url }]],
    [damaged, exact, [{ title, url }, { title: 'Conflicting source title', url }]],
    [damaged, exact, [{ title, url: 'https://example.com/other' }]],
  ] as const) {
    const result = applyWeeklyRepairs(content, { edits: [{ field: 'bodyMarkdown', before, after }] }, ['bodyMarkdown'], sources);
    assert.deepEqual(result.content, content);
    assert.equal(result.rejected.length, 1);
  }
  const short = `[Agents](${url})`;
  const result = applyWeeklyRepairs({ bodyMarkdown: short }, { edits: [
    { field: 'bodyMarkdown', before: short, after: exact },
  ] }, ['bodyMarkdown'], [{ title, url }]);
  assert.equal(result.content.bodyMarkdown, short);
  assert.equal(result.rejected.length, 1);
});
