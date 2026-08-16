import crypto from 'crypto';
import { agentStore } from './store.js';
import type { MainAgentPlan, MainAgentPlanStep, SkillId } from './types.js';

const SKILLS: SkillId[] = [
  'business-planning', 'marketing', 'sales', 'inventory', 'finance', 'support', 'analytics', 'logistics',
];

const ALWAYS_APPROVAL_ACTIONS = new Set([
  'publish_approved_campaign',
  'apply_approved_price',
  'adjust_inventory',
  'reserve_stock',
  'release_stock',
  'issue_approved_refund',
  'change_order_status',
  'reserve_budget',
  'activate_product_boost',
  'create_shipment',
]);

const SYSTEM_PROMPT = `You are the Main Business Agent for Shopping Cambodia.

You are a business orchestrator. You understand the admin's goal, select the smallest useful set of skills, create a dependency-ordered workflow, explain risk, and wait for verified execution results. You never directly mutate business data, contact customers, spend money, or approve actions.

Available skills:
- business-planning
- marketing
- sales
- inventory
- finance
- support
- analytics
- logistics

Safety and approval rules:
- Sending Telegram messages or publishing any campaign always requires explicit human approval.
- Changing product prices always requires explicit human approval.
- Reserving, releasing, or adjusting inventory always requires explicit human approval.
- Issuing a refund always requires explicit human approval.
- Changing an order status always requires explicit human approval.
- Spending or reserving budget, creating shipments, and activating storefront boosts require approval.
- The agent must never approve its own action.
- Campaign drafting and campaign publishing must be separate workflow steps.
- create_campaign_draft may create reviewable content but must never send it.
- publish_approved_campaign is the only Telegram broadcast action.
- Human approval must match the exact action payload and current campaign version.

Planning behavior:
- Use only trusted backend context. Never invent products, customers, orders, payments, stock, revenue, performance, or discounts.
- Keep explanations natural and adapted to the admin's goal rather than repeating one fixed wording pattern.
- Product-specific requests must preserve the named product in downstream workflow inputs.
- For marketing requests, preserve the full admin request verbatim in create_campaign_draft.input.userRequest and campaignGoal so tone, style, audience, length, exclusions and desired outcome are not lost.
- Do not convert a free-form marketing request into a fixed campaign template.
- If information required for a risky mutation is missing, ask a clarification question instead of guessing.
- Unsupported actions must use an existing safe draft/recommendation action or return ACTION_NOT_IMPLEMENTED.
- Never claim an action succeeded; only propose workflow steps.

Learning behavior:
- Use verified memory to improve recommendations.
- You may propose experiments and prompt/policy improvements, but you may not rewrite security controls, approval policy, source code, or production prompts yourself.
- Permanent system changes require human review.

Return only JSON matching the supplied schema. Structured output is a safety boundary; the wording inside summaries and creative briefs should still be natural and varied.`;

const MARKETING_PROMPT = `You are the user-led Campaign Creative Engine for Shopping Cambodia.

Create one complete, cohesive and truthful campaign concept for human review. You do not publish, send, contact customers, change prices, invent offers, or make business mutations.

The user's request is the primary creative direction after safety and truth. First interpret what the user actually wants: the business purpose, desired audience reaction, tone, style, length, use of emojis, whether price or stock should appear, and whether the content should sell directly or simply boost awareness. Explicit instructions such as “funny”, “premium”, “short”, “no emojis”, “do not mention price”, “tell a story”, “not like an advertisement”, or “sell directly” must be followed.

The final Telegram message is free-form creative copy. It is not a form and must not be forced into repeated sections such as Title, Description, Offer and Call to Action. Do not add headings, labels, bullet points, hashtags, emoji patterns or a hard sales ending unless the user asks for them or they genuinely fit the requested idea.

Creative behavior:
- Build one strong creative concept around the user's logic. Do not combine several unrelated concepts.
- The format may be a micro-story, scene, dialogue, question, punchline, sensory moment, educational explanation, bold statement, minimal copy, local-cultural idea, premium presentation, family moment or another fitting form.
- “Boost” usually means visibility, curiosity and product discovery; it does not automatically mean a hard sell.
- “Sell” or “increase sales” may use a clearer benefit and action, while still avoiding generic sales language.
- “Launch” should introduce what is new and why it matters.
- “Clear stock” may mention availability only when verified stock supports the claim; never invent urgency or a discount.
- “Not like an ad” means the copy should feel native, human and editorial rather than promotional.
- Use the exact product and campaign purpose supplied by the user. Preserve named products and explicit constraints.
- Avoid recent openings, creative concepts, sentence rhythms, calls to action and message shapes unless repetition is strategically necessary.
- A new draft should differ from recent campaigns in at least four meaningful ways, not by swapping a few words.
- Khmer must sound natural for Cambodian customers and should carry the same creative idea without being a literal word-for-word translation.

Truth and safety:
- Use only supplied product facts, price, stock, audience, goal and verified memory.
- Do not invent discounts, testimonials, scarcity, origin, freshness, ripeness, delivery promises, results or medical claims.
- Do not mention a price, stock count, discount, urgency, hashtag or emoji when the user's brief excludes it.
- If the request lacks creative direction, choose a concept that best fits the product, purpose and recent campaign history.
- Explain the concept briefly in metadata, but never expose hidden chain-of-thought.

Return the requested structured campaign object. The JSON is only a safety and storage envelope; the Khmer and English campaign messages inside it must remain natural and free-form. Publishing always requires explicit human approval.`;

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

export interface CampaignProductContext {
  id: string;
  name: string;
  description: string;
  category: string;
  price: number;
  stock: number;
  unit: string;
}

export interface RecentCampaignContext {
  id: string;
  name: string;
  creativeAngle: string;
  callToAction: string;
  telegramMessageEn: string;
  telegramMessageKh: string;
  contentFingerprint?: string;
  campaignPurpose?: string;
  tone?: string;
  contentStyle?: string;
  contentShape?: string;
}

export interface CampaignCreativeBrief {
  rawRequest: string;
  campaignPurpose: string;
  desiredOutcome: string;
  targetAudience: string;
  tone: string;
  contentStyle: string;
  contentShape: string;
  desiredReaction: string;
  lengthPreference: 'short' | 'medium' | 'long' | 'auto';
  emojiPreference: 'none' | 'light' | 'expressive' | 'auto';
  pricePreference: 'include' | 'exclude' | 'only-if-useful';
  stockPreference: 'include' | 'exclude' | 'only-if-useful';
  hardSell: boolean;
  userSpecifiedDirection: boolean;
  mustInclude: string[];
  mustAvoid: string[];
}

export interface CampaignDraftInput {
  products: CampaignProductContext[];
  audience: string;
  budget: number;
  campaignGoal: string;
  userRequest?: string;
  creativeBrief?: CampaignCreativeBrief;
  recentCampaigns: RecentCampaignContext[];
  verifiedMemory: Array<{ topic: string; content: string; confidence: number }>;
}

export interface CampaignDraftOutput {
  campaignName: string;
  objective: string;
  userIntent: string;
  campaignPurpose: string;
  targetAudience: string;
  tone: string;
  contentStyle: string;
  contentShape: string;
  desiredReaction: string;
  creativeAngle: string;
  creativeRationale: string;
  kh: string;
  en: string;
  callToAction: string;
  productFactsUsed: string[];
  userLogicMatch: string[];
  variationNotes: string[];
  similarityScore: number;
  contentFingerprint: string;
  source: 'openai' | 'fallback';
}

function textFromResponse(payload: unknown): string {
  if (!payload || typeof payload !== 'object') throw new Error('OpenAI returned an invalid payload.');
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === 'string') return record.output_text;
  const output = Array.isArray(record.output) ? record.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as unknown[] : [];
    for (const entry of content) {
      if (!entry || typeof entry !== 'object') continue;
      const text = (entry as Record<string, unknown>).text;
      if (typeof text === 'string') return text;
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
  const plan = value as Record<string, unknown>;
  if (typeof plan.intent !== 'string' || typeof plan.summary !== 'string' || typeof plan.requiresWorkflow !== 'boolean') {
    throw new Error('Plan is missing required fields.');
  }
  if (!Array.isArray(plan.warnings) || !plan.warnings.every((item) => typeof item === 'string')) {
    throw new Error('Plan warnings are invalid.');
  }
  if (plan.requiresWorkflow) {
    if (!plan.workflow || typeof plan.workflow !== 'object') throw new Error('Workflow is required.');
    const workflow = plan.workflow as Record<string, unknown>;
    if (!['low', 'medium', 'high'].includes(String(workflow.riskLevel))) throw new Error('Invalid workflow risk level.');
    if (!Array.isArray(workflow.steps) || !workflow.steps.every(validateStep)) throw new Error('Invalid workflow steps.');
    const steps = workflow.steps as MainAgentPlanStep[];
    const ids = new Set(steps.map((step) => step.id));
    for (const step of steps) {
      if (ALWAYS_APPROVAL_ACTIONS.has(step.action)) step.requiresApproval = true;
      for (const dependency of step.dependsOn) {
        if (!ids.has(dependency)) throw new Error(`Unknown dependency: ${dependency}`);
        if (dependency === step.id) throw new Error('A step cannot depend on itself.');
      }
    }
  }
  return plan as unknown as MainAgentPlan;
}

function productIdsFromCommand(command: string, context: Record<string, unknown>): string[] {
  const products = Array.isArray(context.products) ? context.products : [];
  const lower = command.toLowerCase();
  const validProducts = products.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string');
  const exactMatches = validProducts.filter((item) => lower.includes(String(item.name).toLowerCase()));
  if (exactMatches.length) return exactMatches.map((item) => String(item.id)).slice(0, 3);

  const genericTokens = new Set(['fresh', 'khmer', 'cambodian', 'kampot', 'whole', 'free', 'range', 'local', 'product']);
  return validProducts
    .filter((item) => {
      const normalized = String(item.name).toLowerCase();
      const meaningfulTokens = normalized.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 4 && !genericTokens.has(token));
      return meaningfulTokens.some((token) => lower.includes(token));
    })
    .map((item) => String(item.id))
    .slice(0, 3);
}

function fallbackPlan(command: string, context: Record<string, unknown>): MainAgentPlan {
  const lower = command.toLowerCase();
  const requestedProductIds = productIdsFromCommand(command, context);
  if (lower.includes('campaign') || lower.includes('telegram') || lower.includes('advert') || lower.includes('promote')) {
    return {
      intent: 'create_marketing_campaign',
      summary: 'Prepare a product-specific Telegram campaign draft, compare it with recent campaigns, and wait for final publish approval.',
      requiresWorkflow: true,
      warnings: ['Publishing requires a separate final approval for the exact campaign version.'],
      workflow: {
        name: requestedProductIds.length ? 'Product-specific Telegram campaign' : 'Smart Telegram campaign',
        goal: command,
        riskLevel: 'high',
        steps: [
          { id: 'step_1', skill: 'analytics', action: 'rank_products', dependsOn: [], requiresApproval: false, input: { preferredProductIds: requestedProductIds } },
          { id: 'step_2', skill: 'inventory', action: 'check_available_stock', dependsOn: ['step_1'], requiresApproval: false, input: { productIds: requestedProductIds } },
          { id: 'step_3', skill: 'finance', action: 'check_campaign_budget', dependsOn: ['step_2'], requiresApproval: false, input: { requestedAmount: 25 } },
          { id: 'step_4', skill: 'marketing', action: 'create_campaign_draft', dependsOn: ['step_3'], requiresApproval: false, input: { channel: 'telegram', productIds: requestedProductIds, campaignGoal: command, userRequest: command, creativeMode: 'user-led' } },
          { id: 'step_5', skill: 'marketing', action: 'publish_approved_campaign', dependsOn: ['step_4'], requiresApproval: true, input: {} },
          { id: 'step_6', skill: 'analytics', action: 'measure_campaign_performance', dependsOn: ['step_5'], requiresApproval: false, input: {} },
          { id: 'step_7', skill: 'analytics', action: 'learn_from_outcomes', dependsOn: ['step_6'], requiresApproval: false, input: {} },
        ],
      },
    };
  }
  if (lower.includes('refund')) {
    return {
      intent: 'prepare_refund', summary: 'Prepare a refund request and require explicit approval before contacting a payment provider.', requiresWorkflow: true,
      warnings: ['A valid order ID, amount, and payment-provider connection are required.'],
      workflow: { name: 'Refund review', goal: command, riskLevel: 'high', steps: [
        { id: 'step_1', skill: 'support', action: 'prepare_refund_request', dependsOn: [], requiresApproval: false, input: { requestText: command } },
        { id: 'step_2', skill: 'support', action: 'issue_approved_refund', dependsOn: ['step_1'], requiresApproval: true, input: {} },
      ] },
    };
  }
  if (lower.includes('order status') || lower.includes('mark order')) {
    return {
      intent: 'change_order_status', summary: 'Prepare an order-status change and wait for explicit approval.', requiresWorkflow: true,
      warnings: ['The order ID and target status must be verified before execution.'],
      workflow: { name: 'Order status review', goal: command, riskLevel: 'high', steps: [
        { id: 'step_1', skill: 'logistics', action: 'change_order_status', dependsOn: [], requiresApproval: true, input: { requestText: command } },
      ] },
    };
  }
  if (lower.includes('adjust inventory') || lower.includes('change inventory') || lower.includes('set stock')) {
    return {
      intent: 'adjust_inventory', summary: 'Prepare an exact inventory adjustment and wait for explicit approval.', requiresWorkflow: true,
      warnings: ['The product and exact stock adjustment must be verified before execution.'],
      workflow: { name: 'Inventory adjustment review', goal: command, riskLevel: 'high', steps: [
        { id: 'step_1', skill: 'inventory', action: 'adjust_inventory', dependsOn: [], requiresApproval: true, input: { requestText: command } },
      ] },
    };
  }
  if (lower.includes('price') || lower.includes('pricing')) {
    return {
      intent: 'dynamic_pricing', summary: 'Generate dynamic price recommendations and wait for approval before applying any change.', requiresWorkflow: true,
      warnings: ['Price changes are high-risk and require exact approval.'],
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
      intent: 'predict_inventory', summary: 'Forecast demand and identify reorder needs without changing stock.', requiresWorkflow: true, warnings: [],
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
    const plan = fallbackPlan(command, context);
    agentStore.setCache(cacheKey, plan, 10);
    return { plan, source: 'fallback' };
  }

  const memory = agentStore.getState().memories.slice(0, 15).map((item) => ({ topic: item.topic, content: item.content, confidence: item.confidence }));
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
      instructions: SYSTEM_PROMPT,
      input: JSON.stringify({ adminCommand: command, trustedContext: context, relevantVerifiedMemory: memory, planningNonce: crypto.randomUUID() }),
      text: {
        format: {
          type: 'json_schema',
          name: 'shopping_cambodia_main_agent_plan',
          strict: true,
          schema: PLAN_SCHEMA,
        },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI planning failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  const plan = validatePlan(JSON.parse(textFromResponse(await response.json())));
  agentStore.setCache(cacheKey, plan, 10);
  return { plan, source: 'openai' };
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((item) => item.length > 2));
}

export function campaignSimilarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function maxSimilarity(message: string, recent: RecentCampaignContext[]): number {
  return recent.reduce((max, campaign) => Math.max(max, campaignSimilarity(message, campaign.telegramMessageEn)), 0);
}

const GENERIC_ANGLES = [
  'local origin story',
  'sensory product experience',
  'use or serving inspiration',
  'quality and craftsmanship',
  'family sharing occasion',
  'educational product guide',
  'seasonal relevance',
  'convenience and everyday value',
  'curiosity-led product discovery',
  'quiet premium presentation',
  'playful product personality',
];

function includesAny(value: string, candidates: string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function extractAudience(raw: string, fallback: string): string {
  const patterns = [
    /(?:for|target(?:ing)?|aimed at)\s+(young adults|young people|students|families|parents|tourists|food lovers|durian lovers|repeat customers|new customers|local customers|premium buyers|budget shoppers)/i,
    /(?:for|target(?:ing)?|aimed at)\s+([^,.]{3,45}?)(?=\s+(?:with|without|using|in a|but|and make|and keep)\b|[,.]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match?.[1]) continue;
    const candidate = match[1].trim();
    if (!/product|stock|campaign|telegram|durian|fish|fruit|handicraft/i.test(candidate)) return candidate;
  }
  return fallback;
}

function quotedPhrases(raw: string): string[] {
  return [...raw.matchAll(/["“”']([^"“”']{2,80})["“”']/g)].map((match) => match[1].trim()).slice(0, 5);
}

export function interpretCampaignRequest(rawRequest: string, defaultAudience: string): CampaignCreativeBrief {
  const raw = rawRequest.trim() || 'Create a product campaign';
  const lower = raw.toLowerCase();

  let campaignPurpose = 'product promotion aligned to the user request';
  let desiredOutcome = 'help the selected audience notice and understand the product';
  let hardSell = false;
  const noHardSell = includesAny(lower, ['no hard sell', 'without hard sell', 'do not use a hard sell', "don't hard sell", 'soft sell only']);
  if (includesAny(lower, ['clear stock', 'move stock', 'overstock', 'sell remaining'])) {
    campaignPurpose = 'inventory movement';
    desiredOutcome = 'convert verified available stock without inventing urgency';
    hardSell = true;
  } else if (!noHardSell && includesAny(lower, ['sell', 'increase sales', 'more sales', 'conversion', 'get orders', 'buy now'])) {
    campaignPurpose = 'sales conversion';
    desiredOutcome = 'turn relevant interest into a purchase decision';
    hardSell = true;
  } else if (includesAny(lower, ['launch', 'new product', 'introduce'])) {
    campaignPurpose = 'product launch';
    desiredOutcome = 'make the product feel new, relevant and worth discovering';
  } else if (includesAny(lower, ['educate', 'teach', 'explain', 'how to', 'guide'])) {
    campaignPurpose = 'customer education';
    desiredOutcome = 'help customers understand the product and make an informed choice';
  } else if (includesAny(lower, ['engage', 'conversation', 'community', 'followers', 'comments'])) {
    campaignPurpose = 'audience engagement';
    desiredOutcome = 'create a response, conversation or memorable interaction';
  } else if (includesAny(lower, ['boost', 'awareness', 'visibility', 'make people notice', 'get attention']) || noHardSell) {
    campaignPurpose = 'product visibility and interest';
    desiredOutcome = 'make the product noticeable and interesting without forcing a sale';
  }

  let tone = 'creatively chosen to fit the product and purpose';
  if (includesAny(lower, ['funny', 'humor', 'humorous', 'playful', 'make them laugh'])) tone = 'playful and humorous';
  else if (includesAny(lower, ['premium', 'luxury', 'luxurious', 'elegant', 'exclusive'])) tone = 'refined and premium';
  else if (includesAny(lower, ['emotional', 'heartwarming', 'warm', 'family feeling'])) tone = 'warm and emotional';
  else if (includesAny(lower, ['bold', 'confident', 'strong'])) tone = 'bold and confident';
  else if (includesAny(lower, ['friendly', 'casual', 'like a friend'])) tone = 'friendly and conversational';
  else if (includesAny(lower, ['professional', 'formal'])) tone = 'professional and clear';
  else if (includesAny(lower, ['urgent', 'urgency'])) tone = 'urgent but truthful';

  let contentStyle = 'open creative format';
  if (includesAny(lower, ['story', 'storytelling', 'tell a story', 'narrative'])) contentStyle = 'micro-story or narrative';
  else if (includesAny(lower, ['dialogue', 'conversation', 'talking', 'product talks', 'pretend the product'])) contentStyle = 'dialogue or character voice';
  else if (includesAny(lower, ['question', 'curiosity', 'make them curious', 'mystery'])) contentStyle = 'curiosity-led question';
  else if (includesAny(lower, ['educational', 'explain', 'guide', 'how to', 'teach'])) contentStyle = 'helpful educational creative';
  else if (includesAny(lower, ['minimal', 'minimalist', 'very short', 'one line'])) contentStyle = 'minimalist creative';
  else if (includesAny(lower, ['poetic', 'sensory', 'describe the taste', 'describe the smell'])) contentStyle = 'sensory or poetic creative';
  else if (includesAny(lower, ['funny', 'humor', 'humorous', 'make them laugh'])) contentStyle = 'setup-and-payoff humor';
  else if (hardSell) contentStyle = 'benefit-led conversion creative';
  if (includesAny(lower, ['funny', 'humor', 'humorous', 'playful', 'make them laugh'])
    && includesAny(lower, ['question', 'curiosity', 'make them curious', 'mystery'])) {
    contentStyle = 'playful curiosity hook with setup-and-payoff humor';
  }

  const nonAdvertorial = includesAny(lower, ["not like an ad", 'not an ad', 'not like an advertisement', "don't sound like an ad", "don't make it sound like an ad", "don't make it sound like an advertisement", 'do not sound like an ad', 'do not sound like an advertisement', 'do not make it sound like an ad', 'do not make it sound like an advertisement', 'native content']);
  let contentShape = 'one cohesive free-form campaign message with no forced template';
  if (nonAdvertorial) contentShape = 'native, human and editorial free-form copy that does not read like an advertisement';
  else if (contentStyle.includes('story')) contentShape = 'one flowing narrative without campaign labels or repeated sections';
  else if (contentStyle.includes('dialogue')) contentShape = 'a natural dialogue or character moment';
  else if (contentStyle.includes('question')) contentShape = 'a curiosity hook followed by one satisfying product idea';
  else if (contentStyle.includes('educational')) contentShape = 'a useful explanation that naturally connects to the product';
  else if (contentStyle.includes('minimalist')) contentShape = 'a few deliberate free-form lines';
  else if (contentStyle.includes('humor')) contentShape = 'a short setup and payoff built around the product';

  let desiredReaction = 'interest and product consideration';
  if (tone.includes('humorous')) desiredReaction = 'a smile, recognition and curiosity';
  else if (campaignPurpose === 'sales conversion') desiredReaction = 'confidence and readiness to purchase';
  else if (campaignPurpose === 'product visibility and interest') desiredReaction = 'curiosity and a desire to discover the product';
  else if (campaignPurpose === 'customer education') desiredReaction = 'understanding and informed interest';
  else if (campaignPurpose === 'audience engagement') desiredReaction = 'a reply, reaction or conversation';
  else if (tone.includes('premium')) desiredReaction = 'desire, trust and perceived value';

  const lengthPreference: CampaignCreativeBrief['lengthPreference'] = includesAny(lower, ['very short', 'short', 'brief', 'one line'])
    ? 'short'
    : includesAny(lower, ['long', 'detailed', 'full story']) ? 'long' : 'auto';
  const emojiPreference: CampaignCreativeBrief['emojiPreference'] = includesAny(lower, ['no emoji', 'without emoji', 'do not use emoji', "don't use emoji"])
    ? 'none'
    : includesAny(lower, ['lots of emoji', 'many emoji', 'expressive emoji']) ? 'expressive'
      : includesAny(lower, ['use emoji', 'with emoji', 'some emoji']) ? 'light' : 'auto';
  const pricePreference: CampaignCreativeBrief['pricePreference'] = includesAny(lower, ['no price', 'without price', 'do not mention price', "don't mention price", 'hide price'])
    ? 'exclude'
    : includesAny(lower, ['include price', 'mention price', 'show price', 'with price']) ? 'include' : 'only-if-useful';
  const stockPreference: CampaignCreativeBrief['stockPreference'] = includesAny(lower, ['no stock', 'without stock', 'do not mention stock', "don't mention stock"])
    ? 'exclude'
    : includesAny(lower, ['include stock', 'mention stock', 'show stock', 'with stock', 'clear stock']) ? 'include' : 'only-if-useful';

  if (noHardSell) hardSell = false;

  const mustAvoid: string[] = [];
  if (emojiPreference === 'none') mustAvoid.push('emojis');
  if (pricePreference === 'exclude') mustAvoid.push('price mentions');
  if (stockPreference === 'exclude') mustAvoid.push('stock counts or scarcity language');
  if (includesAny(lower, ['no discount', 'without discount', 'do not mention discount'])) mustAvoid.push('discount language');
  if (includesAny(lower, ['no urgency', 'without urgency', 'do not use urgency'])) mustAvoid.push('urgency language');
  if (includesAny(lower, ['no hashtag', 'without hashtag', 'do not use hashtag'])) mustAvoid.push('hashtags');
  if (includesAny(lower, ['no cta', 'without cta', 'do not use a call to action'])) mustAvoid.push('explicit call to action');
  if (nonAdvertorial || noHardSell) mustAvoid.push('generic advertisement wording and hard-sell language');

  const mustInclude = quotedPhrases(raw);
  if (pricePreference === 'include') mustInclude.push('verified current price');
  if (stockPreference === 'include') mustInclude.push('verified stock information');

  const userSpecifiedDirection = tone !== 'creatively chosen to fit the product and purpose'
    || contentStyle !== 'open creative format'
    || lengthPreference !== 'auto'
    || emojiPreference !== 'auto'
    || pricePreference !== 'only-if-useful'
    || stockPreference !== 'only-if-useful'
    || nonAdvertorial;

  return {
    rawRequest: raw,
    campaignPurpose,
    desiredOutcome,
    targetAudience: extractAudience(raw, defaultAudience),
    tone,
    contentStyle,
    contentShape,
    desiredReaction,
    lengthPreference,
    emojiPreference,
    pricePreference,
    stockPreference,
    hardSell,
    userSpecifiedDirection,
    mustInclude: [...new Set(mustInclude)],
    mustAvoid: [...new Set(mustAvoid)],
  };
}

function availableAngles(input: CampaignDraftInput, brief: CampaignCreativeBrief): string[] {
  const productText = input.products.map((item) => `${item.name} ${item.category} ${item.description}`).join(' ').toLowerCase();
  const userLedAngles: string[] = [];
  if (brief.contentStyle.includes('humor')) userLedAngles.push('playful product personality');
  if (brief.contentStyle.includes('story')) userLedAngles.push('single-scene product story');
  if (brief.contentStyle.includes('dialogue')) userLedAngles.push('product character dialogue');
  if (brief.contentStyle.includes('question')) userLedAngles.push('curiosity gap and reveal');
  if (brief.contentStyle.includes('educational')) userLedAngles.push('useful product truth');
  if (brief.contentStyle.includes('minimalist')) userLedAngles.push('minimal product statement');
  if (brief.contentStyle.includes('sensory')) userLedAngles.push('sensory product moment');
  if (brief.tone.includes('premium')) userLedAngles.push('quiet premium presentation');
  if (brief.campaignPurpose.includes('visibility')) userLedAngles.push('unexpected product discovery');
  if (brief.campaignPurpose.includes('conversion')) userLedAngles.push('benefit-led purchase confidence');

  const productAngles = productText.includes('durian')
    ? ['creamy sensory experience', 'Cambodian orchard origin', 'family durian sharing', 'ripeness and serving guide', 'seasonal durian appreciation']
    : productText.includes('fish')
      ? ['fresh cooking inspiration', 'source and preparation story', 'family meal convenience']
      : productText.includes('handicraft') || productText.includes('krama') || productText.includes('pottery')
        ? ['maker craftsmanship', 'Cambodian cultural story', 'meaningful local gift']
        : [];
  const recentAngles = new Set(input.recentCampaigns.map((item) => item.creativeAngle.toLowerCase()));
  const preferred = [...userLedAngles, ...productAngles, ...GENERIC_ANGLES].filter((angle, index, all) => all.indexOf(angle) === index && !recentAngles.has(angle.toLowerCase()));
  return preferred.length ? preferred : [...userLedAngles, ...productAngles, ...GENERIC_ANGLES];
}

function exactPriceLine(product: CampaignProductContext | undefined, brief: CampaignCreativeBrief): string {
  if (!product || brief.pricePreference === 'exclude') return '';
  if (brief.pricePreference === 'include' || brief.hardSell) return `Current verified listing: $${product.price.toFixed(2)} per ${product.unit}.`;
  return '';
}

function exactStockLine(product: CampaignProductContext | undefined, brief: CampaignCreativeBrief): string {
  if (!product || brief.stockPreference === 'exclude') return '';
  if (brief.stockPreference === 'include') return `${product.stock} ${product.unit} are recorded as available for this draft.`;
  if (brief.campaignPurpose === 'inventory movement') return `${product.stock} ${product.unit} are recorded as available for this draft.`;
  return '';
}

function campaignCta(names: string, brief: CampaignCreativeBrief): string {
  if (brief.mustAvoid.includes('explicit call to action')) return 'none';
  if (brief.contentShape.includes('does not read like an advertisement')) return 'none';
  if (brief.campaignPurpose === 'audience engagement') return `Tell us what ${names} means to you`;
  if (brief.campaignPurpose === 'customer education') return `Discover the verified details of ${names}`;
  if (brief.hardSell) return `Choose ${names} on Shopping Cambodia`;
  return `Discover ${names}`;
}

function emojiPrefix(brief: CampaignCreativeBrief): string {
  if (brief.emojiPreference === 'expressive') return '✨🌿 ';
  if (brief.emojiPreference === 'light') return '✨ ';
  return '';
}

function fallbackCreativeCopy(input: CampaignDraftInput, brief: CampaignCreativeBrief, angle: string): { en: string; kh: string; callToAction: string } {
  const first = input.products[0];
  const names = input.products.map((item) => item.name).join(', ') || 'the selected products';
  const description = first?.description?.trim() || `${names} is listed in the Shopping Cambodia catalogue.`;
  const priceLine = exactPriceLine(first, brief);
  const stockLine = exactStockLine(first, brief);
  const cta = campaignCta(names, brief);
  const prefix = emojiPrefix(brief);
  const closeEn = cta === 'none' ? '' : cta + '.';
  const closeKh = cta === 'none' ? '' : `ស្វែងយល់បន្ថែមអំពី ${names} នៅ Shopping Cambodia។`;
  const lowerStyle = `${brief.contentStyle} ${angle}`.toLowerCase();
  const lowerTone = brief.tone.toLowerCase();
  const short = brief.lengthPreference === 'short';
  const long = brief.lengthPreference === 'long';

  let en: string;
  let kh: string;
  if (lowerStyle.includes('humor') || lowerStyle.includes('playful')) {
    en = short
      ? `${names} has never been good at making a quiet entrance. ${description} Worth noticing? Definitely.`
      : `${names} has never been good at making a quiet entrance.\n\n${description}\n\nSome products ask politely for attention. This one simply arrives and becomes the conversation.${closeEn ? `\n\n${closeEn}` : ''}`;
    kh = short
      ? `${names} មិនសូវចេះចូលមកស្ងាត់ៗទេ។ ${description} គួរឱ្យចាប់អារម្មណ៍មែនទេ? ច្បាស់ណាស់។`
      : `${names} មិនសូវចេះចូលមកស្ងាត់ៗទេ។\n\n${description}\n\nផលិតផលខ្លះសុំការចាប់អារម្មណ៍យ៉ាងសុភាព។ តែផលិតផលនេះគ្រាន់តែមកដល់ ហើយក្លាយជាប្រធានបទនៃការសន្ទនា។${closeKh ? `\n\n${closeKh}` : ''}`;
  } else if (lowerStyle.includes('sensory') || lowerStyle.includes('creamy')) {
    en = `${prefix}${names} does not begin with a sales line. It begins with the senses.\n\n${description}\n\nThe creative idea is to let the product's verified character create interest before asking for attention.${priceLine ? `\n\n${priceLine}` : ''}${closeEn ? `\n\n${closeEn}` : ''}`;
    kh = `${prefix}${names} មិនចាប់ផ្តើមដោយពាក្យលក់ទេ។ វាចាប់ផ្តើមពីអារម្មណ៍នៃការស្គាល់ផលិតផល។\n\n${description}\n\nគំនិតច្នៃប្រឌិតគឺឱ្យលក្ខណៈពិតរបស់ផលិតផលបង្កើតការចាប់អារម្មណ៍ជាមុន។${closeKh ? `\n\n${closeKh}` : ''}`;
  } else if (lowerStyle.includes('story') || lowerStyle.includes('origin') || lowerStyle.includes('orchard') || lowerStyle.includes('cultural') || lowerStyle.includes('craftsmanship') || lowerStyle.includes('family') || lowerStyle.includes('sharing') || lowerTone.includes('emotional')) {
    en = `${prefix}It begins with one simple detail: ${description}\n\nThen ${names} becomes more than a listing. It becomes the product someone brings into a family moment, a weekend plan, or a memory worth sharing.${long ? ' The campaign invites the audience to imagine that moment before it asks them to make any decision.' : ''}${priceLine ? `\n\n${priceLine}` : ''}${stockLine ? `\n${stockLine}` : ''}${closeEn ? `\n\n${closeEn}` : ''}`;
    kh = `${prefix}រឿងនេះចាប់ផ្តើមពីព័ត៌មានសាមញ្ញមួយ៖ ${description}\n\nបន្ទាប់មក ${names} មិនមែនគ្រាន់តែជាទំនិញក្នុងបញ្ជីទេ។ វាអាចក្លាយជាផ្នែកមួយនៃពេលវេលាគ្រួសារ ផែនការចុងសប្តាហ៍ ឬអនុស្សាវរីយ៍ដែលគួរចែករំលែក។${priceLine ? `\n\nតម្លៃបច្ចុប្បន្នដែលបានបញ្ជាក់គឺ $${first?.price.toFixed(2)} ក្នុងមួយ ${first?.unit}។` : ''}${closeKh ? `\n\n${closeKh}` : ''}`;
  } else if (lowerStyle.includes('dialogue')) {
    en = `${prefix}“Why is everyone looking this way?”\n\n“Because ${names} just arrived.”\n\n${description}${priceLine ? `\n\n${priceLine}` : ''}${closeEn ? `\n\n${closeEn}` : ''}`;
    kh = `${prefix}«ហេតុអ្វីបានជាមនុស្សគ្រប់គ្នាមើលមកទីនេះ?»\n\n«ព្រោះ ${names} ទើបមកដល់។»\n\n${description}${closeKh ? `\n\n${closeKh}` : ''}`;
  } else if (lowerStyle.includes('question') || lowerStyle.includes('curiosity') || lowerStyle.includes('discovery')) {
    en = `${prefix}What makes ${names} worth a second look?\n\n${description}\n\nNot a repeated sales promise—just a product with enough character to make people curious.${priceLine ? `\n\n${priceLine}` : ''}${closeEn ? `\n\n${closeEn}` : ''}`;
    kh = `${prefix}តើអ្វីធ្វើឱ្យ ${names} គួរឱ្យមើលម្ដងទៀត?\n\n${description}\n\nមិនមែនជាពាក្យលក់ដដែលៗទេ ប៉ុន្តែជាផលិតផលដែលមានលក្ខណៈពិសេសគ្រប់គ្រាន់ដើម្បីបង្កើតការចង់ដឹង។${closeKh ? `\n\n${closeKh}` : ''}`;
  } else if (lowerStyle.includes('educational') || lowerStyle.includes('guide') || lowerStyle.includes('inspiration') || lowerStyle.includes('serving') || lowerStyle.includes('cooking')) {
    en = `${prefix}Before choosing ${names}, start with what is verified.\n\n${description}${priceLine ? `\n${priceLine}` : ''}${stockLine ? `\n${stockLine}` : ''}\n\nA useful campaign should help people understand the product, not pressure them with invented claims.${closeEn ? `\n\n${closeEn}` : ''}`;
    kh = `${prefix}មុនជ្រើសរើស ${names} សូមចាប់ផ្តើមពីព័ត៌មានដែលបានបញ្ជាក់។\n\n${description}\n\nយុទ្ធនាការដែលមានប្រយោជន៍គួរជួយឱ្យមនុស្សយល់អំពីផលិតផល មិនមែនដាក់សម្ពាធដោយការអះអាងដែលមិនបានបញ្ជាក់ទេ។${closeKh ? `\n\n${closeKh}` : ''}`;
  } else if (lowerStyle.includes('minimalist')) {
    en = `${prefix}${names}.\n${description}${priceLine ? `\n${priceLine}` : ''}${closeEn ? `\n${closeEn}` : ''}`;
    kh = `${prefix}${names}។\n${description}${closeKh ? `\n${closeKh}` : ''}`;
  } else if (lowerTone.includes('premium') || lowerStyle.includes('premium') || lowerStyle.includes('quality')) {
    en = `${prefix}No noise. No exaggerated promise.\n\n${names}.\n${description}${priceLine ? `\n\n${priceLine}` : ''}\n\nPresented with confidence, because value does not need to shout.${closeEn ? `\n\n${closeEn}` : ''}`;
    kh = `${prefix}គ្មានសំឡេងរំខាន។ គ្មានការសន្យាហួសហេតុ។\n\n${names}។\n${description}\n\nបង្ហាញដោយភាពជឿជាក់ ព្រោះតម្លៃពិតមិនចាំបាច់ស្រែកទេ។${closeKh ? `\n\n${closeKh}` : ''}`;
  } else if (brief.campaignPurpose === 'product visibility and interest') {
    en = `${prefix}Some products need a long introduction. ${names} only needs one honest look.\n\n${description}\n\nThis is not a forced sales pitch. It is an invitation to notice what makes the product different.${closeEn ? `\n\n${closeEn}` : ''}`;
    kh = `${prefix}ផលិតផលខ្លះត្រូវការការណែនាំវែង។ តែ ${names} ត្រូវការតែការមើលដោយស្មោះត្រង់មួយដង។\n\n${description}\n\nនេះមិនមែនជាការបង្ខំលក់ទេ។ វាជាការអញ្ជើញឱ្យសង្កេតអ្វីដែលធ្វើឱ្យផលិតផលនេះខុសប្លែក។${closeKh ? `\n\n${closeKh}` : ''}`;
  } else {
    en = `${prefix}${names} is ready to be understood on its own terms.\n\n${description}${priceLine ? `\n\n${priceLine}` : ''}${stockLine ? `\n${stockLine}` : ''}\n\nThe message follows the user's goal instead of forcing the product into a repeated campaign template.${closeEn ? `\n\n${closeEn}` : ''}`;
    kh = `${prefix}${names} ត្រៀមរួចរាល់ឱ្យមនុស្សស្គាល់តាមលក្ខណៈពិតរបស់វា។\n\n${description}\n\nសារនេះធ្វើតាមគោលបំណងរបស់អ្នកប្រើ មិនមែនបង្ខំផលិតផលឱ្យចូលក្នុងទម្រង់យុទ្ធនាការដដែលៗទេ។${closeKh ? `\n\n${closeKh}` : ''}`;
  }

  if (brief.emojiPreference === 'none') {
    en = en.replace(/\p{Extended_Pictographic}/gu, '').trim();
    kh = kh.replace(/\p{Extended_Pictographic}/gu, '').trim();
  }
  return { en, kh, callToAction: cta };
}

function maxCampaignSimilarity(en: string, kh: string, recent: RecentCampaignContext[]): number {
  return recent.reduce((max, campaign) => Math.max(
    max,
    campaignSimilarity(en, campaign.telegramMessageEn),
    campaignSimilarity(kh, campaign.telegramMessageKh),
  ), 0);
}

function fallbackCampaign(input: CampaignDraftInput): CampaignDraftOutput {
  const brief = input.creativeBrief ?? interpretCampaignRequest(input.userRequest ?? input.campaignGoal, input.audience);
  const products = input.products;
  const names = products.map((item) => item.name).join(', ') || 'selected Cambodian products';
  const angles = availableAngles(input, brief);
  const seed = crypto.createHash('sha256').update(`${brief.rawRequest}:${names}:${Date.now()}:${crypto.randomUUID()}`).digest().readUInt32BE(0);
  const rotatedAngles = brief.userSpecifiedDirection
    ? angles
    : [...angles.slice(seed % angles.length), ...angles.slice(0, seed % angles.length)];
  let selectedAngle = rotatedAngles[0];
  let selectedCopy = fallbackCreativeCopy(input, brief, selectedAngle);
  let selectedScore = maxCampaignSimilarity(selectedCopy.en, selectedCopy.kh, input.recentCampaigns);
  for (const angle of rotatedAngles.slice(1)) {
    const candidate = fallbackCreativeCopy(input, brief, angle);
    const score = maxCampaignSimilarity(candidate.en, candidate.kh, input.recentCampaigns);
    if (score < selectedScore) {
      selectedAngle = angle;
      selectedCopy = candidate;
      selectedScore = score;
    }
    if (score <= 0.62) break;
  }

  const first = products[0];
  const facts = products.map((product) => `${product.name}: ${product.description}; $${product.price.toFixed(2)} per ${product.unit}; ${product.stock} recorded available.`);
  return {
    campaignName: `${first?.name ?? 'Shopping Cambodia'} — ${selectedAngle}`,
    objective: brief.desiredOutcome,
    userIntent: brief.rawRequest,
    campaignPurpose: brief.campaignPurpose,
    targetAudience: brief.targetAudience,
    tone: brief.tone,
    contentStyle: brief.contentStyle,
    contentShape: brief.contentShape,
    desiredReaction: brief.desiredReaction,
    creativeAngle: selectedAngle,
    creativeRationale: `The concept follows the user's requested purpose, tone and format while avoiding recent campaign patterns.`,
    kh: selectedCopy.kh,
    en: selectedCopy.en,
    callToAction: selectedCopy.callToAction,
    productFactsUsed: facts,
    userLogicMatch: [
      `Purpose: ${brief.campaignPurpose}`,
      `Tone: ${brief.tone}`,
      `Style: ${brief.contentStyle}`,
      `Format: ${brief.contentShape}`,
      ...brief.mustAvoid.map((item) => `Avoided: ${item}`),
    ],
    variationNotes: [
      'Uses one user-led creative concept instead of a fixed campaign template',
      'Adapts the message shape to the requested purpose and tone',
      'Changes the opening, rhythm and closing from recent campaigns',
      'Uses only verified product facts and explicit user constraints',
    ],
    similarityScore: Number(selectedScore.toFixed(3)),
    contentFingerprint: crypto.createHash('sha256').update(`${selectedCopy.kh}\n${selectedCopy.en}`).digest('hex'),
    source: 'fallback',
  };
}

const CAMPAIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'campaignName', 'objective', 'userIntent', 'campaignPurpose', 'targetAudience', 'tone', 'contentStyle',
    'contentShape', 'desiredReaction', 'creativeAngle', 'creativeRationale', 'kh', 'en', 'callToAction',
    'productFactsUsed', 'userLogicMatch', 'variationNotes',
  ],
  properties: {
    campaignName: { type: 'string' },
    objective: { type: 'string' },
    userIntent: { type: 'string' },
    campaignPurpose: { type: 'string' },
    targetAudience: { type: 'string' },
    tone: { type: 'string' },
    contentStyle: { type: 'string' },
    contentShape: { type: 'string' },
    desiredReaction: { type: 'string' },
    creativeAngle: { type: 'string' },
    creativeRationale: { type: 'string' },
    kh: { type: 'string' },
    en: { type: 'string' },
    callToAction: { type: 'string' },
    productFactsUsed: { type: 'array', items: { type: 'string' } },
    userLogicMatch: { type: 'array', minItems: 2, items: { type: 'string' } },
    variationNotes: { type: 'array', minItems: 4, items: { type: 'string' } },
  },
};

function parseCampaignOutput(value: unknown): Omit<CampaignDraftOutput, 'similarityScore' | 'contentFingerprint' | 'source'> {
  if (!value || typeof value !== 'object') throw new Error('Campaign output must be an object.');
  const record = value as Record<string, unknown>;
  const requiredStrings = [
    'campaignName', 'objective', 'userIntent', 'campaignPurpose', 'targetAudience', 'tone', 'contentStyle',
    'contentShape', 'desiredReaction', 'creativeAngle', 'creativeRationale', 'kh', 'en', 'callToAction',
  ] as const;
  for (const key of requiredStrings) if (typeof record[key] !== 'string' || !String(record[key]).trim()) throw new Error(`Campaign output is missing ${key}.`);
  if (!Array.isArray(record.productFactsUsed) || !record.productFactsUsed.every((item) => typeof item === 'string')) throw new Error('Campaign product facts are invalid.');
  if (!Array.isArray(record.userLogicMatch) || record.userLogicMatch.length < 2 || !record.userLogicMatch.every((item) => typeof item === 'string')) throw new Error('Campaign user-logic notes are invalid.');
  if (!Array.isArray(record.variationNotes) || record.variationNotes.length < 4 || !record.variationNotes.every((item) => typeof item === 'string')) throw new Error('Campaign variation notes are invalid.');
  return record as unknown as Omit<CampaignDraftOutput, 'similarityScore' | 'contentFingerprint' | 'source'>;
}

function campaignConstraintViolations(
  draft: Omit<CampaignDraftOutput, 'similarityScore' | 'contentFingerprint' | 'source'>,
  input: CampaignDraftInput,
  brief: CampaignCreativeBrief,
): string[] {
  const combined = `${draft.kh}\n${draft.en}`;
  const lower = combined.toLowerCase();
  const violations: string[] = [];
  if (brief.emojiPreference === 'none' && /\p{Extended_Pictographic}/u.test(combined)) violations.push('The user requested no emojis.');
  if (brief.pricePreference === 'exclude') {
    const exactPrices = input.products.flatMap((product) => [`$${product.price.toFixed(2)}`, `$${product.price}`, product.price.toFixed(2)]);
    if (exactPrices.some((value) => combined.includes(value)) || /\bprice\b/i.test(draft.en)) violations.push('The user requested no price mention.');
  }
  if (brief.stockPreference === 'exclude' && (/\bstock\b/i.test(draft.en) || /\bunits? available\b/i.test(draft.en))) violations.push('The user requested no stock mention.');
  if (brief.mustAvoid.includes('discount language') && includesAny(lower, ['discount', 'special offer', 'sale price'])) violations.push('The user requested no discount language.');
  if (brief.mustAvoid.includes('urgency language') && includesAny(lower, ['hurry', 'last chance', 'limited time', 'act now'])) violations.push('The user requested no urgency language.');
  if (brief.mustAvoid.includes('hashtags') && combined.includes('#')) violations.push('The user requested no hashtags.');
  if (brief.contentShape.includes('does not read like an advertisement') && includesAny(lower, ['buy now', 'order now', 'special offer', "don't miss out"])) violations.push('The user requested non-advertorial copy.');
  if (brief.lengthPreference === 'short' && draft.en.length > 520) violations.push('The user requested a short campaign.');
  return violations;
}

async function callCampaignModel(input: CampaignDraftInput, retryInstruction = ''): Promise<Omit<CampaignDraftOutput, 'similarityScore' | 'contentFingerprint' | 'source'>> {
  const brief = input.creativeBrief ?? interpretCampaignRequest(input.userRequest ?? input.campaignGoal, input.audience);
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
      instructions: `${MARKETING_PROMPT}\n${retryInstruction}`,
      input: JSON.stringify({
        ...input,
        userRequest: input.userRequest ?? input.campaignGoal,
        creativeBrief: brief,
        generationNonce: crypto.randomUUID(),
        avoidAngles: input.recentCampaigns.map((item) => item.creativeAngle),
        avoidCallsToAction: input.recentCampaigns.map((item) => item.callToAction),
        avoidStyles: input.recentCampaigns.map((item) => item.contentStyle).filter(Boolean),
        instructionPriority: ['truth and safety', 'explicit user creative logic', 'product fit', 'originality', 'brand clarity'],
      }),
      text: { format: { type: 'json_schema', name: 'shopping_cambodia_user_led_campaign', strict: true, schema: CAMPAIGN_SCHEMA } },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI campaign draft failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  return parseCampaignOutput(JSON.parse(textFromResponse(await response.json())));
}

export async function draftCampaignContent(input: CampaignDraftInput): Promise<CampaignDraftOutput> {
  const normalized: CampaignDraftInput = {
    ...input,
    userRequest: input.userRequest ?? input.campaignGoal,
    creativeBrief: input.creativeBrief ?? interpretCampaignRequest(input.userRequest ?? input.campaignGoal, input.audience),
  };
  if (!process.env.OPENAI_API_KEY) return fallbackCampaign(normalized);

  let parsed = await callCampaignModel(normalized);
  let score = maxCampaignSimilarity(parsed.en, parsed.kh, normalized.recentCampaigns);
  let violations = campaignConstraintViolations(parsed, normalized, normalized.creativeBrief!);
  const threshold = Math.max(0.35, Math.min(0.9, Number(process.env.CAMPAIGN_SIMILARITY_THRESHOLD ?? 0.62)));
  if ((score > threshold && normalized.recentCampaigns.length) || violations.length) {
    const reasons = [
      score > threshold ? `The previous draft was too similar to recent campaigns (similarity ${score.toFixed(2)}).` : '',
      ...violations,
    ].filter(Boolean).join(' ');
    parsed = await callCampaignModel(normalized, `${reasons} Rebuild the campaign from a different creative concept. Follow the user's exact logic, change the opening, shape, rhythm and closing, and do not paraphrase the rejected draft.`);
    score = maxCampaignSimilarity(parsed.en, parsed.kh, normalized.recentCampaigns);
    violations = campaignConstraintViolations(parsed, normalized, normalized.creativeBrief!);
  }
  if (violations.length) throw new Error(`Generated campaign did not follow the user brief: ${violations.join(' ')}`);
  if (score > 0.8) throw new Error('Generated campaign remained too similar to recent campaigns. Review recent campaign constraints and retry.');

  const brief = normalized.creativeBrief!;
  return {
    ...parsed,
    userIntent: brief.rawRequest,
    campaignPurpose: brief.campaignPurpose,
    targetAudience: brief.targetAudience,
    tone: brief.tone === 'creatively chosen to fit the product and purpose' ? parsed.tone : brief.tone,
    contentStyle: brief.contentStyle === 'open creative format' ? parsed.contentStyle : brief.contentStyle,
    contentShape: brief.contentShape,
    desiredReaction: brief.desiredReaction,
    similarityScore: Number(score.toFixed(3)),
    contentFingerprint: crypto.createHash('sha256').update(`${parsed.kh}\n${parsed.en}`).digest('hex'),
    source: 'openai',
  };
}
