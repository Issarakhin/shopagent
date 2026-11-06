import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shopping-cambodia-jobs-'));
process.chdir(temp);
process.env.NODE_ENV = 'test';
delete process.env.OPENAI_API_KEY; // force the deterministic fallback planner
process.env.TELEGRAM_LIVE_SEND = 'false';

const { agentStore } = await import('../store.js');
const {
  enqueuePlanningJob,
  getPlanningJob,
  claimNextPendingJob,
  runPlanningWorkerOnce,
  recoverOrphanedPlanningJobs,
} = await import('../planning-jobs.js');
const { fetchOpenAIWithRetry, OpenAIError } = await import('../openai-service.js');

test('duplicate submissions with the same idempotency key never create duplicate jobs', () => {
  agentStore.reset();
  const first = enqueuePlanningJob({ command: 'Prepare a daily business summary', actor: 'admin', actorRole: 'owner', idempotencyKey: 'key-A' });
  const second = enqueuePlanningJob({ command: 'Prepare a daily business summary', actor: 'admin', actorRole: 'owner', idempotencyKey: 'key-A' });
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal(agentStore.getState().planningJobs.length, 1);
});

test('a queued job is processed to completion by the worker and yields one workflow', async () => {
  agentStore.reset();
  const { job } = enqueuePlanningJob({ command: 'Prepare a daily business summary', actor: 'admin', actorRole: 'owner', idempotencyKey: 'key-B' });
  assert.equal(job.status, 'pending');
  const processed = await runPlanningWorkerOnce();
  assert.ok(processed);
  assert.equal(processed!.status, 'completed');
  assert.ok(processed!.workflowId, 'a workflow id should be recorded');
  const workflowCount = agentStore.getState().workflows.length;
  // Resubmitting the same key after completion returns the finished job and
  // creates NO second workflow (retry-safe).
  const again = enqueuePlanningJob({ command: 'Prepare a daily business summary', actor: 'admin', actorRole: 'owner', idempotencyKey: 'key-B' });
  assert.equal(again.deduped, true);
  assert.equal(again.job.status, 'completed');
  assert.equal(agentStore.getState().workflows.length, workflowCount);
});

test('a job orphaned by a worker restart is recovered and can be re-claimed', () => {
  agentStore.reset();
  const { job } = enqueuePlanningJob({ command: 'Prepare a daily business summary', actor: 'admin', actorRole: 'owner', idempotencyKey: 'key-C' });
  // Simulate a crash mid-processing: mark it processing with an already-expired lease.
  agentStore.mutate((draft) => {
    const target = draft.planningJobs.find((j) => j.id === job.id)!;
    target.status = 'processing';
    target.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
  });
  const recovered = recoverOrphanedPlanningJobs();
  assert.equal(recovered, 1);
  assert.equal(getPlanningJob(job.id)!.status, 'pending');
  // It can now be claimed again.
  const claimed = claimNextPendingJob();
  assert.ok(claimed);
  assert.equal(claimed!.id, job.id);
  assert.equal(claimed!.status, 'processing');
});

test('a non-transient failure (brain disabled) marks the job failed with a structured error', async () => {
  agentStore.reset();
  agentStore.mutate((draft) => { draft.controls.brainEnabled = false; });
  enqueuePlanningJob({ command: 'Prepare a daily business summary', actor: 'admin', actorRole: 'owner', idempotencyKey: 'key-D' });
  const processed = await runPlanningWorkerOnce();
  assert.ok(processed);
  assert.equal(processed!.status, 'failed');
  assert.equal(processed!.error?.code, 'BRAIN_DISABLED');
  agentStore.mutate((draft) => { draft.controls.brainEnabled = true; });
});

test('fetchOpenAIWithRetry stops at the shared deadline instead of restarting per attempt', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  // Always "slow": never resolves before the attempt is aborted.
  (globalThis as any).fetch = (_url: string, init: any) =>
    new Promise((_resolve, reject) => {
      calls += 1;
      const signal: AbortSignal | undefined = init?.signal;
      if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  try {
    const started = Date.now();
    await assert.rejects(
      () => fetchOpenAIWithRetry('https://api.openai.com/v1/responses', { method: 'POST' }, { deadline: Date.now() + 600, perAttemptMs: 200, attempts: 5 }),
      (error: any) => error instanceof OpenAIError && error.code === 'OPENAI_TIMEOUT',
    );
    const elapsed = Date.now() - started;
    // The whole operation respects the ~600ms shared deadline (not 5×200ms).
    assert.ok(elapsed < 1500, `expected to stop near the shared deadline, took ${elapsed}ms`);
    assert.ok(calls >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchOpenAIWithRetry retries transient 5xx but surfaces a structured error when out of budget', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  (globalThis as any).fetch = async () => {
    calls += 1;
    return new Response('upstream error', { status: 503 });
  };
  try {
    await assert.rejects(
      () => fetchOpenAIWithRetry('https://api.openai.com/v1/responses', { method: 'POST' }, { deadline: Date.now() + 1500, attempts: 3 }),
      (error: any) => error instanceof OpenAIError && (error.code === 'OPENAI_NETWORK' || error.code === 'OPENAI_RATE_LIMITED'),
    );
    assert.ok(calls >= 2, `expected at least one retry, got ${calls} call(s)`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
