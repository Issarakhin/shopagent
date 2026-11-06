import crypto from 'crypto';
import { agentStore } from './store.js';
import { createWorkflowFromCommand } from './agent-engine.js';
import type { PlanningJob } from './types.js';

// Asynchronous Main-Agent planning.
//
// Planning (OpenAI) plus running the resulting workflow can exceed Heroku's
// hard 30s request limit (H12). Instead of blocking the HTTP request, we enqueue
// a durable PlanningJob and a worker processes it in the background. Jobs live
// in the agent state, which persists to Firestore, so they survive dyno
// restarts; a lease makes claiming safe across concurrent workers and lets us
// recover jobs orphaned by a crash.

const WORKER_DEADLINE_MS = Number(process.env.PLAN_WORKER_DEADLINE_MS ?? 120_000);
const LEASE_MS = Number(process.env.PLAN_JOB_LEASE_MS ?? 150_000);
const MAX_ATTEMPTS = Number(process.env.PLAN_JOB_MAX_ATTEMPTS ?? 2);

function jobId(): string {
  return `planjob_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// Enqueue a planning job. IDEMPOTENT: if a job with the same idempotencyKey
// already exists we return it instead of creating a duplicate — this is what
// prevents a user's repeated "Create Workflow" clicks (or an automatic client
// retry) from producing duplicate workflows.
export function enqueuePlanningJob(input: {
  command: string;
  actor: string;
  actorRole: string;
  idempotencyKey?: string;
}): { job: PlanningJob; deduped: boolean } {
  const idempotencyKey = input.idempotencyKey && input.idempotencyKey.trim()
    ? input.idempotencyKey.trim()
    : crypto.createHash('sha256').update(`${input.actor}:${input.command}`).digest('hex');

  let deduped = false;
  let result!: PlanningJob;
  agentStore.mutate((draft) => {
    const existing = draft.planningJobs.find((job) => job.idempotencyKey === idempotencyKey);
    if (existing) {
      deduped = true;
      result = { ...existing };
      return;
    }
    const job: PlanningJob = {
      id: jobId(),
      idempotencyKey,
      command: input.command,
      actor: input.actor,
      actorRole: input.actorRole,
      status: 'pending',
      attempts: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    draft.planningJobs.unshift(job);
    result = { ...job };
  });
  return { job: result, deduped };
}

export function getPlanningJob(id: string): PlanningJob | undefined {
  const job = agentStore.getState().planningJobs.find((item) => item.id === id);
  return job ? { ...job } : undefined;
}

// Atomically claim the next workable job: the oldest 'pending' job, or a
// 'processing' job whose lease has expired (its worker crashed). Returns a
// snapshot of the claimed job, or null if there is nothing to do.
export function claimNextPendingJob(): PlanningJob | null {
  let claimed: PlanningJob | null = null;
  agentStore.mutate((draft) => {
    const nowMs = Date.now();
    // Oldest-first (the array is newest-first, so iterate from the end).
    for (let i = draft.planningJobs.length - 1; i >= 0; i -= 1) {
      const job = draft.planningJobs[i];
      const leaseExpired = job.status === 'processing' && (!job.leaseExpiresAt || new Date(job.leaseExpiresAt).getTime() <= nowMs);
      if (job.status === 'pending' || leaseExpired) {
        if (job.attempts >= MAX_ATTEMPTS) {
          job.status = 'failed';
          job.error = job.error ?? { code: 'MAX_ATTEMPTS_EXCEEDED', message: 'Planning job exceeded the maximum number of attempts.' };
          job.finishedAt = nowIso();
          job.updatedAt = nowIso();
          continue;
        }
        job.status = 'processing';
        job.attempts += 1;
        job.startedAt = nowIso();
        job.updatedAt = nowIso();
        job.leaseExpiresAt = new Date(nowMs + LEASE_MS).toISOString();
        claimed = { ...job };
        break;
      }
    }
  });
  return claimed;
}

function finishJob(id: string, patch: Partial<PlanningJob>) {
  agentStore.mutate((draft) => {
    const job = draft.planningJobs.find((item) => item.id === id);
    if (!job) return;
    Object.assign(job, patch, { updatedAt: nowIso() });
  });
}

// Process a single claimed job to completion (success or failure). Never throws.
export async function processClaimedJob(job: PlanningJob): Promise<PlanningJob> {
  try {
    const result = await createWorkflowFromCommand(job.command, job.actor, {
      deadline: Date.now() + WORKER_DEADLINE_MS,
    });
    finishJob(job.id, {
      status: 'completed',
      result,
      plan: result.plan,
      source: result.source,
      workflowId: result.workflow?.id,
      finishedAt: nowIso(),
      leaseExpiresAt: undefined,
      error: undefined,
    });
  } catch (error: any) {
    const code = error?.code ?? 'PLAN_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    // A transient failure (timeout, rate limit, network) with attempts left is
    // left as 'pending' so the worker retries it; otherwise it is 'failed'.
    const transient = ['OPENAI_TIMEOUT', 'OPENAI_RATE_LIMITED', 'OPENAI_NETWORK'].includes(code);
    const current = agentStore.getState().planningJobs.find((item) => item.id === job.id);
    const canRetry = transient && (current?.attempts ?? MAX_ATTEMPTS) < MAX_ATTEMPTS;
    finishJob(job.id, {
      status: canRetry ? 'pending' : 'failed',
      error: { code, message },
      leaseExpiresAt: undefined,
      finishedAt: canRetry ? undefined : nowIso(),
    });
    agentStore.addAudit({
      actor: job.actor, actorRole: job.actorRole, action: 'main_agent_plan_failed',
      inputSummary: job.command, resultSummary: 'Async planning failed.', success: false,
      error: { code, message },
    });
  }
  return getPlanningJob(job.id)!;
}

// Claim and process exactly one job. Returns the processed job, or null if the
// queue was empty. Exposed for tests and for a single worker tick.
export async function runPlanningWorkerOnce(): Promise<PlanningJob | null> {
  const job = claimNextPendingJob();
  if (!job) return null;
  return processClaimedJob(job);
}

// On boot, release any job left 'processing' by a crashed/restarted dyno so it
// can be re-claimed. Jobs survive restarts because they are persisted.
export function recoverOrphanedPlanningJobs(): number {
  let recovered = 0;
  agentStore.mutate((draft) => {
    const nowMs = Date.now();
    for (const job of draft.planningJobs) {
      if (job.status === 'processing' && (!job.leaseExpiresAt || new Date(job.leaseExpiresAt).getTime() <= nowMs)) {
        job.status = 'pending';
        job.leaseExpiresAt = undefined;
        job.updatedAt = nowIso();
        recovered += 1;
      }
    }
  });
  return recovered;
}

let workerTimer: NodeJS.Timeout | null = null;
let workerBusy = false;

// Start the in-process planning worker. Safe to run inside the web dyno (the
// default) or a dedicated worker dyno. Polls for work and processes one job at
// a time so a slow OpenAI call never blocks an HTTP request.
export function startPlanningWorker(): void {
  if (workerTimer) return;
  const intervalMs = Number(process.env.PLAN_WORKER_POLL_MS ?? 1_500);
  recoverOrphanedPlanningJobs();
  workerTimer = setInterval(() => {
    if (workerBusy) return;
    workerBusy = true;
    void runPlanningWorkerOnce()
      .catch((error) => console.error('[planning-worker] unexpected error:', error))
      .finally(() => { workerBusy = false; });
  }, intervalMs);
  // Do not keep the process alive solely for this timer.
  if (typeof workerTimer.unref === 'function') workerTimer.unref();
  console.log('[planning-worker] started (in-process).');
}

export function stopPlanningWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}
