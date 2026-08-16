import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shopping-cambodia-agent-'));
process.chdir(temp);
process.env.NODE_ENV = 'test';
delete process.env.OPENAI_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;
process.env.TELEGRAM_LIVE_SEND = 'false';

const { agentStore } = await import('../store.js');
const { createWorkflowFromCommand, decideApproval, runWorkflow } = await import('../agent-engine.js');
const { draftCampaignContent, validatePlan } = await import('../openai-service.js');
const { readOrders, readProducts, writeOrders, writeProducts } = await import('../business-data.js');

test('structured plan validation rejects unknown skills', () => {
  assert.throws(() => validatePlan({
    intent: 'bad',
    summary: 'bad',
    requiresWorkflow: true,
    warnings: [],
    workflow: {
      name: 'bad', goal: 'bad', riskLevel: 'low',
      steps: [{ id: 'one', skill: 'unknown', action: 'x', dependsOn: [], requiresApproval: false, input: {} }],
    },
  }), /Invalid workflow steps/);
});


test('server policy forces approval for protected mutations even if a model marks them safe', () => {
  const plan = validatePlan({
    intent: 'unsafe-plan',
    summary: 'attempt to bypass approval',
    requiresWorkflow: true,
    warnings: [],
    workflow: {
      name: 'unsafe', goal: 'change order', riskLevel: 'high',
      steps: [{ id: 'one', skill: 'logistics', action: 'change_order_status', dependsOn: [], requiresApproval: false, input: { orderId: 'order-1', status: 'shipped' } }],
    },
  });
  assert.equal(plan.workflow?.steps[0].requiresApproval, true);
});

test('campaign drafts use a different creative angle when recent product copy is supplied', async () => {
  const product = {
    id: 'prod_fr1',
    name: 'Kampot Durian',
    description: 'Rich and aromatic seasonal durian sourced from Kampot province.',
    category: 'Fruits',
    price: 18,
    stock: 20,
    unit: 'kg',
  };
  const first = await draftCampaignContent({ products: [product], audience: 'consented subscribers', budget: 25, campaignGoal: 'Promote durian', recentCampaigns: [], verifiedMemory: [] });
  const second = await draftCampaignContent({
    products: [product], audience: 'consented subscribers', budget: 25, campaignGoal: 'Promote durian', verifiedMemory: [],
    recentCampaigns: [{ id: 'old', name: first.campaignName, creativeAngle: first.creativeAngle, callToAction: first.callToAction, telegramMessageEn: first.en, telegramMessageKh: first.kh, contentFingerprint: first.contentFingerprint }],
  });
  assert.notEqual(second.creativeAngle, first.creativeAngle);
  assert.ok(second.contentFingerprint);
});

test('campaign draft workflow waits for final approval and does not send Telegram', async () => {
  agentStore.reset();
  const result = await createWorkflowFromCommand('Create a Telegram campaign for slow products', 'test-admin');
  assert.equal(result.workflow.status, 'waiting_approval');
  const state = agentStore.getState();
  assert.equal(state.campaigns.length, 1);
  assert.equal(state.campaigns[0].status, 'awaiting_review');
  assert.equal(state.campaignRecipients.length, 0);
  assert.equal(state.approvals.filter((item) => item.status === 'pending').length, 1);
  const approval = state.approvals.find((item) => item.status === 'pending');
  assert.ok(approval);
  await assert.rejects(() => decideApproval(approval.id, 'approved', 'main-agent'), (error: any) => error.code === 'SELF_APPROVAL_FORBIDDEN');
  assert.equal(agentStore.findApproval(approval.id)?.status, 'pending');
  assert.equal(state.workflows[0].steps.find((step) => step.action === 'create_campaign_draft')?.status, 'completed');
  assert.equal(state.workflows[0].steps.find((step) => step.action === 'publish_approved_campaign')?.status, 'waiting_approval');
});

test('approved publish fails honestly when Telegram live settings are missing', async () => {
  const approval = agentStore.getState().approvals.find((item) => item.status === 'pending');
  assert.ok(approval);
  await decideApproval(approval.id, 'approved', 'reviewer');
  const state = agentStore.getState();
  const publish = state.workflows[0].steps.find((step) => step.action === 'publish_approved_campaign');
  assert.equal(publish?.status, 'failed');
  assert.equal(publish?.error?.code, 'TELEGRAM_PUBLISH_FAILED');
  assert.notEqual(state.campaigns[0].status, 'published');
});



test('inventory changes are held for approval and apply only after human approval', async () => {
  agentStore.reset();
  const products = readProducts();
  const product = products[0];
  const previousStock = product.stock;
  const workflowId = 'workflow_inventory_test';
  agentStore.mutate((draft) => {
    draft.workflows.unshift({
      id: workflowId,
      name: 'Inventory adjustment test',
      goal: 'Adjust stock safely',
      status: 'pending',
      progress: 0,
      riskLevel: 'high',
      createdBy: 'test-admin',
      createdAt: new Date().toISOString(),
      relatedRecords: [product.id],
      steps: [{
        id: 'step_1', workflowId, skill: 'inventory', action: 'adjust_inventory', dependsOn: [], requiresApproval: false,
        status: 'pending', input: { productId: product.id, adjustment: 2, reason: 'Test correction' }, attempt: 0,
        idempotencyKey: `${workflowId}:inventory:adjust_inventory:step_1`,
      }],
    });
  });
  await runWorkflow(workflowId, 'test-admin');
  assert.equal(readProducts().find((item) => item.id === product.id)?.stock, previousStock);
  const approval = agentStore.getState().approvals.find((item) => item.workflowId === workflowId && item.status === 'pending');
  assert.ok(approval);
  await decideApproval(approval.id, 'approved', 'human-reviewer');
  assert.equal(readProducts().find((item) => item.id === product.id)?.stock, previousStock + 2);
  const restored = readProducts();
  const target = restored.find((item) => item.id === product.id);
  if (target) target.stock = previousStock;
  writeProducts(restored);
});

test('approved order status changes follow the transition policy', async () => {
  agentStore.reset();
  const existingOrders = readOrders();
  writeOrders([{
    id: 'order_status_test', customerName: 'Test Customer', customerEmail: 'test@example.com', customerPhone: '000', customerAddress: 'Phnom Penh',
    items: [], totalAmount: 20, status: 'pending', createdAt: new Date().toISOString(),
  }]);
  const workflowId = 'workflow_order_status_test';
  agentStore.mutate((draft) => {
    draft.workflows.unshift({
      id: workflowId, name: 'Order status test', goal: 'Move order to processing', status: 'pending', progress: 0, riskLevel: 'high',
      createdBy: 'test-admin', createdAt: new Date().toISOString(), relatedRecords: ['order_status_test'],
      steps: [{ id: 'step_1', workflowId, skill: 'logistics', action: 'change_order_status', dependsOn: [], requiresApproval: false, status: 'pending', input: { orderId: 'order_status_test', status: 'processing', reason: 'Payment verified' }, attempt: 0, idempotencyKey: `${workflowId}:logistics:change_order_status:step_1` }],
    });
  });
  await runWorkflow(workflowId, 'test-admin');
  assert.equal(readOrders()[0].status, 'pending');
  const approval = agentStore.getState().approvals.find((item) => item.workflowId === workflowId && item.status === 'pending');
  assert.ok(approval);
  await decideApproval(approval.id, 'approved', 'human-reviewer');
  assert.equal(readOrders()[0].status, 'processing');
  writeOrders(existingOrders);
});

test('approved refunds fail honestly when no payment provider is configured', async () => {
  agentStore.reset();
  const existingOrders = readOrders();
  writeOrders([{
    id: 'order_refund_test', customerName: 'Test Customer', customerEmail: 'test@example.com', customerPhone: '000', customerAddress: 'Phnom Penh',
    items: [], totalAmount: 30, status: 'processing', createdAt: new Date().toISOString(),
  }]);
  delete process.env.PAYMENT_REFUND_ENDPOINT;
  delete process.env.PAYMENT_REFUND_TOKEN;
  const workflowId = 'workflow_refund_test';
  agentStore.mutate((draft) => {
    draft.workflows.unshift({
      id: workflowId, name: 'Refund test', goal: 'Refund verified order', status: 'pending', progress: 0, riskLevel: 'high',
      createdBy: 'test-admin', createdAt: new Date().toISOString(), relatedRecords: ['order_refund_test'],
      steps: [{ id: 'step_1', workflowId, skill: 'support', action: 'issue_approved_refund', dependsOn: [], requiresApproval: false, status: 'pending', input: { orderId: 'order_refund_test', amount: 10, reason: 'Approved test refund' }, attempt: 0, idempotencyKey: `${workflowId}:support:issue_approved_refund:step_1` }],
    });
  });
  await runWorkflow(workflowId, 'test-admin');
  const approval = agentStore.getState().approvals.find((item) => item.workflowId === workflowId && item.status === 'pending');
  assert.ok(approval);
  await decideApproval(approval.id, 'approved', 'human-reviewer');
  const step = agentStore.getState().workflows.find((item) => item.id === workflowId)?.steps[0];
  assert.equal(step?.status, 'failed');
  assert.equal(step?.error?.code, 'REFUND_PROVIDER_FAILED');
  writeOrders(existingOrders);
});

test('skill and action toggles are enforced by the store', () => {
  agentStore.updateSkill('marketing', false);
  assert.throws(() => agentStore.assertSkillEnabled('marketing', 'create_campaign_draft'), (error: any) => error.code === 'SKILL_DISABLED');
  agentStore.updateSkill('marketing', true);
  agentStore.updateSkillAction('marketing', 'create_campaign_draft', false);
  assert.throws(() => agentStore.assertSkillEnabled('marketing', 'create_campaign_draft'), (error: any) => error.code === 'ACTION_DISABLED');
});

test('campaign creative follows the user logic instead of a fixed sales format', async () => {
  const product = {
    id: 'prod_durian_logic',
    name: 'Kampot Durian',
    description: 'Rich and aromatic seasonal durian sourced from Kampot province.',
    category: 'Fruits',
    price: 18,
    stock: 20,
    unit: 'kg',
  };
  const request = 'Boost Kampot Durian with a short funny curiosity campaign for young adults. No emojis, do not mention price, and do not use a hard sell.';
  const campaign = await draftCampaignContent({
    products: [product],
    audience: 'consented subscribers',
    budget: 25,
    campaignGoal: request,
    userRequest: request,
    recentCampaigns: [],
    verifiedMemory: [],
  });

  assert.equal(campaign.userIntent, request);
  assert.equal(campaign.campaignPurpose, 'product visibility and interest');
  assert.match(campaign.tone, /playful|humorous/i);
  assert.match(campaign.contentStyle, /humor/i);
  assert.match(campaign.targetAudience, /young adults/i);
  assert.ok(campaign.en.length < 520);
  assert.doesNotMatch(campaign.en, /\$18|18\.00|\bprice\b/i);
  assert.doesNotMatch(`${campaign.en}${campaign.kh}`, /\p{Extended_Pictographic}/u);
  assert.doesNotMatch(campaign.en, /buy now|order now|special offer/i);
  assert.ok(campaign.userLogicMatch.some((item) => item.includes('Purpose: product visibility and interest')));
});

test('sales campaign can follow an explicit premium story and include verified price', async () => {
  const product = {
    id: 'prod_durian_sale',
    name: 'Kampot Durian',
    description: 'Rich and aromatic seasonal durian sourced from Kampot province.',
    category: 'Fruits',
    price: 18,
    stock: 20,
    unit: 'kg',
  };
  const request = 'Sell Kampot Durian with a premium story for families. Include the current price and use a clear call to action.';
  const campaign = await draftCampaignContent({
    products: [product],
    audience: 'consented subscribers',
    budget: 25,
    campaignGoal: request,
    userRequest: request,
    recentCampaigns: [],
    verifiedMemory: [],
  });

  assert.equal(campaign.campaignPurpose, 'sales conversion');
  assert.match(campaign.tone, /premium/i);
  assert.match(campaign.contentStyle, /story|narrative/i);
  assert.match(campaign.targetAudience, /families/i);
  assert.match(campaign.en, /\$18\.00/);
  assert.notEqual(campaign.callToAction, 'none');
});

test('non-advertorial user logic removes forced sales structure and CTA', async () => {
  const product = {
    id: 'prod_durian_native',
    name: 'Kampot Durian',
    description: 'Rich and aromatic seasonal durian sourced from Kampot province.',
    category: 'Fruits',
    price: 18,
    stock: 20,
    unit: 'kg',
  };
  const request = 'Make people notice Kampot Durian, but do not make it sound like an advertisement. Use a curious question and no hashtags.';
  const campaign = await draftCampaignContent({
    products: [product], audience: 'consented subscribers', budget: 25,
    campaignGoal: request, userRequest: request, recentCampaigns: [], verifiedMemory: [],
  });

  assert.match(campaign.contentShape, /does not read like an advertisement/i);
  assert.equal(campaign.callToAction, 'none');
  assert.doesNotMatch(campaign.en, /buy now|order now|special offer|#\w+/i);
});

test('a specifically named product stays the only selected campaign product', async () => {
  agentStore.reset();
  const request = 'Boost Kampot Durian with a short funny campaign for young adults. No emojis and do not mention price.';
  await createWorkflowFromCommand(request, 'test-admin');
  const campaign = agentStore.getState().campaigns[0];
  assert.deepEqual(campaign.productIds, ['prod_fr1']);
  assert.equal(campaign.userRequest, request);
  assert.equal(campaign.campaignPurpose, 'product visibility and interest');
});
