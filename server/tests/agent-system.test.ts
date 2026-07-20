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
const { createWorkflowFromCommand, decideApproval } = await import('../agent-engine.js');
const { validatePlan } = await import('../openai-service.js');

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

test('campaign draft workflow waits for final approval and does not send Telegram', async () => {
  agentStore.reset();
  const result = await createWorkflowFromCommand('Create a Telegram campaign for slow products', 'test-admin');
  assert.equal(result.workflow.status, 'waiting_approval');
  const state = agentStore.getState();
  assert.equal(state.campaigns.length, 1);
  assert.equal(state.campaigns[0].status, 'awaiting_review');
  assert.equal(state.campaignRecipients.length, 0);
  assert.equal(state.approvals.filter((item) => item.status === 'pending').length, 1);
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

test('skill and action toggles are enforced by the store', () => {
  agentStore.updateSkill('marketing', false);
  assert.throws(() => agentStore.assertSkillEnabled('marketing', 'create_campaign_draft'), (error: any) => error.code === 'SKILL_DISABLED');
  agentStore.updateSkill('marketing', true);
  agentStore.updateSkillAction('marketing', 'create_campaign_draft', false);
  assert.throws(() => agentStore.assertSkillEnabled('marketing', 'create_campaign_draft'), (error: any) => error.code === 'ACTION_DISABLED');
});
