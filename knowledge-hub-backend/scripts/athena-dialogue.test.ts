import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleMessages } from '../src/ai/contextBuilder.js';
import { DIALOGUE_POLICY_PROMPT, buildDialogueTurnPrompt, dialogueRepairInstruction, dialogueTurnMode } from '../src/ai/dialoguePolicy.js';
import { DIALOGUE_SCENARIOS, SYNTHETIC_DIALOGUE_CONTEXT, dialogueFindings } from './athena-dialogue-fixtures.js';
import type { AthenaPersona, ConversationMessage } from '../src/types/aiContext.js';

const personas: AthenaPersona[] = [
  'general', 'brainstorming', 'copilot_coach', 'blog_post', 'demo_designer',
  'web_designer', 'podcast_prep', 'podcast_show_notes',
];

for (const persona of personas) {
  test(`${persona}: turn policy follows legacy instructions AND previous replies`, async () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'I am exploring a synthetic reporting design.' },
      { role: 'assistant', content: 'Should we optimise for reviewers or the coding agent?' },
    ];
    const latest = 'The coding agent, but I still need to review it.';
    const standing = 'Always deliver a full finished specification before asking anything.';
    const messages = await assembleMessages(SYNTHETIC_DIALOGUE_CONTEXT, history, latest, persona, undefined, standing);
    assert.ok(messages[0]?.content.includes(standing));
    assert.deepEqual(messages.slice(1, -2), history, 'retain the actual prior question and user context');
    assert.deepEqual(messages.at(-2), { role: 'system', content: buildDialogueTurnPrompt(history, latest) });
    assert.deepEqual(messages.at(-1), { role: 'user', content: latest });
    assert.equal(messages.filter(message => message.content.includes('## Dialogue turn contract')).length, 1);
    assert.ok(!messages[0]?.content.includes('it is fine to run longer'));
    assert.ok(!messages[0]?.content.includes('A missing question is not missing information'));
  });
}

test('policy makes curiosity consequential and turn-sized, not a mandatory question on every reply', () => {
  assert.match(DIALOGUE_POLICY_PROMPT, /ask the single question whose answer would most change your advice/);
  assert.match(DIALOGUE_POLICY_PROMPT, /100 words.*follow-up turns/);
  assert.match(DIALOGUE_POLICY_PROMPT, /question bolted onto an essay is a failure/);
  assert.match(DIALOGUE_POLICY_PROMPT, /use his answer explicitly to narrow or change the reasoning/);
  assert.match(DIALOGUE_POLICY_PROMPT, /Do not manufacture an endless interview/);
  assert.match(DIALOGUE_POLICY_PROMPT, /never ask a question merely to prove you are conversational/);
  assert.match(DIALOGUE_POLICY_PROMPT, /material ambiguity or risk/);
  assert.match(DIALOGUE_POLICY_PROMPT, /does not override safety, evidence requirements, tool permissions/);
});

test('policy preserves correction, humour and direct-delivery exceptions', () => {
  assert.match(DIALOGUE_POLICY_PROMPT, /If he corrects you, update the premise/);
  assert.match(DIALOGUE_POLICY_PROMPT, /brief dry wit/);
  assert.match(DIALOGUE_POLICY_PROMPT, /no defensive joke/);
  assert.match(DIALOGUE_POLICY_PROMPT, /No more questions, draft it/);
  assert.match(DIALOGUE_POLICY_PROMPT, /clear factual question, comparison, rewrite, summary, edit/);
  assert.match(DIALOGUE_POLICY_PROMPT, /Once enough is settled/);
});

test('latest explicit delivery intent stays unchanged, including attached reference context', async () => {
  const request = 'Generate the specification from what we agreed. No more questions.';
  const messages = await assembleMessages(SYNTHETIC_DIALOGUE_CONTEXT, [], request, 'general',
    { type: 'document', title: 'Synthetic reference', detail: 'Screen IDs must remain stable.' });
  const latest = messages.at(-1)!;
  assert.equal(latest.role, 'user');
  assert.ok(latest.content.endsWith(request));
  assert.ok(latest.content.includes('Screen IDs must remain stable.'));
  assert.equal(messages.at(-2)?.content, buildDialogueTurnPrompt([], request));
});

test('high-confidence turn hints distinguish exploration, answered questions, delivery and correction', () => {
  const history: ConversationMessage[] = [{ role: 'assistant', content: 'Is the main consumer a reviewer or Copilot?' }];
  for (const message of ['Help me think this through.', 'What if every node were an agent?', 'I want to explore this design.']) {
    assert.equal(dialogueTurnMode([], message), 'explore', message);
  }
  for (const message of ['Rewrite this sentence.', 'Now draft an introduction.', 'We agreed YAML. Give me a small example.', 'Help me design a screen; no more questions.']) {
    assert.equal(dialogueTurnMode(history, message), 'deliver', message);
    assert.equal(dialogueRepairInstruction(history, message, 'Text '.repeat(160)), null, 'never impose interview pacing on a deliverable');
  }
  assert.equal(dialogueTurnMode(history, 'The latter.'), 'follow-up');
  assert.equal(dialogueTurnMode(history, 'What is YAML?'), 'unspecified', 'new factual question is not an interview answer');
  assert.equal(dialogueTurnMode(history, 'Thanks.'), 'unspecified', 'acknowledgement should not restart an interview');
  assert.equal(dialogueTurnMode(history, 'No, you are missing it. Stop writing essays.'), 'correction');
  assert.equal(dialogueTurnMode([], 'Unrecognised wording.'), 'unspecified', 'do not invent high-confidence intent');
});

test('one-repair policy catches conversational overruns but allows completed reasoning without a forced question', () => {
  const user = 'Help me think through a design.';
  assert.equal(dialogueRepairInstruction([], user, 'That choice is settled. Use the simpler contract.'), null);
  assert.equal(dialogueRepairInstruction([], user, 'Who reads it?'), null);
  assert.equal(dialogueRepairInstruction([], user, 'Who reads it?**'), null, 'markdown is not post-question reasoning');
  assert.ok(dialogueRepairInstruction([], user, 'Detail '.repeat(112)));
  assert.ok(dialogueRepairInstruction([], user, 'Who reads it? If it is an agent then here is the full implementation.'));
  assert.ok(dialogueRepairInstruction([], user, 'Who reads it? What do they need?'));
  assert.ok(dialogueRepairInstruction([], user, 'The next consequential choice is whether this is UI or domain behaviour.'));
  assert.ok(dialogueRepairInstruction([], user, 'The useful question is whether readers want news or useful experiments.'));
  assert.equal(dialogueTurnMode([{ role: 'assistant', content: 'The useful question is whether readers want news or useful experiments.' }],
    'Hands-on Azure architects need experiments.'), 'follow-up');
  assert.equal(dialogueRepairInstruction([], 'Write the complete design now.', 'Detail '.repeat(200)), null);
  assert.match(dialogueRepairInstruction([], 'No, stop writing essays.', 'Detail '.repeat(100))!, /corrected meaning/);
});

test('fixture checks reject essays, canned questions, interrogation and repeated known facts', () => {
  const expected = { mode: 'explore' as const, maxWords: 110 };
  assert.deepEqual(dialogueFindings('A schema makes this checkable. Which failure must the screen prevent?', expected), []);
  assert.deepEqual(dialogueFindings('A schema makes this checkable. **Which failure must the screen prevent?**', expected), []);
  assert.ok(dialogueFindings(`${'Details '.repeat(120)}What matters?`, expected).some(f => f.includes('words exceeds')));
  assert.ok(dialogueFindings('## Proposed design\nA schema. What matters?', expected).includes('essay headings during exploration'));
  assert.ok(dialogueFindings('Do you want a schema? Here is the schema.', expected).includes('did not pause at the question'));
  assert.ok(dialogueFindings('What matters? Who reads it?', expected).some(f => f.includes('got 2')));
  assert.ok(dialogueFindings('Would you like me to draft it?', expected).some(f => f.includes('generic offer')));
  assert.ok(dialogueFindings('Done. Anything else?', { mode: 'deliver', maxWords: 30 }).some(f => f.includes('unnecessary question')));
  assert.ok(dialogueFindings('Who is the audience?', { ...expected, avoids: /who.*audience/i }).some(f => f.includes('known information')));
});

test('regression corpus covers multi-turn narrowing, delivery, short answers, sarcasm and corrections', () => {
  assert.ok(DIALOGUE_SCENARIOS.some(s => s.id === 'rtr-specification' && s.turns.length >= 3));
  assert.ok(DIALOGUE_SCENARIOS.some(s => s.id === 'newsletter-intent' && s.turns.length >= 3));
  assert.ok(DIALOGUE_SCENARIOS.some(s => s.id === 'brainstorming-challenge' && s.turns.length >= 2));
  assert.ok(DIALOGUE_SCENARIOS.some(s => s.id === 'short-answer' && s.history?.length === 2));
  for (const id of ['direct-edit', 'clear-comparison', 'playful-sarcasm', 'frustrated-correction', 'complete-context']) {
    assert.ok(DIALOGUE_SCENARIOS.some(s => s.id === id), `missing ${id}`);
  }
});
