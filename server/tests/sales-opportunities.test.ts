import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shopping-cambodia-sales-'));
process.chdir(temp);
process.env.NODE_ENV = 'test';
delete process.env.OPENAI_API_KEY;
process.env.TELEGRAM_LIVE_SEND = 'false';

const { agentStore } = await import('../store.js');
const { captureAndQualifyLead, computeDemandIndex, runWorkflow } = await import('../agent-engine.js');
const { readProducts } = await import('../business-data.js');

function runSales(action: string) {
  const workflowId = `wf_${action}_${Math.random().toString(36).slice(2, 7)}`;
  agentStore.mutate((draft: any) => {
    draft.workflows.unshift({ id: workflowId, name: action, goal: 'g', status: 'pending', progress: 0, riskLevel: 'low', createdBy: 'a', createdAt: new Date().toISOString(), relatedRecords: [], steps: [{ id: 'step_1', workflowId, skill: 'sales', action, dependsOn: [], requiresApproval: false, status: 'pending', input: {}, attempt: 0, idempotencyKey: `${workflowId}:sales:${action}:step_1` }] });
  });
  return workflowId;
}

test('find_customer_opportunities surfaces leads, re-engagement, and unmet demand from real data', async () => {
  agentStore.reset();
  const products = readProducts();
  const p = products[0];
  // consented lead interested in p (no purchase) -> lead opportunity + unmet demand
  captureAndQualifyLead({ inquiryText: `I want ${p.name}`, contactHandle: 'lead1@x.com', consentToContact: true });
  // interest signals, no purchase
  agentStore.mutate((d: any) => {
    d.events.unshift({ id: 'e1', type: 'product_view', productId: p.id, createdAt: new Date().toISOString() });
    d.events.unshift({ id: 'e2', type: 'add_to_cart', productId: p.id, quantity: 1, createdAt: new Date().toISOString() });
  });
  const wid = runSales('find_customer_opportunities');
  await runWorkflow(wid, 'admin');
  const out: any = agentStore.getState().workflows.find((w: any) => w.id === wid)!.steps[0].output;
  assert.ok(out, 'should produce output');
  assert.ok(Array.isArray(out.opportunities));
  assert.ok(out.counts.leads >= 1, 'a consented lead opportunity');
  assert.ok(out.opportunities.some((o: any) => o.type === 'lead' && o.recommendedAction === 'sales:draft_lead_outreach'));
});

test('computeDemandIndex reports unmet demand and trend', () => {
  agentStore.reset();
  const p = readProducts()[0];
  agentStore.mutate((d: any) => {
    d.events.unshift({ id: 'v1', type: 'product_view', productId: p.id, createdAt: new Date().toISOString() });
    d.events.unshift({ id: 'c1', type: 'add_to_cart', productId: p.id, quantity: 2, createdAt: new Date().toISOString() });
  });
  const demand = computeDemandIndex(30);
  assert.ok(Array.isArray(demand.unmetDemand));
  assert.ok(demand.unmetDemand.some((r: any) => r.productId === p.id), 'interest without purchase => unmet');
  assert.ok(['rising', 'falling', 'steady'].includes(demand.topProducts[0]?.trend));
});
