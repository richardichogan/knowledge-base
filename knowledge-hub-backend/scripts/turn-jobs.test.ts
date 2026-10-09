import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { startTurnJob, cancelTurnJob, subscribeTurnJob, getSessionTurnJob, type TurnEvent } from '../src/ai/turnJobs.js';
import type { TurnHooks } from '../src/ai/conversationService.js';
import { abortable } from '../src/ai/abortable.js';

const tick = async (): Promise<void> => { await new Promise(resolve => setImmediate(resolve)); };

test('Stop releases a hung preparation and ignores its late activity/result', async () => {
  const id = randomUUID();
  const sessionId = randomUUID();
  let finish!: (result: string) => void;
  let hooks!: TurnHooks;
  let finished = 0;
  startTurnJob(id, sessionId, 'thoughts?', async h => {
    hooks = h;
    return new Promise<string>(resolve => { finish = resolve; });
  }, () => { finished++; });
  const events: TurnEvent[] = [];
  const unsubscribe = subscribeTurnJob(id, e => { events.push(e); })!;
  await tick();
  assert.equal(cancelTurnJob(id), true);
  await tick();
  assert.equal(getSessionTurnJob(sessionId), null);
  assert.equal(finished, 1);
  assert.deepEqual(events.at(-1), { type: 'error', message: 'Stopped', stopped: true });
  const count = events.length;
  hooks.onDelta?.('late reply');
  hooks.onActivity?.('late activity');
  finish('late result');
  await tick();
  assert.equal(events.length, count);
  unsubscribe();
});

test('whole-turn deadline covers preparation and reports timeout, not Stop', async () => {
  const id = randomUUID();
  const sessionId = randomUUID();
  let finished = 0;
  const outcome = new Promise<TurnEvent>(resolve => {
    startTurnJob(id, sessionId, 'thoughts?', async () => new Promise(() => {}),
      () => { finished++; }, true, 15);
    subscribeTurnJob(id, e => { if (e.type === 'error') resolve(e); });
  });
  const event = await outcome;
  await tick();
  assert.equal(event.type, 'error');
  if (event.type === 'error') {
    assert.equal(event.stopped, false);
    assert.match(event.message, /took too long/);
  }
  assert.equal(getSessionTurnJob(sessionId), null);
  assert.equal(finished, 1);
});

test('normal completed turns still replay their result', async () => {
  const id = randomUUID();
  startTurnJob(id, randomUUID(), 'hello', async () => 'reply', () => {});
  await tick();
  const events: TurnEvent[] = [];
  subscribeTurnJob(id, e => { events.push(e); });
  assert.deepEqual(events.at(-1), { type: 'done', data: 'reply' });
  assert.equal(cancelTurnJob(id), false);
});

test('Stop before preparation starts prevents the work from running', async () => {
  const id = randomUUID();
  let ran = false;
  startTurnJob(id, randomUUID(), 'thoughts?', async () => { ran = true; }, () => {});
  assert.equal(cancelTurnJob(id), true);
  await tick();
  assert.equal(ran, false);
});

test('aborted optional work rejects promptly even when the provider ignores cancellation', async () => {
  const controller = new AbortController();
  const result = abortable(new Promise(() => {}), controller.signal);
  controller.abort(new Error('storage timed out'));
  await assert.rejects(result, /storage timed out/);
});
