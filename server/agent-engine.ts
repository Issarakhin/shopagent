import crypto from 'crypto';
import { agentStore } from './store.js';
import {
  availableToPromise,
  paidLikeOrders,
  productSalesMap,
  readBudget,
  readOrders,
  readProducts,
  readReservations,
  writeBudget,
  writeProducts,
  writeReservations,
} from './business-data.js';
import { draftCampaignContent, planWithOpenAI } from './openai-service.js';
import {
  calculateCustomerSegments,
  calculateDynamicPricing,
  calculateInventoryForecasts,
  calculateProductBoosts,
  calculateRevenueOpportunities,
  learnFromCampaign,
} from './phase2-service.js';
import type {
  ApprovalRequest,
  Campaign,
  MainAgentPlan,
  SkillId,
  SkillResult,
  Workflow,
  WorkflowStep,
} from './types.js';

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function success(skill: SkillId, action: string, summary: string, data: Record<string, unknown> = {}, warnings: string[] = []): SkillResult {
  return { success: true, skill, action, summary, data, warnings, requiresApproval: false };
}

function fail(skill: SkillId, action: string, code: string, message: string): SkillResult {
  return { success: false, skill, action, summary: message, requiresApproval: false, error: { code, message } };
}

function getDependencyOutputs(workflow: Workflow, step: WorkflowStep): Record<string, unknown> {
  // Collect outputs transitively across all ancestor steps, not just the direct
  // dependsOn parents. This lets a downstream step (e.g. publish) read an output
  // produced further upstream (e.g. the campaign draft) even when the plan wires
  // the steps in a longer chain.
  const outputs: Record<string, unknown> = {};
  const visited = new Set<string>();
  const stack = [...step.dependsOn];
  while (stack.length) {
    const dependencyId = stack.pop();
    if (!dependencyId || visited.has(dependencyId)) continue;
    visited.add(dependencyId);
    const dep = workflow.steps.find((item) => item.id === dependencyId);
    if (!dep) continue;
    if (dep.output) outputs[dependencyId] = dep.output;
    stack.push(...dep.dependsOn);
  }
  return outputs;
}

// Resolve the campaign a step should act on: prefer one referenced by dependency
// outputs/input, otherwise fall back to the campaign created within this workflow.
function resolveWorkflowCampaignId(
  workflow: Workflow,
  input: Record<string, unknown>,
  dependencies: Record<string, unknown>,
): string | undefined {
  return findCampaignId(input, dependencies)
    ?? agentStore.getState().campaigns.find((campaign) => campaign.workflowId === workflow.id)?.id;
}

function findProductIds(input: Record<string, unknown>, dependencyOutputs: Record<string, unknown>): string[] {
  if (Array.isArray(input.productIds)) return input.productIds.filter((item): item is string => typeof item === 'string');
  for (const output of Object.values(dependencyOutputs)) {
    if (!output || typeof output !== 'object') continue;
    const data = output as Record<string, unknown>;
    if (Array.isArray(data.productIds)) return data.productIds.filter((item): item is string => typeof item === 'string');
    if (Array.isArray(data.rankedProducts)) {
      return data.rankedProducts
        .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>).productId : undefined))
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 3);
    }
  }
  return [];
}

function calculateWorkflowProgress(workflow: Workflow): number {
  if (!workflow.steps.length) return 0;
  const completed = workflow.steps.filter((step) => step.status === 'completed').length;
  return Math.round((completed / workflow.steps.length) * 100);
}

function normalizeWorkflowStatus(workflow: Workflow): void {
  workflow.progress = calculateWorkflowProgress(workflow);
  if (workflow.steps.some((step) => step.status === 'failed')) workflow.status = 'failed';
  else if (workflow.steps.some((step) => step.status === 'waiting_approval')) workflow.status = 'waiting_approval';
  else if (workflow.steps.every((step) => step.status === 'completed')) {
    workflow.status = 'completed';
    workflow.completedAt = now();
  } else if (workflow.steps.some((step) => step.status === 'running')) workflow.status = 'running';
  else if (workflow.steps.some((step) => step.status === 'blocked')) workflow.status = 'blocked';
  else workflow.status = 'pending';
}

function createApproval(workflow: Workflow, step: WorkflowStep, options: {
  summary: string;
  expectedEffect: string;
  estimatedCost?: number;
  recipientCount?: number;
  dataAffected?: string[];
  rollbackPossible?: boolean;
  resourceId?: string;
  resourceVersion?: number;
}): ApprovalRequest {
  const existing = agentStore.getState().approvals.find((approval) => approval.workflowId === workflow.id && approval.stepId === step.id && approval.status === 'pending');
  if (existing) return existing;
  const approval: ApprovalRequest = {
    id: id('approval'),
    workflowId: workflow.id,
    stepId: step.id,
    skill: step.skill,
    action: step.action,
    riskLevel: 'high',
    status: 'pending',
    summary: options.summary,
    expectedEffect: options.expectedEffect,
    estimatedCost: options.estimatedCost,
    recipientCount: options.recipientCount,
    dataAffected: options.dataAffected ?? [],
    rollbackPossible: options.rollbackPossible ?? false,
    requestedAt: now(),
    expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
    resourceId: options.resourceId,
    resourceVersion: options.resourceVersion,
  };
  agentStore.mutate((draft) => {
    draft.approvals.unshift(approval);
  });
  step.approvalId = approval.id;
  return approval;
}

async function executeSkill(workflow: Workflow, step: WorkflowStep): Promise<SkillResult> {
  agentStore.assertSkillEnabled(step.skill, step.action);
  const state = agentStore.getState();
  if (state.controls.automationPaused) return fail(step.skill, step.action, 'AUTOMATION_PAUSED', 'Automation is paused by an administrator.');
  const dependencies = getDependencyOutputs(workflow, step);
  const input: Record<string, unknown> = { ...step.input, dependencyOutputs: dependencies };

  switch (`${step.skill}:${step.action}`) {
    case 'business-planning:create_workflow':
      return success(step.skill, step.action, 'Workflow structure has already been created.', { workflowId: workflow.id });

    case 'business-planning:prioritize_decisions': {
      const approvals = state.approvals.filter((item) => item.status === 'pending').sort((a, b) => {
        const risk = { high: 2, medium: 1 };
        return risk[b.riskLevel] - risk[a.riskLevel] || new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime();
      });
      return success(step.skill, step.action, `Prioritized ${approvals.length} pending approval requests.`, { approvals });
    }

    case 'business-planning:generate_daily_summary':
    case 'business-planning:generate_weekly_review': {
      const products = readProducts();
      const orders = readOrders();
      const days = step.action === 'generate_weekly_review' ? 7 : 1;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const recentOrders = orders.filter((order) => new Date(order.createdAt).getTime() >= cutoff);
      const revenue = recentOrders.filter((order) => order.status !== 'cancelled').reduce((sum, order) => sum + order.totalAmount, 0);
      const lowStock = products.filter((product) => availableToPromise(product) <= 5);
      return success(step.skill, step.action, `${days === 1 ? 'Daily' : 'Weekly'} summary generated from live business data.`, {
        periodDays: days,
        orderCount: recentOrders.length,
        revenue: Number(revenue.toFixed(2)),
        lowStockCount: lowStock.length,
        pendingApprovals: state.approvals.filter((item) => item.status === 'pending').length,
        activeCampaigns: state.campaigns.filter((item) => ['approved', 'publishing', 'published'].includes(item.status)).length,
      });
    }

    case 'analytics:generate_sales_summary': {
      const orders = paidLikeOrders();
      const revenue = orders.reduce((sum, order) => sum + order.totalAmount, 0);
      return success(step.skill, step.action, 'Sales summary calculated from paid-like order states.', { orderCount: orders.length, revenue: Number(revenue.toFixed(2)) });
    }

    case 'analytics:rank_products': {
      const products = readProducts();
      const boosts = calculateProductBoosts();
      const rankedProducts = boosts.slice(0, 5).map((boost) => ({
        ...boost,
        productName: products.find((product) => product.id === boost.productId)?.name ?? boost.productId,
      }));
      return success(step.skill, step.action, `Ranked ${rankedProducts.length} products by smart boost opportunity.`, {
        rankedProducts,
        productIds: rankedProducts.slice(0, 3).map((item) => item.productId),
      });
    }

    case 'analytics:detect_anomaly': {
      const products = readProducts();
      const anomalies = products.filter((product) => product.stock < 0 || product.price <= 0).map((product) => ({ productId: product.id, issue: product.stock < 0 ? 'negative_stock' : 'invalid_price' }));
      return success(step.skill, step.action, anomalies.length ? `Detected ${anomalies.length} anomalies.` : 'No critical product anomalies detected.', { anomalies });
    }

    case 'analytics:measure_campaign_performance':
    case 'marketing:measure_campaign_result': {
      const campaignId = resolveWorkflowCampaignId(workflow, input, dependencies);
      const campaign = state.campaigns.find((item) => item.id === campaignId) ?? state.campaigns[0];
      if (!campaign) return fail(step.skill, step.action, 'CAMPAIGN_NOT_FOUND', 'No campaign is available to measure.');
      const attempted = campaign.sentCount + campaign.failedCount + campaign.skippedCount;
      return success(step.skill, step.action, 'Campaign delivery performance calculated.', {
        campaignId: campaign.id,
        attempted,
        sent: campaign.sentCount,
        failed: campaign.failedCount,
        skipped: campaign.skippedCount,
        deliveryRate: attempted ? Number((campaign.sentCount / attempted).toFixed(3)) : 0,
      });
    }

    case 'analytics:learn_from_outcomes': {
      const campaignId = resolveWorkflowCampaignId(workflow, input, dependencies);
      if (!campaignId) return fail(step.skill, step.action, 'CAMPAIGN_NOT_FOUND', 'No campaign result was supplied for learning.');
      learnFromCampaign(campaignId);
      return success(step.skill, step.action, 'Verified campaign outcome was stored in long-term agent memory.', { campaignId });
    }

    case 'inventory:check_available_stock': {
      const products = readProducts();
      const requested = findProductIds(input, dependencies);
      const selected = requested.length ? products.filter((product) => requested.includes(product.id)) : products;
      const stock = selected.map((product) => ({ productId: product.id, name: product.name, onHand: product.stock, availableToPromise: availableToPromise(product), eligible: availableToPromise(product) > 0 }));
      const productIds = stock.filter((item) => item.eligible).map((item) => item.productId);
      return success(step.skill, step.action, `${productIds.length} products are available for the next step.`, { stock, productIds }, stock.some((item) => item.availableToPromise <= 5) ? ['Some products are close to low stock.'] : []);
    }

    case 'inventory:reserve_stock': {
      const productId = String(input.productId ?? '');
      const quantity = Math.max(1, asNumber(input.quantity, 1));
      const product = readProducts().find((item) => item.id === productId);
      if (!product) return fail(step.skill, step.action, 'PRODUCT_NOT_FOUND', 'Product was not found.');
      if (availableToPromise(product) < quantity) return fail(step.skill, step.action, 'INSUFFICIENT_STOCK', 'Not enough available stock.');
      const reservations = readReservations();
      const reservation = { id: id('reservation'), productId, quantity, workflowId: workflow.id, status: 'active' as const, createdAt: now() };
      reservations.push(reservation);
      writeReservations(reservations);
      return success(step.skill, step.action, 'Stock reserved.', { reservation });
    }

    case 'inventory:release_stock': {
      const reservationId = String(input.reservationId ?? '');
      const reservations = readReservations();
      const reservation = reservations.find((item) => item.id === reservationId);
      if (!reservation) return fail(step.skill, step.action, 'RESERVATION_NOT_FOUND', 'Reservation was not found.');
      reservation.status = 'released';
      reservation.releasedAt = now();
      writeReservations(reservations);
      return success(step.skill, step.action, 'Stock reservation released.', { reservationId });
    }

    case 'inventory:predict_inventory': {
      if (!state.controls.predictiveInventoryEnabled) return fail(step.skill, step.action, 'FEATURE_DISABLED', 'Predictive inventory is disabled.');
      const forecasts = calculateInventoryForecasts();
      return success(step.skill, step.action, 'Predictive inventory forecast generated.', { forecasts });
    }

    case 'inventory:recommend_reorder': {
      const forecasts = state.inventoryForecasts.length ? state.inventoryForecasts : calculateInventoryForecasts();
      const recommendations = forecasts.filter((item) => item.recommendedReorderQuantity > 0 || (item.daysOfCover !== null && item.daysOfCover <= 10));
      return success(step.skill, step.action, `Generated ${recommendations.length} reorder recommendations.`, { recommendations });
    }

    case 'finance:calculate_paid_revenue': {
      const orders = paidLikeOrders();
      const revenue = orders.reduce((sum, order) => sum + order.totalAmount, 0);
      return success(step.skill, step.action, 'Paid-like revenue calculated.', { orderCount: orders.length, paidRevenue: Number(revenue.toFixed(2)) });
    }

    case 'finance:calculate_margin': {
      const products = readProducts();
      const sales = productSalesMap(30);
      const margins = products.map((product) => {
        const revenue = sales.get(product.id)?.revenue ?? 0;
        const estimatedCost = revenue * 0.6;
        return { productId: product.id, revenue: Number(revenue.toFixed(2)), estimatedGrossMargin: Number((revenue - estimatedCost).toFixed(2)), note: 'Estimated using a 60% cost ratio until historical COGS is stored.' };
      });
      return success(step.skill, step.action, 'Estimated margin analysis generated.', { margins }, ['Historical cost snapshots are not yet available.']);
    }

    case 'finance:check_campaign_budget': {
      const requestedAmount = Math.max(0, asNumber(input.requestedAmount, 25));
      const budget = readBudget();
      const available = Math.max(0, budget.monthlyLimit - budget.reserved - budget.spent);
      if (requestedAmount > available) return fail(step.skill, step.action, 'BUDGET_UNAVAILABLE', `Requested $${requestedAmount.toFixed(2)} exceeds the available $${available.toFixed(2)}.`);
      return success(step.skill, step.action, 'Campaign budget is available.', { requestedAmount, available, currency: budget.currency });
    }

    case 'finance:reserve_budget': {
      const amount = Math.max(0, asNumber(input.amount, 0));
      const budget = readBudget();
      const available = budget.monthlyLimit - budget.reserved - budget.spent;
      if (!amount || amount > available) return fail(step.skill, step.action, 'BUDGET_UNAVAILABLE', 'Budget cannot be reserved.');
      budget.reserved += amount;
      budget.updatedAt = now();
      writeBudget(budget);
      return success(step.skill, step.action, 'Budget reserved.', { amount, budget });
    }

    case 'finance:recommend_dynamic_pricing': {
      if (!state.controls.dynamicPricingEnabled) return fail(step.skill, step.action, 'FEATURE_DISABLED', 'Dynamic pricing is disabled.');
      const recommendations = calculateDynamicPricing();
      return success(step.skill, step.action, 'Dynamic pricing recommendations generated without changing prices.', { recommendations });
    }

    case 'finance:apply_approved_price': {
      const recommendationId = String(input.recommendationId ?? findRecommendationId(dependencies) ?? '');
      const current = agentStore.getState();
      const recommendation = current.pricingRecommendations.find((item) => item.id === recommendationId && item.status === 'approved');
      if (!recommendation) return fail(step.skill, step.action, 'APPROVED_RECOMMENDATION_REQUIRED', 'An approved pricing recommendation is required.');
      const products = readProducts();
      const product = products.find((item) => item.id === recommendation.productId);
      if (!product) return fail(step.skill, step.action, 'PRODUCT_NOT_FOUND', 'Product was not found.');
      const previousPrice = product.price;
      product.price = recommendation.recommendedPrice;
      writeProducts(products);
      agentStore.mutate((draft) => {
        const value = draft.pricingRecommendations.find((item) => item.id === recommendation.id);
        if (value) value.status = 'applied';
      });
      return success(step.skill, step.action, 'Approved price change applied.', { productId: product.id, previousPrice, newPrice: product.price });
    }

    case 'finance:optimize_revenue': {
      if (!state.controls.revenueOptimizationEnabled) return fail(step.skill, step.action, 'FEATURE_DISABLED', 'Revenue optimization is disabled.');
      const opportunities = calculateRevenueOpportunities();
      return success(step.skill, step.action, `Generated ${opportunities.length} revenue opportunities.`, { opportunities });
    }

    case 'sales:identify_real_leads': {
      const orders = readOrders().filter((order) => order.status !== 'cancelled');
      const map = new Map<string, { email: string; name: string; orders: number; revenue: number; lastOrderAt: string }>();
      for (const order of orders) {
        const key = order.customerEmail.toLowerCase();
        const current = map.get(key) ?? { email: key, name: order.customerName, orders: 0, revenue: 0, lastOrderAt: order.createdAt };
        current.orders += 1;
        current.revenue += order.totalAmount;
        if (new Date(order.createdAt).getTime() > new Date(current.lastOrderAt).getTime()) current.lastOrderAt = order.createdAt;
        map.set(key, current);
      }
      const leads = [...map.values()].sort((a, b) => b.revenue - a.revenue);
      return success(step.skill, step.action, `Identified ${leads.length} real leads from existing order data.`, { leads });
    }

    case 'sales:segment_customers': {
      if (!state.controls.segmentationEnabled) return fail(step.skill, step.action, 'FEATURE_DISABLED', 'Customer segmentation is disabled.');
      const segments = calculateCustomerSegments();
      return success(step.skill, step.action, `Created ${segments.length} customer segments from real order history.`, { segments });
    }

    case 'sales:create_offer_draft':
      return success(step.skill, step.action, 'Offer draft prepared. No customer was contacted.', { draft: { subject: 'Shopping Cambodia offer', body: 'A reviewable offer draft based on verified products and availability.' } });

    case 'sales:update_pipeline':
      return success(step.skill, step.action, 'Pipeline update recorded.', { stage: input.stage ?? 'engaged' });

    case 'sales:prepare_follow_up':
      return success(step.skill, step.action, 'Consent-aware follow-up draft prepared.', { message: 'Thank you for shopping with Shopping Cambodia. Reply only if you would like product updates.' });

    case 'support:categorize_ticket':
      return success(step.skill, step.action, 'Support request categorized.', { category: input.orderId ? 'order_help' : 'general', priority: 'normal' });

    case 'support:draft_reply':
      return success(step.skill, step.action, 'Support reply drafted without sending.', { reply: 'We are reviewing your request using the verified order information available to the support team.' });

    case 'support:escalate_ticket':
      return success(step.skill, step.action, 'Support escalation recorded.', { escalationId: id('support_escalation') });

    case 'support:prepare_refund_request':
      return success(step.skill, step.action, 'Refund request prepared for human review. No money was moved.', { refundRequestId: id('refund_request') });

    case 'logistics:validate_fulfillment': {
      const orderId = String(input.orderId ?? '');
      const order = readOrders().find((item) => item.id === orderId);
      if (!order) return fail(step.skill, step.action, 'ORDER_NOT_FOUND', 'Order was not found.');
      const products = readProducts();
      const lines = order.items.map((item) => {
        const product = products.find((value) => value.id === item.productId);
        return { productId: item.productId, requested: item.quantity, available: product ? availableToPromise(product) : 0, ready: !!product && availableToPromise(product) >= item.quantity };
      });
      const ready = ['processing', 'shipped', 'delivered'].includes(order.status) && lines.every((line) => line.ready) && !!order.customerAddress;
      return success(step.skill, step.action, ready ? 'Order is ready for fulfillment planning.' : 'Order is not ready for fulfillment.', { ready, lines, orderStatus: order.status });
    }

    case 'logistics:create_shipment':
      return success(step.skill, step.action, 'Shipment plan created. Carrier booking is not connected yet.', { shipmentId: id('shipment'), status: 'ready_for_carrier_booking' }, ['External carrier integration is not configured.']);

    case 'logistics:check_delivery_delay': {
      const cutoff = Date.now() - 5 * 24 * 60 * 60 * 1000;
      const delayed = readOrders().filter((order) => ['processing', 'shipped'].includes(order.status) && new Date(order.createdAt).getTime() < cutoff);
      return success(step.skill, step.action, `Found ${delayed.length} potentially delayed orders.`, { delayed });
    }

    case 'logistics:report_delivery_exception':
      return success(step.skill, step.action, 'Delivery exception recorded.', { exceptionId: id('delivery_exception') });

    case 'marketing:prepare_telegram_message':
      return success(step.skill, step.action, 'Telegram message draft prepared without sending.', { messageEn: 'Reviewable Shopping Cambodia campaign message.', messageKh: 'សារផ្សព្វផ្សាយ Shopping Cambodia សម្រាប់ពិនិត្យ។' });

    case 'marketing:validate_campaign': {
      const campaignId = resolveWorkflowCampaignId(workflow, input, dependencies);
      const campaign = agentStore.getState().campaigns.find((item) => item.id === campaignId);
      if (!campaign) return fail(step.skill, step.action, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
      const products = readProducts().filter((product) => campaign.productIds.includes(product.id));
      const errors: string[] = [];
      if (!products.length) errors.push('No valid products selected.');
      if (products.some((product) => availableToPromise(product) <= 0)) errors.push('At least one product has no available stock.');
      if (!campaign.telegramMessageEn && !campaign.telegramMessageKh) errors.push('Telegram content is empty.');
      if (errors.length) return fail(step.skill, step.action, 'CAMPAIGN_INVALID', errors.join(' '));
      return success(step.skill, step.action, 'Campaign validation passed.', { campaignId, valid: true });
    }

    case 'marketing:create_campaign_draft': {
      const products = readProducts();
      const productIds = findProductIds(input, dependencies).slice(0, 3);
      const selected = productIds.length ? products.filter((product) => productIds.includes(product.id)) : products.filter((product) => product.status === 'active' && availableToPromise(product) > 0).slice(0, 3);
      if (!selected.length) return fail(step.skill, step.action, 'NO_ELIGIBLE_PRODUCTS', 'No eligible products are available for a campaign.');
      const requestedBudget = findBudget(input, dependencies);
      const content = await draftCampaignContent({ productNames: selected.map((product) => product.name), audience: 'consented Telegram subscribers', budget: requestedBudget });
      const subscribers = agentStore.getState().telegramSubscribers;
      const segments = Array.isArray(input.segmentIds) ? input.segmentIds.filter((item): item is string => typeof item === 'string') : ['all-consented'];
      const eligibleCount = subscribers.filter((subscriber) => isSubscriberEligible(subscriber, segments)).length;
      const campaign: Campaign = {
        id: id('campaign'),
        name: `Smart boost: ${selected.map((product) => product.name).join(', ')}`,
        status: 'awaiting_review',
        version: 1,
        productIds: selected.map((product) => product.id),
        segmentIds: segments,
        telegramMessageKh: content.kh,
        telegramMessageEn: content.en,
        estimatedRecipientCount: eligibleCount,
        budget: requestedBudget,
        createdAt: now(),
        updatedAt: now(),
        workflowId: workflow.id,
        sentCount: 0,
        failedCount: 0,
        skippedCount: 0,
        duplicatePreventedCount: 0,
      };
      agentStore.mutate((draft) => {
        draft.campaigns.unshift(campaign);
      });
      workflow.relatedRecords.push(campaign.id);
      return success(step.skill, step.action, 'Campaign draft created. No Telegram messages were sent.', { campaignId: campaign.id, campaignVersion: campaign.version, campaign, contentSource: content.source });
    }

    case 'marketing:publish_approved_campaign': {
      const campaignId = resolveWorkflowCampaignId(workflow, input, dependencies);
      if (!campaignId) return fail(step.skill, step.action, 'CAMPAIGN_NOT_FOUND', 'A campaign draft is required.');
      const campaign = agentStore.getState().campaigns.find((item) => item.id === campaignId);
      if (!campaign) return fail(step.skill, step.action, 'CAMPAIGN_NOT_FOUND', 'Campaign was not found.');
      const approval = step.approvalId ? agentStore.findApproval(step.approvalId) : undefined;
      if (!approval || approval.status !== 'approved') return fail(step.skill, step.action, 'FINAL_APPROVAL_REQUIRED', 'Final publish approval is required.');
      if (approval.resourceId !== campaign.id || approval.resourceVersion !== campaign.version) return fail(step.skill, step.action, 'APPROVAL_VERSION_MISMATCH', 'Approval does not match the current campaign version.');
      const result = await publishTelegramCampaign(campaign, approval.id);
      return result;
    }

    case 'marketing:activate_product_boost': {
      const boostId = String(input.boostId ?? '');
      const boost = agentStore.getState().boosts.find((item) => item.id === boostId);
      if (!boost) return fail(step.skill, step.action, 'BOOST_NOT_FOUND', 'Product boost was not found.');
      boost.status = 'active';
      boost.updatedAt = now();
      boost.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      agentStore.mutate((draft) => {
        const target = draft.boosts.find((item) => item.id === boost.id);
        if (target) Object.assign(target, boost);
      });
      return success(step.skill, step.action, 'Approved product boost is now active in the storefront.', { boost });
    }

    default:
      return fail(step.skill, step.action, 'ACTION_NOT_IMPLEMENTED', 'This action is not implemented.');
  }
}

function findBudget(input: Record<string, unknown>, dependencies: Record<string, unknown>): number {
  if (Number.isFinite(Number(input.budget))) return Math.max(0, Number(input.budget));
  if (Number.isFinite(Number(input.requestedAmount))) return Math.max(0, Number(input.requestedAmount));
  for (const output of Object.values(dependencies)) {
    if (!output || typeof output !== 'object') continue;
    const value = output as Record<string, unknown>;
    if (Number.isFinite(Number(value.requestedAmount))) return Math.max(0, Number(value.requestedAmount));
  }
  return 25;
}

function findCampaignId(input: Record<string, unknown>, dependencies: Record<string, unknown>): string | undefined {
  if (typeof input.campaignId === 'string') return input.campaignId;
  for (const output of Object.values(dependencies)) {
    if (!output || typeof output !== 'object') continue;
    const value = output as Record<string, unknown>;
    if (typeof value.campaignId === 'string') return value.campaignId;
    if (value.campaign && typeof value.campaign === 'object' && typeof (value.campaign as Record<string, unknown>).id === 'string') return (value.campaign as Record<string, unknown>).id as string;
  }
  return undefined;
}

function findRecommendationId(dependencies: Record<string, unknown>): string | undefined {
  for (const output of Object.values(dependencies)) {
    if (!output || typeof output !== 'object') continue;
    const value = output as Record<string, unknown>;
    if (Array.isArray(value.recommendations)) {
      const first = value.recommendations.find((item) => item && typeof item === 'object' && Number((item as Record<string, unknown>).changePercent) !== 0) as Record<string, unknown> | undefined;
      if (first && typeof first.id === 'string') return first.id;
    }
  }
  return undefined;
}

function isSubscriberEligible(subscriber: import('./types.js').TelegramSubscriber, segmentIds: string[]): boolean {
  const segmentMatch = segmentIds.includes('all-consented') || segmentIds.some((segment) => subscriber.segmentIds.includes(segment));
  const frequencyAllowed = !subscriber.lastMarketingMessageAt || Date.now() - new Date(subscriber.lastMarketingMessageAt).getTime() >= 24 * 60 * 60 * 1000;
  return subscriber.isActive && subscriber.isSubscribed && subscriber.marketingConsent && !subscriber.unsubscribedAt && segmentMatch && frequencyAllowed;
}

async function sendTelegram(chatId: string, text: string): Promise<{ messageId: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  if (process.env.TELEGRAM_LIVE_SEND !== 'true') throw new Error('TELEGRAM_LIVE_SEND must be true for real Telegram publishing.');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const payload = await response.json() as any;
  if (!response.ok || !payload.ok) throw new Error(payload?.description ?? `Telegram send failed (${response.status}).`);
  return { messageId: String(payload.result.message_id) };
}

async function publishTelegramCampaign(campaign: Campaign, approvalId: string): Promise<SkillResult> {
  if (!['approved', 'awaiting_review'].includes(campaign.status)) return fail('marketing', 'publish_approved_campaign', 'INVALID_CAMPAIGN_STATE', `Campaign cannot publish from ${campaign.status}.`);
  const state = agentStore.getState();
  const subscribers = state.telegramSubscribers;
  const eligible = subscribers.filter((subscriber) => isSubscriberEligible(subscriber, campaign.segmentIds));
  agentStore.mutate((draft) => {
    const target = draft.campaigns.find((item) => item.id === campaign.id);
    if (target) {
      target.status = 'publishing';
      target.approvalId = approvalId;
      target.updatedAt = now();
    }
  });

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let duplicatePrevented = 0;
  for (const subscriber of subscribers) {
    const idempotencyKey = `campaign:${campaign.id}:telegram:${subscriber.chatId}`;
    const existing = agentStore.getState().campaignRecipients.find((item) => item.idempotencyKey === idempotencyKey && item.status === 'sent');
    if (existing) {
      duplicatePrevented += 1;
      agentStore.mutate((draft) => {
        if (!draft.campaignRecipients.some((item) => item.idempotencyKey === idempotencyKey && item.status === 'duplicate_prevented')) {
          draft.campaignRecipients.push({ id: id('recipient'), campaignId: campaign.id, telegramChatId: subscriber.chatId, status: 'duplicate_prevented', retryCount: 0, idempotencyKey });
        }
      });
      continue;
    }
    if (!eligible.some((item) => item.id === subscriber.id)) {
      skipped += 1;
      agentStore.mutate((draft) => {
        draft.campaignRecipients.push({ id: id('recipient'), campaignId: campaign.id, telegramChatId: subscriber.chatId, status: subscriber.unsubscribedAt ? 'unsubscribed' : 'skipped', retryCount: 0, idempotencyKey });
      });
      continue;
    }

    const recipientId = id('recipient');
    agentStore.mutate((draft) => {
      draft.campaignRecipients.push({ id: recipientId, campaignId: campaign.id, telegramChatId: subscriber.chatId, status: 'sending', retryCount: 0, idempotencyKey });
    });
    try {
      const message = subscriber.language === 'km' ? campaign.telegramMessageKh : subscriber.language === 'en' ? campaign.telegramMessageEn : `${campaign.telegramMessageKh}\n\n${campaign.telegramMessageEn}`;
      const result = await sendTelegram(subscriber.chatId, message);
      sent += 1;
      agentStore.mutate((draft) => {
        const recipient = draft.campaignRecipients.find((item) => item.id === recipientId);
        if (recipient) Object.assign(recipient, { status: 'sent', telegramMessageId: result.messageId, sentAt: now() });
        const targetSubscriber = draft.telegramSubscribers.find((item) => item.id === subscriber.id);
        if (targetSubscriber) targetSubscriber.lastMarketingMessageAt = now();
      });
    } catch (error) {
      failed += 1;
      agentStore.mutate((draft) => {
        const recipient = draft.campaignRecipients.find((item) => item.id === recipientId);
        if (recipient) Object.assign(recipient, { status: 'failed', error: error instanceof Error ? error.message : String(error), retryCount: 1 });
      });
    }
  }

  const finalStatus = sent > 0 && failed === 0 ? 'published' : sent > 0 ? 'partially_published' : 'failed';
  agentStore.mutate((draft) => {
    const target = draft.campaigns.find((item) => item.id === campaign.id);
    if (target) {
      target.status = finalStatus;
      target.sentCount = sent;
      target.failedCount = failed;
      target.skippedCount = skipped;
      target.duplicatePreventedCount = duplicatePrevented;
      target.updatedAt = now();
      if (sent > 0) target.publishedAt = now();
    }
  });
  if (sent === 0) return fail('marketing', 'publish_approved_campaign', 'TELEGRAM_PUBLISH_FAILED', failed ? 'Telegram publishing failed for every eligible recipient.' : 'No eligible Telegram recipients were available.');
  return success('marketing', 'publish_approved_campaign', `Telegram campaign sent to ${sent} recipients.`, { campaignId: campaign.id, sent, failed, skipped, duplicatePrevented, status: finalStatus }, failed ? ['Some recipient sends failed.'] : []);
}

export async function createWorkflowFromCommand(command: string, actor: string): Promise<{ workflow: Workflow; plan: MainAgentPlan; source: string }> {
  const state = agentStore.getState();
  if (!state.controls.brainEnabled) throw Object.assign(new Error('Main Agent brain is disabled.'), { code: 'BRAIN_DISABLED' });
  const context = {
    products: readProducts().map((product) => ({ id: product.id, name: product.name, stock: product.stock, price: product.price, status: product.status })),
    orderCount: readOrders().length,
    pendingApprovalCount: state.approvals.filter((item) => item.status === 'pending').length,
    enabledSkills: state.skills.filter((skill) => skill.enabled).map((skill) => ({ id: skill.id, enabledActions: skill.actions.filter((action) => action.enabled).map((action) => action.id) })),
  };
  const { plan, source } = await planWithOpenAI(command, context);
  if (!plan.requiresWorkflow || !plan.workflow) throw new Error(plan.clarificationQuestion ?? 'The Main Agent did not produce an executable workflow.');

  const workflowId = id('workflow');
  const workflow: Workflow = {
    id: workflowId,
    name: plan.workflow.name,
    goal: plan.workflow.goal,
    status: 'pending',
    progress: 0,
    riskLevel: plan.workflow.riskLevel,
    createdBy: actor,
    createdAt: now(),
    relatedRecords: [],
    steps: plan.workflow.steps.map((item) => ({
      ...item,
      workflowId,
      status: 'pending',
      attempt: 0,
      idempotencyKey: `${workflowId}:${item.skill}:${item.action}:${item.id}`,
    })),
  };
  agentStore.mutate((draft) => {
    draft.workflows.unshift(workflow);
  });
  agentStore.addAudit({ actor, actorRole: 'admin', action: 'workflow_created', workflowId, inputSummary: command, resultSummary: plan.summary, riskLevel: workflow.riskLevel, success: true });
  await runWorkflow(workflowId, actor);
  return { workflow: agentStore.getState().workflows.find((item) => item.id === workflowId)!, plan, source };
}

export async function runWorkflow(workflowId: string, actor = 'system'): Promise<Workflow> {
  let workflow = agentStore.getState().workflows.find((item) => item.id === workflowId);
  if (!workflow) throw new Error('Workflow not found.');
  if (['completed', 'cancelled'].includes(workflow.status)) return workflow;

  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    workflow = agentStore.getState().workflows.find((item) => item.id === workflowId)!;
    for (const stepSnapshot of workflow.steps) {
      if (stepSnapshot.status !== 'pending') continue;
      const dependencies = stepSnapshot.dependsOn.map((depId) => workflow!.steps.find((item) => item.id === depId));
      if (dependencies.some((dependency) => dependency?.status === 'failed' || dependency?.status === 'cancelled')) {
        agentStore.mutate((draft) => {
          const wf = draft.workflows.find((item) => item.id === workflowId)!;
          const step = wf.steps.find((item) => item.id === stepSnapshot.id)!;
          step.status = 'blocked';
          step.error = { code: 'DEPENDENCY_FAILED', message: 'A required workflow dependency failed.' };
          normalizeWorkflowStatus(wf);
        });
        madeProgress = true;
        continue;
      }
      if (!dependencies.every((dependency) => dependency?.status === 'completed')) continue;

      const executionExists = agentStore.getState().executions.some((execution) => execution.idempotencyKey === stepSnapshot.idempotencyKey && execution.status === 'completed');
      if (executionExists) {
        agentStore.mutate((draft) => {
          const wf = draft.workflows.find((item) => item.id === workflowId)!;
          const step = wf.steps.find((item) => item.id === stepSnapshot.id)!;
          step.status = 'completed';
          normalizeWorkflowStatus(wf);
        });
        madeProgress = true;
        continue;
      }

      if (stepSnapshot.requiresApproval) {
        const dependencyOutputs = getDependencyOutputs(workflow, stepSnapshot);
        const campaignId = findCampaignId(stepSnapshot.input, dependencyOutputs);
        const recommendationId = findRecommendationId(dependencyOutputs);
        agentStore.mutate((draft) => {
          const wf = draft.workflows.find((item) => item.id === workflowId)!;
          const step = wf.steps.find((item) => item.id === stepSnapshot.id)!;
          let options: Parameters<typeof createApproval>[2] = {
            summary: `${step.skill}: ${step.action}`,
            expectedEffect: 'Execute a controlled high-risk business action.',
            dataAffected: [],
            rollbackPossible: false,
          };
          if (campaignId) {
            const campaign = draft.campaigns.find((item) => item.id === campaignId);
            options = {
              summary: `Publish Telegram campaign: ${campaign?.name ?? campaignId}`,
              expectedEffect: 'Send the reviewed campaign once to eligible, consented Telegram subscribers.',
              estimatedCost: campaign?.budget,
              recipientCount: campaign?.estimatedRecipientCount,
              dataAffected: ['campaign', 'campaignRecipients', 'telegramSubscribers'],
              rollbackPossible: false,
              resourceId: campaign?.id,
              resourceVersion: campaign?.version,
            };
          } else if (recommendationId) {
            const recommendation = draft.pricingRecommendations.find((item) => item.id === recommendationId);
            options = {
              summary: `Apply price recommendation for ${recommendation?.productId ?? recommendationId}`,
              expectedEffect: `Change the product price to $${recommendation?.recommendedPrice}.`,
              dataAffected: ['products', 'pricingRecommendations'],
              rollbackPossible: true,
              resourceId: recommendation?.id,
            };
          }
          const approval = createApproval(wf, step, options);
          step.approvalId = approval.id;
          step.status = 'waiting_approval';
          normalizeWorkflowStatus(wf);
        });
        madeProgress = true;
        break;
      }

      await executeWorkflowStep(workflowId, stepSnapshot.id, actor);
      madeProgress = true;
      break;
    }
  }
  return agentStore.getState().workflows.find((item) => item.id === workflowId)!;
}

async function executeWorkflowStep(workflowId: string, stepId: string, actor: string): Promise<void> {
  const snapshot = agentStore.getState();
  const workflow = snapshot.workflows.find((item) => item.id === workflowId)!;
  const step = workflow.steps.find((item) => item.id === stepId)!;
  const executionId = id('execution');
  agentStore.mutate((draft) => {
    const wf = draft.workflows.find((item) => item.id === workflowId)!;
    const target = wf.steps.find((item) => item.id === stepId)!;
    target.status = 'running';
    target.startedAt = now();
    target.attempt += 1;
    wf.status = 'running';
    draft.executions.unshift({
      id: executionId,
      workflowId,
      stepId,
      skill: step.skill,
      action: step.action,
      input: step.input,
      status: 'running',
      attempt: target.attempt,
      idempotencyKey: target.idempotencyKey,
      startedAt: now(),
    });
  });

  let result: SkillResult;
  try {
    const fresh = agentStore.getState().workflows.find((item) => item.id === workflowId)!;
    const freshStep = fresh.steps.find((item) => item.id === stepId)!;
    result = await executeSkill(fresh, freshStep);
  } catch (error) {
    result = fail(step.skill, step.action, (error as any)?.code ?? 'EXECUTION_FAILED', error instanceof Error ? error.message : String(error));
  }

  agentStore.mutate((draft) => {
    const wf = draft.workflows.find((item) => item.id === workflowId)!;
    const target = wf.steps.find((item) => item.id === stepId)!;
    const execution = draft.executions.find((item) => item.id === executionId)!;
    target.completedAt = now();
    execution.completedAt = now();
    if (result.success) {
      target.status = 'completed';
      target.output = result.data ?? { summary: result.summary };
      execution.status = 'completed';
      execution.output = target.output;
    } else {
      target.status = 'failed';
      target.error = result.error;
      execution.status = 'failed';
      execution.error = result.error;
    }
    normalizeWorkflowStatus(wf);
  });
  agentStore.recordSkillResult(step.skill, result.success);
  agentStore.addAudit({
    actor,
    actorRole: actor === 'system' ? 'system' : 'admin',
    action: step.action,
    skill: step.skill,
    workflowId,
    inputSummary: JSON.stringify(step.input).slice(0, 500),
    resultSummary: result.summary,
    riskLevel: snapshot.skills.find((item) => item.id === step.skill)?.actions.find((item) => item.id === step.action)?.riskLevel,
    success: result.success,
    error: result.error,
  });
}

export async function decideApproval(approvalId: string, status: 'approved' | 'rejected' | 'changes_requested', actor: string, note = ''): Promise<ApprovalRequest> {
  const approval = agentStore.findApproval(approvalId);
  if (!approval) throw new Error('Approval not found.');
  if (approval.status !== 'pending') throw new Error('Approval has already been decided.');
  if (new Date(approval.expiresAt).getTime() <= Date.now()) throw new Error('Approval has expired.');

  agentStore.mutate((draft) => {
    const target = draft.approvals.find((item) => item.id === approvalId)!;
    target.status = status;
    target.decidedAt = now();
    target.decidedBy = actor;
    target.decisionNote = note;
    const workflow = draft.workflows.find((item) => item.id === target.workflowId);
    const step = workflow?.steps.find((item) => item.id === target.stepId);
    if (step) {
      if (status === 'approved') {
        step.status = 'pending';
        step.requiresApproval = false;
        if (target.action === 'publish_approved_campaign' && target.resourceId) {
          const campaign = draft.campaigns.find((item) => item.id === target.resourceId);
          if (campaign && campaign.version === target.resourceVersion) {
            campaign.status = 'approved';
            campaign.approvalId = target.id;
            campaign.updatedAt = now();
          }
        }
        if (target.action === 'apply_approved_price' && target.resourceId) {
          const recommendation = draft.pricingRecommendations.find((item) => item.id === target.resourceId);
          if (recommendation) {
            recommendation.status = 'approved';
            recommendation.approvalId = target.id;
            step.input = { ...step.input, recommendationId: recommendation.id };
          }
        }
      } else {
        step.status = status === 'rejected' ? 'cancelled' : 'blocked';
        step.error = { code: status === 'rejected' ? 'APPROVAL_REJECTED' : 'CHANGES_REQUESTED', message: note || status.replace('_', ' ') };
        if (target.resourceId) {
          const campaign = draft.campaigns.find((item) => item.id === target.resourceId);
          if (campaign) campaign.status = status === 'rejected' ? 'rejected' : 'awaiting_review';
        }
      }
    }
    if (workflow) normalizeWorkflowStatus(workflow);
  });
  agentStore.addAudit({ actor, actorRole: 'reviewer', action: `approval_${status}`, workflowId: approval.workflowId, approvalId, businessRecordId: approval.resourceId, resultSummary: note || status, riskLevel: approval.riskLevel, success: true });
  if (status === 'approved') await runWorkflow(approval.workflowId, actor);
  return agentStore.findApproval(approvalId)!;
}

export function createBoostApproval(boostId: string, actor: string): ApprovalRequest {
  const boost = agentStore.getState().boosts.find((item) => item.id === boostId);
  if (!boost) throw new Error('Boost not found.');
  const workflowId = id('workflow');
  const stepId = 'step_1';
  const workflow: Workflow = {
    id: workflowId,
    name: 'Activate smart product boost',
    goal: `Activate boost for ${boost.productId}`,
    status: 'waiting_approval',
    progress: 0,
    riskLevel: 'medium',
    createdBy: actor,
    createdAt: now(),
    relatedRecords: [boost.id, boost.productId],
    steps: [{ id: stepId, workflowId, skill: 'marketing', action: 'activate_product_boost', dependsOn: [], requiresApproval: true, status: 'waiting_approval', input: { boostId }, attempt: 0, idempotencyKey: `${workflowId}:marketing:activate_product_boost:${boostId}` }],
  };
  let approval!: ApprovalRequest;
  agentStore.mutate((draft) => {
    draft.workflows.unshift(workflow);
    const wf = draft.workflows.find((item) => item.id === workflowId)!;
    const step = wf.steps[0];
    approval = createApproval(wf, step, {
      summary: `Activate smart storefront boost for ${boost.productId}`,
      expectedEffect: 'Prioritize this product in featured storefront ordering for seven days.',
      dataAffected: ['boosts', 'storefront ordering'],
      rollbackPossible: true,
      resourceId: boost.id,
    });
    const target = draft.boosts.find((item) => item.id === boost.id)!;
    target.status = 'pending_approval';
    target.approvalId = approval.id;
  });
  return approval;
}

export function updateCampaignDraft(campaignId: string, patch: Partial<Pick<Campaign, 'name' | 'telegramMessageKh' | 'telegramMessageEn' | 'segmentIds' | 'budget' | 'scheduledAt'>>): Campaign {
  return agentStore.mutate((draft) => {
    const campaign = draft.campaigns.find((item) => item.id === campaignId);
    if (!campaign) throw new Error('Campaign not found.');
    if (!['draft', 'awaiting_review', 'rejected'].includes(campaign.status)) throw new Error('Only reviewable campaigns may be edited.');
    Object.assign(campaign, patch);
    campaign.version += 1;
    campaign.status = 'awaiting_review';
    campaign.approvalId = undefined;
    campaign.updatedAt = now();
    for (const approval of draft.approvals.filter((item) => item.resourceId === campaign.id && item.status === 'pending')) approval.status = 'expired';
    return structuredClone(campaign);
  });
}

export function retryFailedCampaignRecipients(campaignId: string): Campaign {
  const campaign = agentStore.getState().campaigns.find((item) => item.id === campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  if (!['partially_published', 'failed'].includes(campaign.status)) throw new Error('Only failed or partially published campaigns can be retried.');
  // A retry is intentionally not automatic: create a new version and require approval.
  return updateCampaignDraft(campaignId, {});
}
