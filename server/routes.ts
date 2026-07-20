import { Router, type Request, type Response, type NextFunction } from 'express';
import { agentStore } from './store.js';
import {
  createBoostApproval,
  createWorkflowFromCommand,
  decideApproval,
  retryFailedCampaignRecipients,
  runWorkflow,
  updateCampaignDraft,
} from './agent-engine.js';
import { configureHeartbeat, runHeartbeat } from './heartbeat.js';
import {
  calculateCustomerSegments,
  calculateDynamicPricing,
  calculateInventoryForecasts,
  calculateProductBoosts,
  calculateRevenueOpportunities,
  storePublicBoosts,
} from './phase2-service.js';
import type { SkillId, StoreEvent, TelegramSubscriber } from './types.js';

export const agentRouter = Router();

function actorFrom(req: Request) {
  return String(req.header('x-admin-user') || 'admin');
}

function roleFrom(req: Request) {
  return String(req.header('x-admin-role') || 'admin');
}

function adminAuth(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected && process.env.NODE_ENV !== 'production') return next();
  if (!expected) return res.status(503).json({ error: 'ADMIN_API_KEY is not configured.' });
  if (req.header('x-admin-key') !== expected) return res.status(401).json({ error: 'Unauthorized admin request.' });
  next();
}

function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!roles.includes(roleFrom(req))) return res.status(403).json({ error: `Role ${roleFrom(req)} cannot perform this action.` });
    next();
  };
}

agentRouter.get('/public/boosts', (_req, res) => {
  res.json(storePublicBoosts());
});

agentRouter.post('/events', (req, res) => {
  const allowed = ['product_view', 'add_to_cart', 'purchase', 'search', 'checkout_started'];
  if (!allowed.includes(req.body?.type)) return res.status(400).json({ error: 'Invalid event type.' });
  const event: StoreEvent = {
    id: `event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: req.body.type,
    productId: typeof req.body.productId === 'string' ? req.body.productId : undefined,
    userId: typeof req.body.userId === 'string' ? req.body.userId : undefined,
    sessionId: typeof req.body.sessionId === 'string' ? req.body.sessionId : undefined,
    quantity: Number.isFinite(Number(req.body.quantity)) ? Number(req.body.quantity) : undefined,
    value: Number.isFinite(Number(req.body.value)) ? Number(req.body.value) : undefined,
    metadata: req.body.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : undefined,
    createdAt: new Date().toISOString(),
  };
  agentStore.mutate((draft) => {
    draft.events.unshift(event);
    draft.events = draft.events.slice(0, 20_000);
  });
  res.status(201).json({ ok: true, eventId: event.id });
});

agentRouter.use('/admin', adminAuth);

agentRouter.get('/admin/state', (_req, res) => {
  res.json(agentStore.getState());
});

agentRouter.patch('/admin/controls', requireRole('owner', 'admin'), (req, res) => {
  const allowed = ['brainEnabled', 'automationPaused', 'learningEnabled', 'dynamicPricingEnabled', 'segmentationEnabled', 'revenueOptimizationEnabled', 'predictiveInventoryEnabled'];
  const state = agentStore.mutate((draft) => {
    for (const key of allowed) {
      if (typeof req.body?.[key] === 'boolean') (draft.controls as any)[key] = req.body[key];
    }
    return structuredClone(draft.controls);
  });
  agentStore.addAudit({ actor: actorFrom(req), actorRole: roleFrom(req), action: 'agent_controls_updated', newState: state, success: true });
  res.json(state);
});

agentRouter.patch('/admin/skills/:skillId', requireRole('owner', 'admin'), (req, res) => {
  try {
    const skill = agentStore.updateSkill(req.params.skillId as SkillId, Boolean(req.body.enabled));
    agentStore.addAudit({ actor: actorFrom(req), actorRole: roleFrom(req), action: skill.enabled ? 'skill_enabled' : 'skill_disabled', skill: skill.id, newState: { enabled: skill.enabled }, success: true });
    res.json(skill);
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

agentRouter.patch('/admin/skills/:skillId/actions/:actionId', requireRole('owner', 'admin'), (req, res) => {
  try {
    const skill = agentStore.updateSkillAction(req.params.skillId as SkillId, req.params.actionId, Boolean(req.body.enabled));
    agentStore.addAudit({ actor: actorFrom(req), actorRole: roleFrom(req), action: Boolean(req.body.enabled) ? 'skill_action_enabled' : 'skill_action_disabled', skill: skill.id, businessRecordId: req.params.actionId, success: true });
    res.json(skill);
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

agentRouter.post('/admin/main-agent/plan', requireRole('owner', 'admin', 'operator'), async (req, res) => {
  try {
    const command = String(req.body?.command ?? '').trim();
    if (!command) return res.status(400).json({ error: 'Command is required.' });
    const result = await createWorkflowFromCommand(command, actorFrom(req));
    res.status(201).json(result);
  } catch (error: any) {
    agentStore.addAudit({ actor: actorFrom(req), actorRole: roleFrom(req), action: 'main_agent_plan_failed', inputSummary: String(req.body?.command ?? ''), resultSummary: 'Planning failed.', success: false, error: { code: error?.code ?? 'PLAN_FAILED', message: error instanceof Error ? error.message : String(error) } });
    res.status(400).json({ error: error instanceof Error ? error.message : String(error), code: error?.code });
  }
});

agentRouter.post('/admin/workflows/:id/run', requireRole('owner', 'admin', 'operator'), async (req, res) => {
  try {
    res.json(await runWorkflow(req.params.id, actorFrom(req)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

agentRouter.post('/admin/approvals/:id/:decision', requireRole('owner', 'admin', 'reviewer'), async (req, res) => {
  const decision = req.params.decision;
  if (!['approved', 'rejected', 'changes_requested'].includes(decision)) return res.status(400).json({ error: 'Invalid approval decision.' });
  try {
    res.json(await decideApproval(req.params.id, decision as any, actorFrom(req), String(req.body?.note ?? '')));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

agentRouter.patch('/admin/campaigns/:id', requireRole('owner', 'admin', 'operator'), (req, res) => {
  try {
    res.json(updateCampaignDraft(req.params.id, req.body ?? {}));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

agentRouter.post('/admin/campaigns/:id/retry', requireRole('owner', 'admin', 'reviewer'), (req, res) => {
  try {
    res.json(retryFailedCampaignRecipients(req.params.id));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

agentRouter.get('/admin/telegram-subscribers', (_req, res) => res.json(agentStore.getState().telegramSubscribers));
agentRouter.post('/admin/telegram-subscribers', requireRole('owner', 'admin'), (req, res) => {
  if (!req.body?.chatId) return res.status(400).json({ error: 'chatId is required.' });
  const subscriber: TelegramSubscriber = {
    id: `subscriber_${String(req.body.chatId)}`,
    chatId: String(req.body.chatId),
    displayName: String(req.body.displayName ?? 'Telegram subscriber'),
    isActive: req.body.isActive !== false,
    isSubscribed: req.body.isSubscribed !== false,
    marketingConsent: req.body.marketingConsent === true,
    segmentIds: Array.isArray(req.body.segmentIds) ? req.body.segmentIds.map(String) : ['all-consented'],
    language: ['km', 'en', 'both'].includes(req.body.language) ? req.body.language : 'both',
    unsubscribedAt: req.body.unsubscribedAt,
    createdAt: new Date().toISOString(),
  };
  agentStore.mutate((draft) => {
    draft.telegramSubscribers = draft.telegramSubscribers.filter((item) => item.chatId !== subscriber.chatId);
    draft.telegramSubscribers.unshift(subscriber);
  });
  res.status(201).json(subscriber);
});

agentRouter.post('/admin/heartbeat/run', requireRole('owner', 'admin', 'operator'), async (req, res) => {
  try {
    res.json(await runHeartbeat(actorFrom(req)));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

agentRouter.patch('/admin/heartbeat', requireRole('owner', 'admin'), (req, res) => {
  const heartbeat = agentStore.mutate((draft) => {
    if (typeof req.body?.enabled === 'boolean') draft.heartbeat.enabled = req.body.enabled;
    if (Number.isFinite(Number(req.body?.intervalMinutes))) draft.heartbeat.intervalMinutes = Math.max(1, Number(req.body.intervalMinutes));
    if (req.body?.checks && typeof req.body.checks === 'object') {
      draft.heartbeat.checks = { ...draft.heartbeat.checks, ...req.body.checks };
    }
    return structuredClone(draft.heartbeat);
  });
  configureHeartbeat();
  res.json(heartbeat);
});

agentRouter.post('/admin/boosts/recalculate', requireRole('owner', 'admin', 'operator'), (_req, res) => res.json(calculateProductBoosts()));
agentRouter.post('/admin/boosts/:id/request-approval', requireRole('owner', 'admin', 'operator'), (req, res) => {
  try {
    res.status(201).json(createBoostApproval(req.params.id, actorFrom(req)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
agentRouter.post('/admin/boosts/:id/pause', requireRole('owner', 'admin', 'operator'), (req, res) => {
  const boost = agentStore.mutate((draft) => {
    const target = draft.boosts.find((item) => item.id === req.params.id);
    if (!target) throw new Error('Boost not found.');
    target.status = 'paused';
    target.updatedAt = new Date().toISOString();
    return structuredClone(target);
  });
  res.json(boost);
});

agentRouter.post('/admin/phase2/pricing', requireRole('owner', 'admin', 'operator'), (_req, res) => res.json(calculateDynamicPricing()));
agentRouter.post('/admin/phase2/segments', requireRole('owner', 'admin', 'operator'), (_req, res) => res.json(calculateCustomerSegments()));
agentRouter.post('/admin/phase2/inventory-forecast', requireRole('owner', 'admin', 'operator'), (_req, res) => res.json(calculateInventoryForecasts()));
agentRouter.post('/admin/phase2/revenue-opportunities', requireRole('owner', 'admin', 'operator'), (_req, res) => res.json(calculateRevenueOpportunities()));

agentRouter.post('/admin/reset-agent-system', requireRole('owner'), (_req, res) => {
  res.json(agentStore.reset());
});
