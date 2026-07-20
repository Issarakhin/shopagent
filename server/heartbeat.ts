import { agentStore } from './store.js';
import { calculateInventoryForecasts, calculateProductBoosts, calculateRevenueOpportunities } from './phase2-service.js';
import { readProducts } from './business-data.js';

let timer: NodeJS.Timeout | undefined;

export async function runHeartbeat(actor = 'system') {
  const state = agentStore.getState();
  if (!state.heartbeat.enabled || state.controls.automationPaused || state.heartbeat.running) {
    return { skipped: true, reason: state.controls.automationPaused ? 'automation_paused' : 'heartbeat_disabled_or_running' };
  }
  agentStore.mutate((draft) => {
    draft.heartbeat.running = true;
  });
  const findings: string[] = [];
  try {
    const fresh = agentStore.getState();
    if (fresh.heartbeat.checks.lowStock) {
      const lowStock = readProducts().filter((product) => product.stock <= 5);
      if (lowStock.length) findings.push(`${lowStock.length} products have five or fewer units.`);
    }
    if (fresh.heartbeat.checks.staleApprovals) {
      const stale = fresh.approvals.filter((approval) => approval.status === 'pending' && Date.now() - new Date(approval.requestedAt).getTime() >= 24 * 60 * 60 * 1000);
      if (stale.length) findings.push(`${stale.length} approvals have been waiting for more than 24 hours.`);
    }
    if (fresh.heartbeat.checks.productBoosts) calculateProductBoosts();
    if (fresh.heartbeat.checks.predictiveInventory && fresh.controls.predictiveInventoryEnabled) calculateInventoryForecasts();
    if (fresh.controls.revenueOptimizationEnabled) calculateRevenueOpportunities();

    agentStore.mutate((draft) => {
      draft.heartbeat.lastRunAt = new Date().toISOString();
      draft.heartbeat.nextRunAt = new Date(Date.now() + draft.heartbeat.intervalMinutes * 60_000).toISOString();
      draft.heartbeat.running = false;
      if (findings.length) {
        draft.memories.unshift({
          id: `memory_heartbeat_${Date.now()}`,
          type: 'observation',
          topic: 'heartbeat_summary',
          content: findings.join(' '),
          confidence: 1,
          source: 'heartbeat',
          createdAt: new Date().toISOString(),
        });
      }
    });
    agentStore.addAudit({ actor, actorRole: 'system', action: 'heartbeat_run', resultSummary: findings.join(' ') || 'Heartbeat completed with no urgent findings.', success: true });
    return { skipped: false, findings };
  } catch (error) {
    agentStore.mutate((draft) => {
      draft.heartbeat.running = false;
      draft.heartbeat.lastRunAt = new Date().toISOString();
    });
    agentStore.addAudit({ actor, actorRole: 'system', action: 'heartbeat_run', resultSummary: 'Heartbeat failed.', success: false, error: { code: 'HEARTBEAT_FAILED', message: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

export function configureHeartbeat() {
  if (timer) clearInterval(timer);
  const state = agentStore.getState();
  if (!state.heartbeat.enabled) return;
  const interval = Math.max(1, state.heartbeat.intervalMinutes) * 60_000;
  timer = setInterval(() => {
    void runHeartbeat();
  }, interval);
  timer.unref?.();
}

export function stopHeartbeat() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
