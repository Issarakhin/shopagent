import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shopping-cambodia-discovery-'));
process.chdir(temp);
process.env.NODE_ENV = 'test';
delete process.env.OPENAI_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.SOCIAL_LISTENING_PROVIDER;
delete process.env.SOCIAL_LISTENING_TOKEN;
process.env.TELEGRAM_LIVE_SEND = 'false';

const { agentStore } = await import('../store.js');
const { captureAndQualifyLead, computeDemandIndex, decideApproval, runWorkflow } = await import('../agent-engine.js');
const { readProducts, writeProducts } = await import('../business-data.js');

function seedSalesWorkflow(action: string, input: Record<string, unknown>) {
  const workflowId = `workflow_${action}_${Math.random().toString(36).slice(2, 7)}`;
  agentStore.mutate((draft) => {
    draft.workflows.unshift({
      id: workflowId, name: `${action} test`, goal: 'discovery test', status: 'pending', progress: 0, riskLevel: 'low',
      createdBy: 'test-admin', createdAt: new Date().toISOString(), relatedRecords: [],
      steps: [{
        id: 'step_1', workflowId, skill: 'sales', action, dependsOn: [], requiresApproval: false,
        status: 'pending', input, attempt: 0, idempotencyKey: `${workflowId}:sales:${action}:step_1`,
      }],
    });
  });
  return workflowId;
}

test('captureAndQualifyLead matches a real catalogue product and only infers location', () => {
  agentStore.reset();
  const product = readProducts()[0];
  const { lead, matched, deduped } = captureAndQualifyLead({
    inquiryText: `Do you have ${product.name} in Phnom Penh?`,
    source: 'web_inquiry',
    consentToContact: true,
  });
  assert.equal(deduped, false);
  assert.ok(matched.some((p) => p.id === product.id), 'should match the named product');
  assert.equal(lead.qualification, 'qualified');
  assert.deepEqual(lead.productInterestIds.includes(product.id), true);
  // A Khmer/English hint in free text is inferred, never confirmed.
  assert.equal(lead.locationConfirmed, false);
  assert.match(lead.locationBasis, /inferred/i);
});

test('captureAndQualifyLead confirms location only with an explicit flag', () => {
  agentStore.reset();
  const product = readProducts()[0];
  const { lead } = captureAndQualifyLead({
    inquiryText: `Interested in ${product.name}`,
    confirmedLocation: true,
    consentToContact: true,
  });
  assert.equal(lead.locationConfirmed, true);
  assert.match(lead.locationBasis, /confirmed/i);
});

test('captureAndQualifyLead never fabricates interest for an unrelated inquiry', () => {
  agentStore.reset();
  const { lead, matched } = captureAndQualifyLead({
    inquiryText: 'zzzqwx nonexistent gibberish item 99999',
    consentToContact: true,
  });
  assert.equal(matched.length, 0);
  assert.equal(lead.productInterestIds.length, 0);
  assert.equal(lead.qualification, 'unqualified');
});

test('captureAndQualifyLead dedups a repeat inquiry from the same contact', () => {
  agentStore.reset();
  const product = readProducts()[0];
  const first = captureAndQualifyLead({ inquiryText: `Need ${product.name}`, contactHandle: 'dedup@example.com', consentToContact: false });
  assert.equal(first.deduped, false);
  const second = captureAndQualifyLead({ inquiryText: `Still want ${product.name}`, contactHandle: 'DEDUP@example.com', consentToContact: true });
  assert.equal(second.deduped, true);
  assert.equal(second.lead.id, first.lead.id);
  assert.equal(agentStore.getState().leads.length, 1);
  // Consent can be upgraded on a repeat inquiry.
  assert.equal(second.lead.consentToContact, true);
});

test('adjust_inventory reduceByPercent computes the new level from live DB stock', async () => {
  agentStore.reset();
  const products = readProducts();
  const product = products[0];
  const previousStock = product.stock;
  // Ensure a known, even starting stock so the percentage is unambiguous.
  product.stock = 100;
  writeProducts(products);

  const workflowId = 'workflow_pct_test';
  agentStore.mutate((draft) => {
    draft.workflows.unshift({
      id: workflowId, name: 'Percent reduce', goal: 'reduce 40%', status: 'pending', progress: 0, riskLevel: 'high',
      createdBy: 'test-admin', createdAt: new Date().toISOString(), relatedRecords: [product.id],
      steps: [{
        id: 'step_1', workflowId, skill: 'inventory', action: 'adjust_inventory', dependsOn: [], requiresApproval: false,
        status: 'pending', input: { productId: product.id, reduceByPercent: 40, reason: 'Clearance' }, attempt: 0,
        idempotencyKey: `${workflowId}:inventory:adjust_inventory:step_1`,
      }],
    });
  });
  await runWorkflow(workflowId, 'test-admin');
  // Held for approval — stock unchanged until a human approves.
  assert.equal(readProducts().find((p) => p.id === product.id)?.stock, 100);
  const approval = agentStore.getState().approvals.find((a) => a.workflowId === workflowId && a.status === 'pending');
  assert.ok(approval);
  await decideApproval(approval.id, 'approved', 'human-reviewer');
  // 100 reduced by 40% => 60, computed from the DB, no hand-fed number.
  assert.equal(readProducts().find((p) => p.id === product.id)?.stock, 60);

  const restore = readProducts();
  const target = restore.find((p) => p.id === product.id);
  if (target) target.stock = previousStock;
  writeProducts(restore);
});

test('draft_lead_outreach is blocked for a lead without consent', async () => {
  agentStore.reset();
  const product = readProducts()[0];
  const { lead } = captureAndQualifyLead({ inquiryText: `Want ${product.name}`, contactHandle: 'noconsent@example.com', consentToContact: false });
  const workflowId = seedSalesWorkflow('draft_lead_outreach', { leadId: lead.id });
  await runWorkflow(workflowId, 'test-admin');
  const step = agentStore.getState().workflows.find((w) => w.id === workflowId)?.steps[0];
  assert.equal(step?.status, 'failed');
  assert.equal(step?.error?.code, 'NO_CONSENT');
});

test('discover_social_opportunities derives first-party demand and never scrapes when no provider is set', async () => {
  agentStore.reset();
  delete process.env.SOCIAL_LISTENING_PROVIDER;
  delete process.env.SOCIAL_LISTENING_TOKEN;
  const workflowId = seedSalesWorkflow('discover_social_opportunities', {});
  await runWorkflow(workflowId, 'test-admin');
  const step = agentStore.getState().workflows.find((w) => w.id === workflowId)?.steps[0];
  assert.equal(step?.status, 'completed');
  // No external provider configured, so no provider opportunities were fetched...
  assert.equal(step?.output?.configured, false);
  assert.deepEqual(step?.output?.providerOpportunities, []);
  // ...but a first-party demand index is always produced (never fabricated leads).
  assert.ok(step?.output?.demandIndex);
  assert.ok(Array.isArray((step?.output?.demandIndex as any).topProducts));
});

test('computeDemandIndex ranks products from real first-party signals and separates Phnom Penh demand', () => {
  agentStore.reset();
  const products = readProducts();
  const product = products[0];
  // Real storefront signals + a confirmed Phnom Penh lead.
  agentStore.mutate((draft) => {
    draft.events.unshift(
      { id: 'e1', type: 'purchase', productId: product.id, quantity: 2, createdAt: new Date().toISOString() } as any,
      { id: 'e2', type: 'product_view', productId: product.id, createdAt: new Date().toISOString() } as any,
    );
  });
  captureAndQualifyLead({ inquiryText: `I want ${product.name}`, contactHandle: 'pp@example.com', consentToContact: true, confirmedLocation: true, location: 'Phnom Penh' });
  const demand = computeDemandIndex(30);
  assert.ok(demand.totalSignals > 0);
  assert.ok(demand.topProducts.some((p) => p.productId === product.id));
  assert.equal(demand.phnomPenhSignals >= 1, true);
  assert.ok(demand.phnomPenhDemand.some((p) => p.productId === product.id));
});
