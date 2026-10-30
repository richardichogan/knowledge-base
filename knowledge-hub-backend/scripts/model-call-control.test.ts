import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/model-call-control';
process.env.AZURE_OPENAI_ENDPOINT = 'https://models.fixture.invalid';
process.env.AZURE_OPENAI_API_KEY = 'fixture-not-a-secret';
process.env.AZURE_OPENAI_ENDPOINT_GPT54 = 'https://bulk.fixture.invalid';
process.env.AZURE_OPENAI_API_KEY_GPT54 = 'fixture-not-a-secret';
process.env.AZURE_OPENAI_GPT54_API = 'responses';

const { FoundryClient, AiStoppedError } = await import('../src/ai/foundryClient.js');
const { env } = await import('../src/config/env.js');
const { getDb, closeDb } = await import('../src/db/db.js');
const { embedBatch } = await import('../src/ai/embeddings.js');
const { filterImportantEmails } = await import('../src/integrations/email/emailImportanceFilter.js');
const { analyzeImageWithVision } = await import('../src/services/visionAnalyzer.js');
const { modelReadingSteps } = await import('../src/ai/knowledge/documentReading.js');
const { startAgentWorker, stopAgentWorker } = await import('../src/agents/engine.js');
const { withAgentAttempt } = await import('../src/agents/attempt.js');
const { withAssignmentResearch, rethrowAssignmentControl } = await import('../src/agents/workforce/modelBudget.js');
const { decomposeSpec } = await import('../src/build/decompose.js');
const { withAiWorkflow, withAiStage, setAiWorkflowOutcome } = await import('../src/ai/aiWorkflow.js');
const { recordAiUsage } = await import('../src/ai/aiUsage.js');
const db = getDb();
after(closeDb);

function usage(t: TestContext): unknown[][] {
  const rows: unknown[][] = [];
  t.mock.method(db, 'query', async (_sql: string, values: unknown[]) => {
    rows.push(values);
    return { rows: [], rowCount: 0 };
  });
  return rows;
}

function completion(content = 'Done', finish_reason = 'stop'): Response {
  return Response.json({ choices: [{ finish_reason, message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 2 } });
}

test('workflow attribution preserves stage, purpose and attempt without leaking into later calls', async t => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  t.mock.method(db, 'query', async (sql: string, values: unknown[]) => {
    statements.push({ sql, values });
    return { rows: [], rowCount: 0 };
  });
  const call = () => recordAiUsage({ feature: 'fixture', slot: 'bulk', deployment: 'fixture',
    api: 'chat', durationMs: 1, ok: true });
  await withAiWorkflow(db, { feature: 'fixture', purpose: 'diagnostic', attempt: 2 }, async () => {
    await withAiStage('research', async () => { call(); setAiWorkflowOutcome('review-blocked'); });
    call();
  });
  call();
  const insert = statements.find(s => s.sql.includes('INSERT INTO ai_workflow_runs'))!;
  const calls = statements.filter(s => s.sql.includes('INSERT INTO ai_usage_log')).map(s => s.values);
  assert.equal(insert.values[5], 2);
  assert.deepEqual(calls.map(values => [values[15], values[16], values[17]]),
    [[insert.values[0], 'research', 'diagnostic'], [insert.values[0], 'fixture', 'diagnostic'], [null, null, null]]);
  const final = statements.find(s => s.sql.includes('UPDATE ai_workflow_runs'))!;
  assert.deepEqual(final.values.slice(1), ['completed', 'review-blocked']);
});

for (const api of ['chat', 'responses', 'bulk', 'stream'] as const) {
  test(`${api} cancellation aborts the provider request and is not logged as success`, async t => {
    const records = usage(t);
    const controller = new AbortController();
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    let providerSignal: AbortSignal | undefined;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      assert.ok(init.signal);
      providerSignal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        started();
      });
    });
    const client = new FoundryClient('fixture');
    const messages = [{ role: 'user' as const, content: 'Review the source' }];
    const work = api === 'bulk' ? client.chatBulk(messages, 100, 10000, 'low', undefined, controller.signal)
      : api === 'stream' ? client.chatWithToolsStream('standard', messages, [], 100, 'auto', 10000, () => {}, controller.signal)
      : client.chat(api === 'responses' ? 'reasoning' : 'standard', messages, 100, 10000, controller.signal);
    const rejected = assert.rejects(work, AiStoppedError);
    await waiting;
    controller.abort();
    await rejected;
    assert.equal(providerSignal?.aborted, true);
    assert.equal(records.length, 1);
    assert.equal(records[0]![12], false);
    assert.match(String(records[0]![13]), /Cancelled/);
  });
}

test('pre-cancelled work never sends a model request', async t => {
  usage(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => completion());
  const signal = AbortSignal.abort();
  await assert.rejects(new FoundryClient().chat('standard', [], 100, 1000, signal), AiStoppedError);
  await assert.rejects(new FoundryClient().chatBulk([], 100, 1000, 'low', undefined, signal), AiStoppedError);
  assert.equal(fetch.mock.callCount(), 0);
});

test('all Foundry APIs inherit worker cancellation even when a helper omits its signal', async t => {
  usage(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => completion());
  const signal = AbortSignal.abort();
  await withAgentAttempt({ jobId: 'fixture', attempt: 1, owner: 'fixture', assignmentId: null, signal }, async () => {
    const client = new FoundryClient('fixture');
    await assert.rejects(client.chat('standard', [], 100, 1000), AiStoppedError);
    await assert.rejects(client.chat('reasoning', [], 100, 1000), AiStoppedError);
    await assert.rejects(client.chatBulk([], 100, 1000, 'low'), AiStoppedError);
    await assert.rejects(client.chatWithToolsStream('standard', [], [], 100, 'auto', 1000, () => {}), AiStoppedError);
  });
  assert.equal(fetch.mock.callCount(), 0);
});

function durableBudget(t: TestContext, limit: number) {
  const identity = { assignmentId: 'fixture-assignment', jobId: 'fixture-job', owner: 'fixture-owner', attempt: 1 };
  const counters = { calls: 0, tokens: 0 };
  const reservations = new Map<string, { tokens: number; status: string; actual: number | null; kind: string }>();
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT p.limits')) return { rows: [{
      limits: { calls: limit, tokens: 100000, durationMs: 60000 },
      calls_reserved: String(counters.calls), tokens_reserved: String(counters.tokens), remaining_ms: 60000,
    }], rowCount: 1 };
    if (sql.includes('SELECT id FROM agent_jobs')) return { rows: [{ id: identity.jobId }], rowCount: 1 };
    if (sql.includes('UPDATE agent_assignments SET calls_reserved')) {
      counters.calls++;
      counters.tokens += Number(values[1]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO agent_budget_reservations')) {
      reservations.set(String(values[0]), { tokens: Number(values[4]), status: 'reserved', actual: null, kind: String(values[5]) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SELECT assignment_id,tokens_reserved')) {
      const saved = reservations.get(String(values[0]));
      assert.ok(saved);
      return { rows: [{ assignment_id: identity.assignmentId, tokens_reserved: String(saved.tokens) }], rowCount: 1 };
    }
    if (sql.includes('SELECT id FROM agent_assignments')) return { rows: [{ id: identity.assignmentId }], rowCount: 1 };
    if (sql.includes("UPDATE agent_assignments SET status='waiting'")) return { rows: [{ revision: 2 }], rowCount: 1 };
    if (sql.includes("UPDATE agent_jobs SET status='queued'")) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO agent_assignment_events')) return { rows: [], rowCount: 1 };
    if (sql.includes('UPDATE agent_budget_reservations SET tokens_actual')) {
      const saved = reservations.get(String(values[0]));
      assert.ok(saved);
      assert.equal(saved.status, 'reserved');
      saved.actual = values[1] === null ? null : Number(values[1]);
      saved.status = saved.actual === null ? 'unknown' : 'known';
      return { rows: [{ id: values[0] }], rowCount: 1 };
    }
    throw new Error(`Unexpected budget query: ${sql}`);
  };
  t.mock.method(db, 'connect', async () => ({ query, release() {} }));
  const run = <T>(action: () => Promise<T>) => withAgentAttempt({
    ...identity, signal: new AbortController().signal, budgetDb: db,
  }, action);
  return { counters, reservations, run };
}

function streamedCompletion(): Response {
  return new Response(`data: ${JSON.stringify({
    choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}

for (const api of ['chat', 'responses', 'bulk', 'stream'] as const) {
  test(`${api} reserves the shared allowance before dispatch and cannot spend it again`, async t => {
    usage(t);
    const budget = durableBudget(t, 1);
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
      assert.equal(budget.counters.calls, 1);
      assert.ok(budget.counters.tokens > 100);
      assert.equal([...budget.reservations.values()][0]!.status, 'reserved');
      return api === 'stream' ? streamedCompletion()
        : api === 'responses' ? Response.json({
          status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }],
          usage: { input_tokens: 10, output_tokens: 2 },
        }) : completion();
    });
    const client = new FoundryClient('budget-fixture');
    const messages = [{ role: 'user' as const, content: 'Use only the commissioned evidence.' }];
    const call = () => api === 'bulk' ? client.chatBulk(messages, 100, 10000)
      : api === 'stream' ? client.chatWithToolsStream('standard', messages, [], 100, 'auto', 10000, () => {})
        : client.chat(api === 'responses' ? 'reasoning' : 'standard', messages, 100, 10000);
    await budget.run(async () => {
      await call();
      assert.equal([...budget.reservations.values()][0]!.actual, 12);
      await assert.rejects(call, /budget is exhausted/);
    });
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(budget.counters.calls, 1);
    assert.equal([...budget.reservations.values()][0]!.status, 'known');
  });
}

test('a stream transport retry consumes a new reservation and retains the uncertain first charge', async t => {
  usage(t);
  const budget = durableBudget(t, 2);
  let dispatches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    dispatches++;
    assert.equal(budget.counters.calls, dispatches);
    if (dispatches === 1) {
      const error = new Error('Connection reset before headers.');
      Object.assign(error, { code: 'ECONNRESET' });
      throw error;
    }
    return streamedCompletion();
  });
  await budget.run(() => new FoundryClient().chatWithToolsStream('standard', [], [], 100, 'auto', 10000, () => {}));
  assert.equal(dispatches, 2);
  assert.deepEqual([...budget.reservations.values()].map(item => [item.status, item.actual]), [['unknown', null], ['known', 12]]);
});

test('a stream retry is refused before dispatch when the shared call allowance is spent', async t => {
  usage(t);
  const budget = durableBudget(t, 1);
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    const error = new Error('Connection reset before headers.');
    Object.assign(error, { code: 'ECONNRESET' });
    throw error;
  });
  await assert.rejects(budget.run(() =>
    new FoundryClient().chatWithToolsStream('standard', [], [], 100, 'auto', 10000, () => {})), /budget is exhausted/);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal([...budget.reservations.values()][0]!.status, 'unknown');
});

test('assignment calls without durable budget context and unbudgeted modalities never reach a provider', async t => {
  usage(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => completion());
  await withAgentAttempt({
    assignmentId: 'fixture-assignment', jobId: 'fixture-job', owner: 'fixture-owner', attempt: 1,
    signal: new AbortController().signal,
  }, async () => {
    await assert.rejects(new FoundryClient().chat('standard', []), /durable model-call budget/);
    await assert.rejects(new FoundryClient().chatBulk([]), /durable model-call budget/);
  });
  const budget = durableBudget(t, 2);
  await budget.run(async () => {
    await assert.rejects(new FoundryClient().chatWithTools('standard', [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://image.fixture.invalid/image' } }] },
    ], [], 100), /no approved budget/);
    await assert.rejects(new FoundryClient().chatWithToolsStream('reasoning', [], [], 100, 'auto', 10000, () => {},
      undefined, undefined, { builtInTools: [{ type: 'code_interpreter' }] }), /no approved budget/);
  });
  assert.equal(budget.counters.calls, 0);
  assert.equal(fetch.mock.callCount(), 0);
});

test('cached-client use outside an assignment does not inherit its budget', async t => {
  usage(t);
  const budget = durableBudget(t, 1);
  const client = new FoundryClient('budget-fixture');
  const fetch = t.mock.method(globalThis, 'fetch', async () => completion());
  await budget.run(() => client.chat('standard', [], 100));
  await client.chat('standard', [], 100);
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(budget.counters.calls, 1);
});

test('research and generation share the same call allowance and research does not invent model token usage', async t => {
  usage(t);
  const budget = durableBudget(t, 2);
  t.mock.method(globalThis, 'fetch', async () => completion());
  let reads = 0;
  await budget.run(async () => {
    assert.equal(await withAssignmentResearch(async signal => {
      assert.ok(signal);
      reads++;
      return 'Official source text';
    }), 'Official source text');
    await new FoundryClient().chat('standard', [], 100);
    await assert.rejects(withAssignmentResearch(async () => { reads++; return 'Must not be read'; }), /budget is exhausted/);
  });
  assert.equal(reads, 1);
  assert.deepEqual([...budget.reservations.values()].map(item => [item.kind, item.status, item.actual]),
    [['research', 'known', 0], ['model', 'known', 12]]);
});

test('failed research retains its call charge and cannot be hidden by optional-evidence fallbacks', async t => {
  usage(t);
  const budget = durableBudget(t, 1);
  await budget.run(async () => {
    await assert.rejects(withAssignmentResearch(async () => { throw new Error('Remote research failed.'); }), /Remote research failed/);
    try { await withAssignmentResearch(async () => 'Must not run'); }
    catch (error) {
      assert.throws(() => rethrowAssignmentControl(error), /budget is exhausted/);
      return;
    }
    assert.fail('The spent allowance must stop the next research request.');
  });
  assert.equal(budget.counters.calls, 1);
  assert.deepEqual([...budget.reservations.values()].map(item => [item.kind, item.status, item.actual]), [['research', 'unknown', null]]);
});

test('the assignment deadline survives native body-abort errors and cannot become missing research', async t => {
  usage(t);
  const budget = durableBudget(t, 1);
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  await budget.run(async () => {
    await assert.rejects(withAssignmentResearch(async signal => {
      assert.ok(signal);
      deadline.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    }), /operation was aborted/);
    assert.throws(() => rethrowAssignmentControl(new DOMException('The operation was aborted.', 'AbortError')), /assignment deadline expired/);
  });
  assert.equal([...budget.reservations.values()][0]!.status, 'unknown');
});

test('bulk fallback retains the requested timeout', async t => {
  usage(t);
  const original = env.AZURE_OPENAI_ENDPOINT_GPT54;
  Object.assign(env, { AZURE_OPENAI_ENDPOINT_GPT54: undefined });
  t.after(() => { Object.assign(env, { AZURE_OPENAI_ENDPOINT_GPT54: original }); });
  const limits: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    limits.push(ms);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, 'fetch', async () => completion());
  assert.equal(await new FoundryClient().chatBulk([], 100, 1234), 'Done');
  assert.deepEqual(limits, [1234]);
});

for (const key of ['AZURE_OPENAI_ENDPOINT_GPT54', 'AZURE_OPENAI_API_KEY_GPT54'] as const) {
  for (const value of [undefined, '']) {
    test(`dedicated bulk rejects ${key}=${String(value)} without sending a provider request`, async t => {
      const records = usage(t);
      const descriptor = Object.getOwnPropertyDescriptor(env, key);
      assert.ok(descriptor);
      Object.defineProperty(env, key, { value, configurable: true });
      t.after(() => { Object.defineProperty(env, key, descriptor); });
      const fetch = t.mock.method(globalThis, 'fetch', async () => completion());
      const client = new FoundryClient('design-visual');
      await assert.rejects(client.chatBulk([], 64000, 1000, 'medium', {
        name: 'design_visual', schema: { type: 'object' },
      }, undefined, { requireDedicatedRoute: true }), {
        name: 'ConfigurationError',
        code: 'CONFIGURATION_ERROR',
        message: /dedicated bulk generation.*fallback is disabled/,
      });
      assert.equal(fetch.mock.callCount(), 0);
      assert.equal(records.length, 0);
    });
  }
}

for (const maxTokens of [64000, 40000]) {
  test(`dedicated bulk preserves the ${String(maxTokens)}-token budget and request contract`, async t => {
    usage(t);
    const signal = new AbortController().signal;
    const jsonSchema = { name: 'design_visual', schema: { type: 'object' } };
    const messages = [{ role: 'user' as const, content: 'Keep all source requirements' }];
    const fetch = t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
      assert.ok(String(url).startsWith(`${env.AZURE_OPENAI_ENDPOINT_GPT54}/openai/deployments/`));
      const body = JSON.parse(String(init.body));
      assert.equal(body.max_completion_tokens, maxTokens);
      assert.equal(body.reasoning_effort, 'medium');
      assert.deepEqual(body.messages, messages);
      assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { ...jsonSchema, strict: true } });
      assert.ok(init.signal);
      return completion();
    });
    assert.equal(await new FoundryClient().chatBulk(messages, maxTokens, 1000, 'medium',
      jsonSchema, signal, { requireDedicatedRoute: true }), 'Done');
    assert.equal(fetch.mock.callCount(), 1);
  });
}

test('truncated bulk output retains usage but is recorded as unsuccessful', async t => {
  const records = usage(t);
  t.mock.method(globalThis, 'fetch', async () => completion('Partial', 'length'));
  await assert.rejects(new FoundryClient().chatBulk([]), /limit|truncat/i);
  assert.equal(records[0]![7], 10);
  assert.equal(records[0]![12], false);
});

test('checkpoint summarisation and reduction pass their cancellation signal to the transport', async () => {
  const signal = new AbortController().signal;
  const signals: Array<AbortSignal | undefined> = [];
  const steps = modelReadingSteps({
    chatBulk: async (...args: Parameters<InstanceType<typeof FoundryClient>['chatBulk']>) => {
      signals.push(args[5]);
      return signals.length === 1 ? JSON.stringify({ summary: 'A fact', memory: 'A fact', excerpts: [] }) : 'A fact';
    },
  }, signal);
  await steps.summarise('A fact', '', 'Review');
  await steps.reduce(['A fact'], 'Review');
  assert.deepEqual(signals, [signal, signal]);
});

test('embeddings stay batched and ordered, with an explicit request deadline', async t => {
  const records = usage(t);
  const limits: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { limits.push(ms); return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init.body)).input, ['first', 'second']);
    assert.ok(init.signal);
    return Response.json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
  });
  assert.deepEqual(await embedBatch(['first', 'second']), [[1, 0], [0, 1]]);
  assert.deepEqual(limits, [60000]);
  assert.equal(records[0]![12], true);
});

test('embedding failures appear in usage telemetry', async t => {
  const records = usage(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('Unavailable', { status: 503 }));
  await assert.rejects(embedBatch(['source']), /503/);
  assert.equal(records[0]![12], false);
});

test('email classification uses completion tokens and preserves the existing threshold', async t => {
  const records = usage(t);
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.max_completion_tokens, 500);
    assert.equal('max_tokens' in body, false);
    assert.equal(body.temperature, 0);
    assert.ok(init.signal);
    return completion('[{"index":1,"score":1},{"index":2,"score":2}]');
  });
  assert.deepEqual(await filterImportantEmails([
    { subject: 'Noise', from: 'sender', date: 'today' }, { subject: 'Useful', from: 'sender', date: 'today' },
  ]), [false, true]);
  assert.equal(records[0]![12], true);
});

test('incomplete email classifications retain fail-open ingestion but record a failure', async t => {
  const records = usage(t);
  t.mock.method(globalThis, 'fetch', async () => completion('[]'));
  assert.deepEqual(await filterImportantEmails([{ subject: 'A', from: 'sender', date: 'today' }]), [true]);
  assert.equal(records[0]![12], false);
  assert.match(String(records[0]![13]), /omitted/);
});

test('basic vision has a deadline and records failures before the existing fallback', async t => {
  const records = usage(t);
  const limits: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { limits.push(ms); return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.ok(init.signal);
    return new Response('Unavailable', { status: 503 });
  });
  assert.equal(await analyzeImageWithVision(Buffer.from('fixture'), 'image/png'), '');
  assert.deepEqual(limits, [75000]);
  assert.equal(records[0]![12], false);
});

test('specialist polling cannot overlap a pending claim, and shutdown waits for it', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  let claims = 0;
  t.mock.method(db, 'query', async (sql: string) => {
    if (sql.includes("SET status = 'running', started_at")) { claims++; started(); await gate; }
    return { rows: [], rowCount: 0 };
  });
  let poll!: () => void;
  t.mock.method(globalThis, 'setInterval', (callback: () => void) => {
    poll = callback;
    return setTimeout(() => {}, 60000);
  });
  try {
    await startAgentWorker(db);
    await waiting;
    poll();
    poll();
    await Promise.resolve();
    assert.equal(claims, 1);
    let stopped = false;
    const stopping = stopAgentWorker().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    release();
    await stopping;
  } finally { release(); await stopAgentWorker(); }
});

test('failed or contradictory build reviews cannot return an unchecked plan', async t => {
  const draft = JSON.stringify({ plan_notes: '', tasks: [{ key: 'a', title: 'Implement', body: 'Do it', agent: 'copilot', size: 'S', depends_on: [] }] });
  for (const review of [new Error('review unavailable'), '{}', '{"pass":true,"issues":["Missing a requirement"]}']) {
    let calls = 0;
    const chat = t.mock.method(FoundryClient.prototype, 'chat', async () => {
      if (++calls === 1) return draft;
      if (review instanceof Error) throw review;
      return review;
    });
    try { await assert.rejects(decomposeSpec({ title: 'Spec', specMarkdown: 'Requirements', repo: 'fixture/repo' }), /review/i); }
    finally { chat.mock.restore(); }
  }
});

test('a failed build revision cannot fall back to the rejected original plan', async t => {
  let calls = 0;
  t.mock.method(FoundryClient.prototype, 'chat', async () => {
    calls++;
    if (calls === 1) return JSON.stringify({ plan_notes: '', tasks: [{ key: 'a', title: 'Implement', body: 'Do it', agent: 'copilot', size: 'S', depends_on: [] }] });
    if (calls === 2) return '{"pass":false,"issues":["Missing a requirement"]}';
    return '{}';
  });
  await assert.rejects(decomposeSpec({ title: 'Spec', specMarkdown: 'Requirements', repo: 'fixture/repo' }), /revision/i);
});
