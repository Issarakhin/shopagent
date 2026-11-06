// Standalone planning worker entrypoint for a dedicated Heroku worker dyno.
//
// Usage (Procfile):
//   web:    node dist/server.cjs
//   worker: node dist/worker.cjs
// and set WORKER_MODE=external on the app so the web dyno does NOT also run the
// in-process worker. Both dynos share the same durable Firestore-backed job
// state, and job claiming is lease-based, so running both is safe — WORKER_MODE
// just avoids doubling the work.
import { agentStore } from './store.js';
import { startPlanningWorker } from './planning-jobs.js';

process.on('uncaughtException', (error) => {
  console.error('[worker] Uncaught exception (kept alive):', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[worker] Unhandled promise rejection (kept alive):', reason);
});

async function main() {
  console.log('[worker] Starting dedicated planning worker...');
  await agentStore.hydrateFromFirestore().catch((error) => console.error('[worker] hydration failed:', error));
  startPlanningWorker();
  // Keep the process alive.
  setInterval(() => {}, 1 << 30);
}

void main();
