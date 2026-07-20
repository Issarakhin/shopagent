import crypto from 'crypto';
import { agentStore } from './store.js';
import type { MainAgentPlan, MainAgentPlanStep, SkillId } from './types.js';

const SKILLS: SkillId[] = [
  'business-planning', 'marketing', 'sales', 'inventory', 'finance', 'support', 'analytics', 'logistics',
];

const SYSTEM_PROMPT = `You are the Main Business Agent for the Shopping Cambodia admin system.
You coordinate business skills, but you never directly modify business data or contact customers.
Use only these skills: business-planning, marketing, sales, inventory, finance, support, analytics, logistics.
Create dependency-ordered workflows. High-risk actions require explicit human approval.
Campaign creation and campaign publishing must be separate. create_campaign_draft never sends messages.
publish_approved_campaign is the only Telegram send action and always requires approval.
Never invent customers, orders, payments, stock, campaign performance, or financial results.
Return only structured data matching the supplied schema.`;

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'summary', 'requiresWorkflow', 'warnings'],
  properties: {
    intent: { type: 'string' },
    summary: { type: 'string' },
    requiresWorkflow: { type: 'boolean' },
    warnings: { type: 'array', items: { type: 'string' } },
    clarificationQuestion: { type: ['string', 'null'] },
    workflow: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'goal', 'riskLevel', 'steps'],
          properties: {
            name: { type: 'string' },
            goal: { type: 'string' },
            riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
            steps: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'skill', 'action', 'dependsOn', 'requiresApproval', 'input'],
                properties: {
                  id: { type: 'string' },
                  skill: { type: 'string', enum: SKILLS },
                  action: { type: 'string' },
                  dependsOn: { type: 'array', items: { type: 'string' } },
                  requiresApproval: { type: 'boolean' },
                  input: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
      ],
    },
  },
};

function textFromResponse(payload: any): string {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  for (const item of payload?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === 'string') return content.text;
    }
  }
  throw new Error('OpenAI returned no structured text.');
}

function validateStep(value: unknown): value is MainAgentPlanStep {
  if (!value || typeof value !== 'object') return false;
  const step = value as Record<string, unknown>;
  return typeof step.id === 'string'
    && typeof step.action === 'string'
    && typeof step.skill === 'string'
    && SKILLS.includes(step.skill as SkillId)
    && Array.isArray(step.dependsOn)
    && step.dependsOn.every((item) => typeof item === 'string')
    && typeof step.requiresApproval === 'boolean'
    && !!step.input
    && typeof step.input === 'object'
    && !Array.isArray(step.input);
}

export function validatePlan(value: unknown): MainAgentPlan {
  if (!value || typeof value !== 'object') throw new Error('Plan must be an object.');
  const plan = value as Record<string, any>;
  if (typeof plan.intent !== 'string' || typeof plan.summary !== 'string' || typeof plan.requiresWorkflow !== 'boolean') {
    throw new Error('Plan is missing required fields.');
  }
  if (!Array.isArray(plan.warnings) || !plan.warnings.every((item: unknown) => typeof item === 'string')) {
    throw new Error('Plan warnings are invalid.');
  }
  if (plan.requiresWorkflow) {
    if (!plan.workflow || typeof plan.workflow !== 'object') throw new Error('Workflow is required.');
    if (!['low', 'medium', 'high'].includes(plan.workflow.riskLevel)) throw new Error('Invalid workflow risk level.');
    if (!Array.isArray(plan.workflow.steps) || !plan.workflow.steps.every(validateStep)) throw new Error('Invalid workflow steps.');
    const ids = new Set(plan.workflow.steps.map((step: MainAgentPlanStep) => step.id));
    for (const step of plan.workflow.steps as MainAgentPlanStep[]) {
      for (const dependency of step.dependsOn) {
        if (!ids.has(dependency)) throw new Error(`Unknown dependency: ${dependency}`);
        if (dependency === step.id) throw new Error('A step cannot depend on itself.');
      }
    }
  }
  return plan as MainAgentPlan;
}

function fallbackPlan(command: string): MainAgentPlan {
  const lower = command.toLowerCase();
  if (lower.includes('campaign') || lower.includes('telegram') || lower.includes('advert')) {
    return {
      intent: 'create_marketing_campaign',
      summary: 'Prepare a reviewed Telegram campaign using product, inventory, and budget evidence.',
      requiresWorkflow: true,
      warnings: ['Publishing requires a separate final approval.'],
      workflow: {
        name: 'Smart Telegram campaign',
        goal: command,
        riskLevel: 'high',
        steps: [
          { id: 'step_1', skill: 'analytics', action: 'rank_products', dependsOn: [], requiresApproval: false, input: {} },
          { id: 'step_2', skill: 'inventory', action: 'check_available_stock', dependsOn: ['step_1'], requiresApproval: false, input: {} },
          { id: 'step_3', skill: 'finance', action: 'check_campaign_budget', dependsOn: ['step_2'], requiresApproval: false, input: { requestedAmount: 25 } },
          { id: 'step_4', skill: 'marketing', action: 'create_campaign_draft', dependsOn: ['step_3'], requiresApproval: false, input: { channel: 'telegram' } },
          { id: 'step_5', skill: 'marketing', action: 'publish_approved_campaign', dependsOn: ['step_4'], requiresApproval: true, input: {} },
          { id: 'step_6', skill: 'analytics', action: 'measure_campaign_performance', dependsOn: ['step_5'], requiresApproval: false, input: {} },
          { id: 'step_7', skill: 'analytics', action: 'learn_from_outcomes', dependsOn: ['step_6'], requiresApproval: false, input: {} },
        ],
      },
    };
  }
  if (lower.includes('price') || lower.includes('pricing')) {
    return {
      intent: 'dynamic_pricing', summary: 'Generate dynamic price recommendations and wait for approval before applying any change.', requiresWorkflow: true,
      warnings: ['Price changes are high-risk and require exact-version approval.'],
      workflow: { name: 'Dynamic pricing review', goal: command, riskLevel: 'high', steps: [
        { id: 'step_1', skill: 'finance', action: 'recommend_dynamic_pricing', dependsOn: [], requiresApproval: false, input: {} },
        { id: 'step_2', skill: 'finance', action: 'apply_approved_price', dependsOn: ['step_1'], requiresApproval: true, input: {} },
      ] },
    };
  }
  if (lower.includes('segment') || lower.includes('customer')) {
    return {
      intent: 'customer_segmentation', summary: 'Build customer segments from real order history.', requiresWorkflow: true, warnings: [],
      workflow: { name: 'Customer segmentation', goal: command, riskLevel: 'low', steps: [
        { id: 'step_1', skill: 'sales', action: 'segment_customers', dependsOn: [], requiresApproval: false, input: {} },
      ] },
    };
  }
  if (lower.includes('stock') || lower.includes('inventory') || lower.includes('reorder')) {
    return {
      intent: 'predict_inventory', summary: 'Forecast demand and identify reorder needs.', requiresWorkflow: true, warnings: [],
      workflow: { name: 'Predictive inventory review', goal: command, riskLevel: 'low', steps: [
        { id: 'step_1', skill: 'inventory', action: 'predict_inventory', dependsOn: [], requiresApproval: false, input: {} },
        { id: 'step_2', skill: 'inventory', action: 'recommend_reorder', dependsOn: ['step_1'], requiresApproval: false, input: {} },
      ] },
    };
  }
  if (lower.includes('revenue') || lower.includes('profit') || lower.includes('boost')) {
    return {
      intent: 'revenue_optimization', summary: 'Find product, pricing, inventory, and campaign opportunities.', requiresWorkflow: true, warnings: [],
      workflow: { name: 'Revenue optimization', goal: command, riskLevel: 'medium', steps: [
        { id: 'step_1', skill: 'finance', action: 'optimize_revenue', dependsOn: [], requiresApproval: false, input: {} },
        { id: 'step_2', skill: 'analytics', action: 'rank_products', dependsOn: ['step_1'], requiresApproval: false, input: {} },
      ] },
    };
  }
  return {
    intent: 'daily_business_summary', summary: 'Generate a grounded business summary.', requiresWorkflow: true, warnings: [],
    workflow: { name: 'Business summary', goal: command, riskLevel: 'low', steps: [
      { id: 'step_1', skill: 'business-planning', action: 'generate_daily_summary', dependsOn: [], requiresApproval: false, input: {} },
    ] },
  };
}

export async function planWithOpenAI(command: string, context: Record<string, unknown>): Promise<{ plan: MainAgentPlan; source: 'openai' | 'fallback' | 'cache' }> {
  const cacheKey = `brain:${crypto.createHash('sha256').update(`${command}:${JSON.stringify(context)}`).digest('hex')}`;
  const cached = agentStore.getCache(cacheKey);
  if (cached) return { plan: validatePlan(cached), source: 'cache' };

  if (!process.env.OPENAI_API_KEY) {
    const plan = fallbackPlan(command);
    agentStore.setCache(cacheKey, plan, 10);
    return { plan, source: 'fallback' };
  }

  const memory = agentStore.getState().memories.slice(0, 10).map((item) => ({ topic: item.topic, content: item.content, confidence: item.confidence }));
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
      instructions: SYSTEM_PROMPT,
      input: JSON.stringify({ adminCommand: command, trustedContext: context, relevantMemory: memory }),
      text: {
        format: {
          type: 'json_schema',
          name: 'shopping_cambodia_main_agent_plan',
          // Non-strict: strict mode forbids open-ended objects, but a workflow
          // step's `input` is an arbitrary parameter bag. The response is still
          // validated by validatePlan() below.
          strict: false,
          schema: PLAN_SCHEMA,
        },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI planning failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  const payload = await response.json();
  const plan = validatePlan(JSON.parse(textFromResponse(payload)));
  agentStore.setCache(cacheKey, plan, 10);
  return { plan, source: 'openai' };
}

export async function draftCampaignContent(input: {
  productNames: string[];
  audience: string;
  budget: number;
}): Promise<{ kh: string; en: string; source: 'openai' | 'fallback' }> {
  if (!process.env.OPENAI_API_KEY) {
    const names = input.productNames.join(', ') || 'selected Cambodian products';
    return {
      kh: `ស្វែងរកផលិតផលខ្មែរដែលបានជ្រើសរើស៖ ${names}។ ស្តុកមានកំណត់។ សូមបញ្ជាទិញតាម Shopping Cambodia។`,
      en: `Discover selected Cambodian products: ${names}. Limited stock available. Order through Shopping Cambodia.`,
      source: 'fallback',
    };
  }
  const schema = {
    type: 'object', additionalProperties: false, required: ['kh', 'en'], properties: { kh: { type: 'string' }, en: { type: 'string' } },
  };
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
      instructions: 'Write truthful, concise Telegram campaign copy for Shopping Cambodia. Do not invent discounts, delivery promises, stock, or customer claims. Return Khmer and English.',
      input: JSON.stringify(input),
      text: { format: { type: 'json_schema', name: 'telegram_campaign_copy', strict: true, schema } },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI campaign draft failed: ${await response.text()}`);
  const parsed = JSON.parse(textFromResponse(await response.json()));
  if (typeof parsed.kh !== 'string' || typeof parsed.en !== 'string') throw new Error('Invalid campaign copy response.');
  return { kh: parsed.kh, en: parsed.en, source: 'openai' };
}
