import type { AgentState } from './agent-types';

const ADMIN_KEY = import.meta.env.VITE_ADMIN_API_KEY ?? '';
const ADMIN_USER = import.meta.env.VITE_ADMIN_USER ?? 'shopping-cambodia-admin';
const ADMIN_ROLE = import.meta.env.VITE_ADMIN_ROLE ?? 'owner';

// Base URL of the deployed backend (e.g. https://your-app.herokuapp.com).
// Left empty for local development, where the Express server serves the API on
// the same origin. Trailing slashes are trimmed so paths join cleanly.
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}/api/agent${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key': ADMIN_KEY,
      'x-admin-user': ADMIN_USER,
      'x-admin-role': ADMIN_ROLE,
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
  return payload as T;
}

export const agentApi = {
  state: () => request<AgentState>('/admin/state'),
  plan: (command: string) => request<any>('/admin/main-agent/plan', { method: 'POST', body: JSON.stringify({ command }) }),
  updateControls: (patch: Record<string, boolean>) => request('/admin/controls', { method: 'PATCH', body: JSON.stringify(patch) }),
  toggleSkill: (skillId: string, enabled: boolean) => request(`/admin/skills/${skillId}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  toggleAction: (skillId: string, actionId: string, enabled: boolean) => request(`/admin/skills/${skillId}/actions/${actionId}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  decideApproval: (id: string, decision: 'approved' | 'rejected' | 'changes_requested', note = '') => request(`/admin/approvals/${id}/${decision}`, { method: 'POST', body: JSON.stringify({ note }) }),
  updateCampaign: (id: string, patch: Record<string, unknown>) => request(`/admin/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  runHeartbeat: () => request('/admin/heartbeat/run', { method: 'POST' }),
  updateHeartbeat: (patch: Record<string, unknown>) => request('/admin/heartbeat', { method: 'PATCH', body: JSON.stringify(patch) }),
  recalcBoosts: () => request('/admin/boosts/recalculate', { method: 'POST' }),
  requestBoostApproval: (id: string) => request(`/admin/boosts/${id}/request-approval`, { method: 'POST' }),
  pauseBoost: (id: string) => request(`/admin/boosts/${id}/pause`, { method: 'POST' }),
  pricing: () => request('/admin/phase2/pricing', { method: 'POST' }),
  segments: () => request('/admin/phase2/segments', { method: 'POST' }),
  inventoryForecast: () => request('/admin/phase2/inventory-forecast', { method: 'POST' }),
  revenueOpportunities: () => request('/admin/phase2/revenue-opportunities', { method: 'POST' }),
  addSubscriber: (subscriber: Record<string, unknown>) => request('/admin/telegram-subscribers', { method: 'POST', body: JSON.stringify(subscriber) }),
};

export async function trackStoreEvent(event: Record<string, unknown>) {
  try {
    await fetch(`${API_BASE}/api/agent/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
  } catch {
    // Store telemetry must never interrupt shopping.
  }
}

export async function fetchPublicBoosts(): Promise<Array<{ productId: string; score: number; reason: string }>> {
  try {
    const response = await fetch(`${API_BASE}/api/agent/public/boosts`);
    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}
