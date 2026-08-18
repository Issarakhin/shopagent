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
  writeOrders,
  writeProducts,
  writeReservations,
} from './business-data.js';
import { draftCampaignContent, planWithOpenAI } from './openai-service.js';
import { resolveCampaignProductSelection } from './product-selection.js';
import { runCambodiaMarketIntelligence } from './market-intelligence/daily-market-task.js';
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

function stableHash(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    }
    return input;
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function actionDefinition(skill: SkillId, action: string) {
  return agentStore.getState().skills.find((item) => item.id === skill)?.actions.find((item) => item.id === action);
}

function approvedStepApproval(workflow: Workflow, step: WorkflowStep): ApprovalRequest | undefined {
  if (!step.approvalId) return undefined;
  const approval = agentStore.findApproval(step.approvalId);
  if (!approval || approval.status !== 'approved') return undefined;
  if (approval.workflowId !== workflow.id || approval.stepId !== step.id) return undefined;
  if (approval.payloadHash !== stableHash(step.input)) return undefined;
  return approval;
}

function protectedActionInputError(step: WorkflowStep): string | undefined {
  const value = step.input;
  switch (step.action) {
    case 'publish_approved_campaign':
      return typeof value.campaignId === 'string' && value.campaignId ? undefined : 'A campaign draft is required before publish approval.';
    case 'apply_approved_price':
      return typeof value.recommendationId === 'string' && value.recommendationId ? undefined : 'An exact pricing recommendation is required before approval.';
    case 'adjust_inventory':
      if (typeof value.productId !== 'string' || !value.productId) return 'An exact productId is required before inventory approval.';
      if (!Number.isFinite(Number(value.adjustment)) && !Number.isFinite(Number(value.setTo))) return 'Provide an exact numeric adjustment or setTo value before inventory approval.';
      return undefined;
    case 'reserve_stock':
      if (typeof value.productId !== 'string' || !value.productId) return 'An exact productId is required before stock reservation approval.';
      if (!Number.isFinite(Number(value.quantity)) || Number(value.quantity) <= 0) return 'A positive quantity is required before stock reservation approval.';
      return undefined;
    case 'release_stock':
      return typeof value.reservationId === 'string' && value.reservationId ? undefined : 'An exact reservationId is required before release approval.';
    case 'issue_approved_refund':
      if (typeof value.orderId !== 'string' || !value.orderId) return 'An exact orderId is required before refund approval.';
      if (!Number.isFinite(Number(value.amount)) || Number(value.amount) <= 0) return 'A positive exact refund amount is required before approval.';
      return undefined;
    case 'change_order_status':
      if (typeof value.orderId !== 'string' || !value.orderId) return 'An exact orderId is required before status-change approval.';
      if (!['processing', 'shipped', 'delivered', 'cancelled'].includes(String(value.status))) return 'A valid exact target status is required before approval.';
      return undefined;
    case 'reserve_budget':
      return Number.isFinite(Number(value.amount)) && Number(value.amount) > 0 ? undefined : 'A positive exact budget amount is required before approval.';
    case 'activate_product_boost':
      return typeof value.boostId === 'string' && value.boostId ? undefined : 'An exact boostId is required before approval.';
    case 'create_shipment':
      return typeof value.orderId === 'string' && value.orderId ? undefined : 'An exact orderId is required before shipment approval.';
    default:
      return undefined;
  }
}

function success(skill: SkillId, action: string, summary: string, data: Record<string, unknown> = {}, warnings: string[] = []): SkillResult {
  return { success: true, skill, action, summary, data, warnings, requiresApproval: false };
}

function fail(skill: SkillId, action: string, code: string, message: string): SkillResult {
  return { success: false, skill, action, summary: message, requiresApproval: false, error: { code, message } };
}

function getDependencyOutputs(workflow: Workflow, step: WorkflowStep): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  const visited = new Set<string>();
  const collect = (dependencyId: string) => {
    if (visited.has(dependencyId)) return;
    visited.add(dependencyId);
    const dependency = workflow.steps.find((item) => item.id === dependencyId);
    if (!dependency) return;
    if (dependency.output) outputs[dependencyId] = dependency.output;
    for (const ancestorId of dependency.dependsOn) collect(ancestorId);
  };
  for (const dependencyId of step.dependsOn) collect(dependencyId);
  return outputs;
}

function findProductIds(input: Record<string, unknown>, dependencyOutputs: Record<string, unknown>): string[] {
  if (Array.isArray(input.productIds)) {
    const direct = input.productIds.filter((item): item is string => typeof item === 'string');
    if (direct.length) return direct;
  }
  for (const output of Object.values(dependencyOutputs)) {
    if (!output || typeof output !== 'object') continue;
    const data = output as Record<string, unknown>;
    if (Array.isArray(data.productIds)) {
      const selected = data.productIds.filter((item): item is string => typeof item === 'string');
      if (selected.length) return selected;
    }
    if (Array.isArray(data.rankedProducts)) {
      const selected = data.rankedProducts
        .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>).productId : undefined))
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 3);
      if (selected.length) return selected;
    }
  }
  return [];
}

function findProductSelection(dependencyOutputs: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const output of Object.values(dependencyOutputs)) {
    if (!output || typeof output !== 'object') continue;
    const data = output as Record<string, unknown>;
    if (data.productSelection && typeof data.productSelection === 'object') {
      return data.productSelection as Record<string, unknown>;
    }
  }
  return undefined;
}

function findMarketRecommendation(dependencyOutputs: Record<string, unknown>, productId?: string): Record<string, unknown> | undefined {
  for (const output of Object.values(dependencyOutputs)) {
    if (!output || typeof output !== 'object') continue;
    const data = output as Record<string, unknown>;
    if (!Array.isArray(data.recommendations)) continue;
    const recommendations = data.recommendations.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
    const match = productId ? recommendations.find((item) => item.productId === productId) : recommendations[0];
    if (match) return match;
  }
  return undefined;
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
  riskLevel?: 'medium' | 'high';
}): ApprovalRequest {
  const payloadHash = stableHash(step.input);
  const existing = agentStore.getState().approvals.find((approval) =>
    approval.workflowId === workflow.id
    && approval.stepId === step.id
    && approval.status === 'pending'
    && approval.payloadHash === payloadHash,
  );
  if (existing) return existing;
  const definition = actionDefinition(step.skill, step.action);
  const approval: ApprovalRequest = {
    id: id('approval'),
    workflowId: workflow.id,
    stepId: step.id,
    skill: step.skill,
    action: step.action,
    riskLevel: options.riskLevel ?? (definition?.riskLevel === 'medium' ? 'medium' : 'high'),
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
    payloadHash,
  };
  agentStore.mutate((draft) => {
    draft.approvals.unshift(approval);
  });
  step.approvalId = approval.id;
  return approval;
}


async function executeSkill(workflow: Workflow, step: WorkflowStep): Promise<SkillResult> {
  agentStore.assertSkillEnabled(step.skill, step.action);
  const definition = actionDefinition(step.skill, step.action);
  if (definition?.approvalRequired && !approvedStepApproval(workflow, step)) {
    return fail(step.skill, step.action, 'EXACT_APPROVAL_REQUIRED', 'This action requires a valid human approval for the exact current input.');
  }
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
      const preferredProductIds = Array.isArray(input.preferredProductIds)
        ? input.preferredProductIds.filter((item): item is string => typeof item === 'string')
        : [];
      const selectionRequest = String(input.userRequest ?? input.selectionRequest ?? workflow.goal ?? 'Choose the strongest product to boost.');
      const maxProducts = Number.isFinite(Number(input.maxProducts)) ? Math.max(1, Math.min(5, Number(input.maxProducts))) : undefined;
      const productSelection = resolveCampaignProductSelection({
        request: selectionRequest,
        products: products.map((product) => ({ ...product, stock: availableToPromise(product) })),
        sales30d: productSalesMap(30),
        events: state.events,
        preferredProductIds,
        boostScores: new Map(boosts.map((boost) => [boost.productId, boost.score])),
        maxProducts,
      });
      if (!productSelection.selectedProductIds.length) {
        return fail(step.skill, step.action, 'NO_MATCHING_PRODUCTS', 'No active in-stock product matched the requested campaign selection logic.');
      }
      return success(step.skill, step.action, `Selected ${productSelection.rankedProducts.map((item) => item.productName).join(', ')} using ${productSelection.strategyLabel.toLowerCase()}.`, {
        rankedProducts: productSelection.rankedProducts,
        productIds: productSelection.selectedProductIds,
        selectionStrategy: productSelection.strategy,
        selectionReason: productSelection.rankedProducts[0]?.selectionReason,
        selectionCriteria: productSelection.criteriaSummary,
        selectionConfidence: productSelection.confidence,
        productSelection,
      }, productSelection.noDiscountAssumed ? ['Clearance selection does not create or imply a discount. Any price change requires a separate approved pricing action.'] : []);
    }


    case 'analytics:discover_market_opportunities': {
      if (!state.controls.marketIntelligenceEnabled) return fail(step.skill, step.action, 'FEATURE_DISABLED', 'Cambodia market intelligence is disabled.');
      const result = await runCambodiaMarketIntelligence({
        actor: workflow.createdBy || 'system',
        force: Boolean(input.force ?? true),
        request: String(input.requestText ?? input.userRequest ?? workflow.goal ?? 'Find current Cambodia market opportunities.'),
      });
      const recommendations = result.recommendations ?? [];
      const top = recommendations[0];
      return success(step.skill, step.action, recommendations.length
        ? `Found ${recommendations.length} Cambodia market opportunities. Top recommendation: ${top.productName}.`
        : 'Cambodia market scan completed but no catalogue-matched boost opportunity met the scoring threshold.', {
        market: 'Cambodia',
        run: result.run,
        trends: result.trends ?? [],
        recommendations,
        productIds: recommendations.map((item) => item.productId),
        rankedProducts: recommendations.map((item) => ({
          productId: item.productId,
          productName: item.productName,
          selectionScore: item.score,
          selectionReason: item.selectionReason,
        })),
        productSelection: top ? {
          strategy: 'cambodia_market_trend',
          strategyLabel: 'Cambodia market trend opportunity',
          request: String(input.requestText ?? input.userRequest ?? workflow.goal ?? ''),
          scope: 'Cambodia market and current catalogue',
          criteriaSummary: 'Match current Cambodia web/media trend evidence with real product stock and internal buyer-demand signals.',
          selectedProductIds: recommendations.map((item) => item.productId),
          rankedProducts: recommendations.map((item) => ({ productId: item.productId, productName: item.productName, selectionScore: item.score, selectionReason: item.selectionReason })),
          confidence: top.confidence,
          noDiscountAssumed: true,
        } : undefined,
      }, ['Trend recommendations are evidence-based suggestions only. Publishing, price changes, and boost activation still require their normal approval paths.']);
    }

    case 'analytics:detect_anomaly': {
      const products = readProducts();
      const anomalies = products.filter((product) => product.stock < 0 || product.price <= 0).map((product) => ({ productId: product.id, issue: product.stock < 0 ? 'negative_stock' : 'invalid_price' }));
      return success(step.skill, step.action, anomalies.length ? `Detected ${anomalies.length} anomalies.` : 'No critical product anomalies detected.', { anomalies });
    }

    case 'analytics:measure_campaign_performance':
    case 'marketing:measure_campaign_result': {
      const campaignId = findCampaignId(input, dependencies);
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
      const campaignId = findCampaignId(input, dependencies);
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


    case 'inventory:adjust_inventory': {
      const productId = String(input.productId ?? '');
      const products = readProducts();
      const product = products.find((item) => item.id === productId);
      if (!product) return fail(step.skill, step.action, 'PRODUCT_NOT_FOUND', 'An exact productId is required for inventory adjustment.');
      const previousStock = product.stock;
      const hasSetTo = input.setTo !== undefined && Number.isFinite(Number(input.setTo));
      const hasAdjustment = input.adjustment !== undefined && Number.isFinite(Number(input.adjustment));
      if (!hasSetTo && !hasAdjustment) return fail(step.skill, step.action, 'INVALID_INVENTORY_CHANGE', 'Provide either setTo or adjustment as a number.');
      const nextStock = hasSetTo ? Math.trunc(Number(input.setTo)) : previousStock + Math.trunc(Number(input.adjustment));
      if (nextStock < 0) return fail(step.skill, step.action, 'NEGATIVE_STOCK_NOT_ALLOWED', 'Inventory cannot be adjusted below zero.');
      product.stock = nextStock;
      writeProducts(products);
      return success(step.skill, step.action, 'Approved inventory adjustment applied.', {
        productId,
        previousStock,
        newStock: nextStock,
        reason: String(input.reason ?? 'Approved inventory correction'),
      });
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

    case 'support:prepare_refund_request': {
      const orderId = typeof input.orderId === 'string' ? input.orderId : '';
      const amount = Number.isFinite(Number(input.amount)) ? Number(input.amount) : undefined;
      const order = orderId ? readOrders().find((item) => item.id === orderId) : undefined;
      if (orderId && !order) return fail(step.skill, step.action, 'ORDER_NOT_FOUND', 'The supplied order was not found.');
      if (amount !== undefined && amount <= 0) return fail(step.skill, step.action, 'INVALID_REFUND_AMOUNT', 'Refund amount must be greater than zero.');
      if (order && amount !== undefined && amount > order.totalAmount) return fail(step.skill, step.action, 'REFUND_EXCEEDS_ORDER', 'Refund amount cannot exceed the order total.');
      return success(step.skill, step.action, 'Refund request prepared for human review. No money was moved.', {
        refundRequestId: id('refund_request'),
        orderId: order?.id ?? (orderId || undefined),
        amount,
        currency: 'USD',
        reason: String(input.reason ?? input.requestText ?? 'Refund requested by admin'),
      }, !orderId || amount === undefined ? ['Order ID and exact amount are still required before a refund can be issued.'] : []);
    }

    case 'support:issue_approved_refund': {
      const dependencyRefund = Object.values(dependencies).find((value) => value && typeof value === 'object' && ('refundRequestId' in (value as Record<string, unknown>))) as Record<string, unknown> | undefined;
      const orderId = String(input.orderId ?? dependencyRefund?.orderId ?? '');
      const amount = asNumber(input.amount ?? dependencyRefund?.amount, 0);
      const reason = String(input.reason ?? dependencyRefund?.reason ?? 'Approved customer refund');
      const order = readOrders().find((item) => item.id === orderId);
      if (!order) return fail(step.skill, step.action, 'ORDER_NOT_FOUND', 'An exact valid orderId is required to issue a refund.');
      if (amount <= 0 || amount > order.totalAmount) return fail(step.skill, step.action, 'INVALID_REFUND_AMOUNT', 'Refund amount must be greater than zero and no more than the order total.');
      try {
        const result = await issuePaymentRefund({ orderId, amount, reason, customerEmail: order.customerEmail });
        return success(step.skill, step.action, 'Payment provider confirmed the approved refund request.', { orderId, amount, reason, providerRefundId: result.refundId, providerStatus: result.status });
      } catch (error) {
        return fail(step.skill, step.action, 'REFUND_PROVIDER_FAILED', error instanceof Error ? error.message : String(error));
      }
    }

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


    case 'logistics:change_order_status': {
      const orderId = String(input.orderId ?? '');
      const targetStatus = String(input.status ?? '');
      const orders = readOrders();
      const order = orders.find((item) => item.id === orderId);
      if (!order) return fail(step.skill, step.action, 'ORDER_NOT_FOUND', 'An exact valid orderId is required.');
      const transitions: Record<string, string[]> = {
        pending: ['processing', 'cancelled'],
        processing: ['shipped', 'cancelled'],
        shipped: ['delivered'],
        delivered: [],
        cancelled: [],
      };
      if (!transitions[order.status]?.includes(targetStatus)) {
        return fail(step.skill, step.action, 'INVALID_ORDER_TRANSITION', `Order cannot move from ${order.status} to ${targetStatus}.`);
      }
      const previousStatus = order.status;
      order.status = targetStatus as typeof order.status;
      writeOrders(orders);
      return success(step.skill, step.action, 'Approved order status change applied.', { orderId, previousStatus, newStatus: order.status, reason: String(input.reason ?? 'Approved order workflow update') });
    }

    case 'marketing:prepare_telegram_message':
      return success(step.skill, step.action, 'Telegram message draft prepared without sending.', { messageEn: 'Reviewable Shopping Cambodia campaign message.', messageKh: 'សារផ្សព្វផ្សាយ Shopping Cambodia សម្រាប់ពិនិត្យ។' });

    case 'marketing:validate_campaign': {
      const campaignId = findCampaignId(input, dependencies);
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
      const selected = productIds.length
        ? products.filter((product) => productIds.includes(product.id))
        : products.filter((product) => product.status === 'active' && availableToPromise(product) > 0).slice(0, 3);
      if (!selected.length) return fail(step.skill, step.action, 'NO_ELIGIBLE_PRODUCTS', 'No eligible products are available for a campaign.');
      if (selected.some((product) => availableToPromise(product) <= 0)) return fail(step.skill, step.action, 'OUT_OF_STOCK_PRODUCT', 'Campaign drafts cannot include products with no available stock.');

      const requestedBudget = findBudget(input, dependencies);
      const productSelection = findProductSelection(dependencies);
      const marketRecommendation = findMarketRecommendation(dependencies, selected[0]?.id);
      const selectionStrategy = String(productSelection?.strategy ?? input.selectionStrategy ?? (productIds.length ? 'specific_product' : 'smart_boost'));
      const selectionReason = String(productSelection?.rankedProducts && Array.isArray(productSelection.rankedProducts)
        ? ((productSelection.rankedProducts[0] as Record<string, unknown> | undefined)?.selectionReason ?? '')
        : input.selectionReason ?? 'Selected from current product data.');
      const selectionCriteria = String(productSelection?.criteriaSummary ?? input.selectionCriteria ?? 'Use current product, stock, sales, and engagement signals.');
      const selectionConfidence = asNumber(productSelection?.confidence ?? input.selectionConfidence, productIds.length ? 0.99 : 0.75);
      const currentState = agentStore.getState();
      const selectedIds = new Set(selected.map((product) => product.id));
      const recentCampaigns = currentState.campaigns
        .filter((campaign) => campaign.productIds.some((productId) => selectedIds.has(productId)))
        .slice(0, 12)
        .map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
          creativeAngle: campaign.creativeAngle ?? 'unknown',
          callToAction: campaign.callToAction ?? '',
          telegramMessageEn: campaign.telegramMessageEn,
          telegramMessageKh: campaign.telegramMessageKh,
          contentFingerprint: campaign.contentFingerprint,
          campaignPurpose: campaign.campaignPurpose,
          tone: campaign.tone,
          contentStyle: campaign.contentStyle,
          contentShape: campaign.contentShape,
        }));
      const verifiedMemory = currentState.memories
        .filter((memory) => memory.confidence >= 0.5 && (memory.type === 'outcome' || memory.type === 'learning'))
        .slice(0, 12)
        .map((memory) => ({ topic: memory.topic, content: memory.content, confidence: memory.confidence }));
      const userRequest = String(input.userRequest ?? input.campaignGoal ?? workflow.goal ?? `Promote ${selected.map((product) => product.name).join(', ')}`);
      const campaignGoal = String(input.campaignGoal ?? userRequest);
      const requestedAudience = typeof input.targetAudience === 'string' && input.targetAudience.trim()
        ? input.targetAudience.trim()
        : 'consented Telegram subscribers in the selected segments';
      const content = await draftCampaignContent({
        products: selected.map((product) => ({
          id: product.id,
          name: product.name,
          description: product.description,
          category: product.category,
          price: product.price,
          stock: availableToPromise(product),
          unit: product.unit,
        })),
        audience: requestedAudience,
        budget: requestedBudget,
        campaignGoal,
        userRequest,
        productSelection: {
          strategy: selectionStrategy,
          reason: selectionReason,
          criteria: selectionCriteria,
          confidence: selectionConfidence,
          marketTrendTitle: typeof marketRecommendation?.trendTitle === 'string' ? marketRecommendation.trendTitle : undefined,
          marketTrendSummary: typeof marketRecommendation?.trendSummary === 'string' ? marketRecommendation.trendSummary : undefined,
          consumerNeed: typeof marketRecommendation?.consumerNeed === 'string' ? marketRecommendation.consumerNeed : undefined,
          recommendedCampaignAngle: typeof marketRecommendation?.recommendedCampaignAngle === 'string' ? marketRecommendation.recommendedCampaignAngle : undefined,
          evidenceUrls: Array.isArray(marketRecommendation?.evidence) ? marketRecommendation.evidence.flatMap((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).url === 'string' ? [String((item as Record<string, unknown>).url)] : []).slice(0, 5) : undefined,
        },
        recentCampaigns,
        verifiedMemory,
      });
      const subscribers = currentState.telegramSubscribers;
      const segments = Array.isArray(input.segmentIds) ? input.segmentIds.filter((item): item is string => typeof item === 'string') : ['all-consented'];
      const eligibleCount = subscribers.filter((subscriber) => isSubscriberEligible(subscriber, segments)).length;
      const campaign: Campaign = {
        id: id('campaign'),
        name: content.campaignName,
        status: 'awaiting_review',
        version: 1,
        productIds: selected.map((product) => product.id),
        segmentIds: segments,
        telegramMessageKh: content.kh,
        telegramMessageEn: content.en,
        objective: content.objective,
        userRequest: content.userIntent,
        selectionStrategy,
        selectionReason,
        selectionCriteria,
        selectionConfidence,
        campaignPurpose: content.campaignPurpose,
        targetAudience: content.targetAudience,
        tone: content.tone,
        contentStyle: content.contentStyle,
        contentShape: content.contentShape,
        desiredReaction: content.desiredReaction,
        creativeAngle: content.creativeAngle,
        creativeRationale: content.creativeRationale,
        callToAction: content.callToAction,
        productFactsUsed: content.productFactsUsed,
        userLogicMatch: content.userLogicMatch,
        variationNotes: content.variationNotes,
        similarityScore: content.similarityScore,
        contentFingerprint: content.contentFingerprint,
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
      return success(step.skill, step.action, 'A product-specific campaign draft was created and compared with recent campaigns. No Telegram messages were sent.', {
        campaignId: campaign.id,
        campaignVersion: campaign.version,
        campaign,
        contentSource: content.source,
        creativeAngle: content.creativeAngle,
        campaignPurpose: content.campaignPurpose,
        tone: content.tone,
        contentStyle: content.contentStyle,
        contentShape: content.contentShape,
        userLogicMatch: content.userLogicMatch,
        similarityScore: content.similarityScore,
      }, content.similarityScore > 0.62 ? ['The draft has moderate similarity to a recent campaign and should be reviewed carefully.'] : []);
    }


    case 'marketing:publish_approved_campaign': {
      const campaignId = findCampaignId(input, dependencies);
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
  // A subscriber in the broad "all-consented" pool is part of the general
  // marketing audience and is reachable by any campaign, even when the campaign
  // targets a specific named segment. Otherwise a campaign matches only when it
  // explicitly targets all-consented or shares a named segment with the subscriber.
  const segmentMatch =
    subscriber.segmentIds.includes('all-consented')
    || segmentIds.includes('all-consented')
    || segmentIds.some((segment) => subscriber.segmentIds.includes(segment));
  // Minimum hours between marketing messages to the same person. Defaults to 24h
  // so we never spam customers, but is configurable (set TELEGRAM_MIN_RESEND_HOURS=0
  // to disable the cap, e.g. while testing).
  const minResendHours = Number(process.env.TELEGRAM_MIN_RESEND_HOURS ?? 24);
  const frequencyAllowed = minResendHours <= 0
    || !subscriber.lastMarketingMessageAt
    || Date.now() - new Date(subscriber.lastMarketingMessageAt).getTime() >= minResendHours * 60 * 60 * 1000;
  return subscriber.isActive && subscriber.isSubscribed && subscriber.marketingConsent && !subscriber.unsubscribedAt && segmentMatch && frequencyAllowed;
}

async function issuePaymentRefund(input: { orderId: string; amount: number; reason: string; customerEmail: string }): Promise<{ refundId: string; status: string }> {
  const endpoint = process.env.PAYMENT_REFUND_ENDPOINT;
  const token = process.env.PAYMENT_REFUND_TOKEN;
  if (!endpoint || !token) throw new Error('Payment refund provider is not configured. Set PAYMENT_REFUND_ENDPOINT and PAYMENT_REFUND_TOKEN.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `refund:${input.orderId}:${input.amount.toFixed(2)}`,
    },
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Refund provider returned ${response.status}.`);
  const refundId = String(payload.refundId ?? payload.id ?? '');
  if (!refundId) throw new Error('Refund provider did not return a refund identifier.');
  return { refundId, status: String(payload.status ?? 'confirmed') };
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
  const sentChatIds: string[] = [];
  const skippedChatIds: string[] = [];
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
      skippedChatIds.push(subscriber.chatId);
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
      sentChatIds.push(subscriber.chatId);
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
  if (sent === 0) {
    const reason = failed
      ? 'Telegram publishing failed for every eligible recipient.'
      : skipped
        ? `No recipients were eligible right now (${skipped} skipped — usually the marketing frequency cap or missing consent). Set TELEGRAM_MIN_RESEND_HOURS=0 to allow immediate re-sends while testing.`
        : duplicatePrevented
          ? 'Every recipient already received this campaign (duplicate prevention).'
          : 'No Telegram subscribers were available. Confirm subscribers exist and have marketing consent.';
    const skipDetail = skippedChatIds.length ? [`Skipped chat IDs: ${skippedChatIds.join(', ')}.`] : [];
    return fail('marketing', 'publish_approved_campaign', 'TELEGRAM_PUBLISH_FAILED', `${reason}${skipDetail.length ? ' ' + skipDetail[0] : ''}`);
  }
  const warnings = [
    `Sent to chat IDs: ${sentChatIds.join(', ')}.`,
    ...(skippedChatIds.length ? [`Skipped chat IDs: ${skippedChatIds.join(', ')} (frequency cap, consent, or segment).`] : []),
    ...(failed ? ['Some recipient sends failed.'] : []),
  ];
  return success('marketing', 'publish_approved_campaign', `Telegram campaign sent to ${sent} recipients (${skipped} skipped, ${failed} failed, ${duplicatePrevented} duplicate-prevented).`, { campaignId: campaign.id, sent, failed, skipped, duplicatePrevented, status: finalStatus, sentChatIds, skippedChatIds }, warnings);
}

export async function createWorkflowFromCommand(command: string, actor: string): Promise<{ workflow: Workflow | null; plan: MainAgentPlan; source: string }> {
  const state = agentStore.getState();
  if (!state.controls.brainEnabled) throw Object.assign(new Error('Main Agent brain is disabled.'), { code: 'BRAIN_DISABLED' });
  const context = {
    products: readProducts().map((product) => ({
      id: product.id,
      name: product.name,
      description: product.description,
      category: product.category,
      stock: product.stock,
      availableStock: availableToPromise(product),
      price: product.price,
      unit: product.unit,
      status: product.status,
    })),
    orderCount: readOrders().length,
    pendingApprovalCount: state.approvals.filter((item) => item.status === 'pending').length,
    enabledSkills: state.skills.filter((skill) => skill.enabled).map((skill) => ({ id: skill.id, enabledActions: skill.actions.filter((action) => action.enabled).map((action) => action.id) })),
    recentCampaigns: state.campaigns.slice(0, 10).map((campaign) => ({ id: campaign.id, name: campaign.name, productIds: campaign.productIds, creativeAngle: campaign.creativeAngle, callToAction: campaign.callToAction, status: campaign.status })),
    latestCambodiaMarketRecommendations: (state.dailyBoostRecommendations ?? []).slice(0, 5).map((item) => ({ productId: item.productId, productName: item.productName, score: item.score, confidence: item.confidence, trendTitle: item.trendTitle, selectionReason: item.selectionReason })),
    latestCambodiaMarketTrends: (state.marketTrends ?? []).slice(0, 8).map((item) => ({ id: item.id, title: item.title, direction: item.direction, confidence: item.confidence, matchedProductIds: item.matchedProductIds, matchedCategories: item.matchedCategories })),
    approvalPolicy: state.skills.flatMap((skill) => skill.actions.filter((action) => action.approvalRequired).map((action) => ({ skill: skill.id, action: action.id, riskLevel: action.riskLevel }))),
  };
  const { plan, source } = await planWithOpenAI(command, context);
  // A request that needs no multi-step workflow (an answer or a clarifying
  // question) should return the agent's response, not fail with a generic error.
  if (!plan.requiresWorkflow || !plan.workflow) {
    agentStore.addAudit({ actor, actorRole: 'admin', action: 'main_agent_answer', inputSummary: command, resultSummary: plan.clarificationQuestion ?? plan.summary, success: true });
    return { workflow: null, plan, source };
  }

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
    steps: plan.workflow.steps.map((item) => {
      const definition = state.skills.find((skill) => skill.id === item.skill)?.actions.find((action) => action.id === item.action);
      return {
        ...item,
        requiresApproval: Boolean(item.requiresApproval || definition?.approvalRequired),
        workflowId,
        status: 'pending' as const,
        attempt: 0,
        idempotencyKey: `${workflowId}:${item.skill}:${item.action}:${item.id}`,
      };
    }),
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

      const definition = actionDefinition(stepSnapshot.skill, stepSnapshot.action);
      const policyRequiresApproval = Boolean(stepSnapshot.requiresApproval || definition?.approvalRequired);
      const existingApproved = approvedStepApproval(workflow, stepSnapshot);
      if (policyRequiresApproval && !existingApproved) {
        const dependencyOutputs = getDependencyOutputs(workflow, stepSnapshot);
        const campaignId = findCampaignId(stepSnapshot.input, dependencyOutputs);
        const recommendationId = findRecommendationId(dependencyOutputs);
        agentStore.mutate((draft) => {
          const wf = draft.workflows.find((item) => item.id === workflowId)!;
          const step = wf.steps.find((item) => item.id === stepSnapshot.id)!;

          if (campaignId) step.input = { ...step.input, campaignId };
          if (recommendationId) step.input = { ...step.input, recommendationId };
          for (const output of Object.values(dependencyOutputs)) {
            if (!output || typeof output !== 'object') continue;
            const record = output as Record<string, unknown>;
            if (step.action === 'issue_approved_refund') {
              step.input = {
                ...step.input,
                ...(typeof record.orderId === 'string' ? { orderId: record.orderId } : {}),
                ...(Number.isFinite(Number(record.amount)) ? { amount: Number(record.amount) } : {}),
                ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
              };
            }
          }

          const inputError = protectedActionInputError(step);
          if (inputError) {
            step.status = 'failed';
            step.error = { code: 'APPROVAL_INPUT_INCOMPLETE', message: inputError };
            normalizeWorkflowStatus(wf);
            return;
          }

          let options: Parameters<typeof createApproval>[2] = {
            summary: `${step.skill}: ${step.action}`,
            expectedEffect: 'Execute a controlled business mutation using the exact reviewed input.',
            dataAffected: [],
            rollbackPossible: false,
            riskLevel: definition?.riskLevel === 'medium' ? 'medium' : 'high',
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
              riskLevel: 'high',
            };
          } else if (recommendationId) {
            const recommendation = draft.pricingRecommendations.find((item) => item.id === recommendationId);
            options = {
              summary: `Apply price recommendation for ${recommendation?.productId ?? recommendationId}`,
              expectedEffect: `Change the product price to $${recommendation?.recommendedPrice}.`,
              dataAffected: ['products', 'pricingRecommendations'],
              rollbackPossible: true,
              resourceId: recommendation?.id,
              riskLevel: 'high',
            };
          } else if (step.action === 'adjust_inventory') {
            options = {
              summary: `Adjust inventory for ${String(step.input.productId ?? 'selected product')}`,
              expectedEffect: step.input.setTo !== undefined ? `Set stock to ${String(step.input.setTo)}.` : `Change stock by ${String(step.input.adjustment ?? 'the reviewed amount')}.`,
              dataAffected: ['products', 'inventory'],
              rollbackPossible: true,
              resourceId: typeof step.input.productId === 'string' ? step.input.productId : undefined,
              riskLevel: 'high',
            };
          } else if (step.action === 'change_order_status') {
            options = {
              summary: `Change order status for ${String(step.input.orderId ?? 'selected order')}`,
              expectedEffect: `Move the order to ${String(step.input.status ?? 'the reviewed status')}.`,
              dataAffected: ['orders'],
              rollbackPossible: false,
              resourceId: typeof step.input.orderId === 'string' ? step.input.orderId : undefined,
              riskLevel: 'high',
            };
          } else if (step.action === 'issue_approved_refund') {
            options = {
              summary: `Issue refund for ${String(step.input.orderId ?? 'selected order')}`,
              expectedEffect: `Request a $${asNumber(step.input.amount, 0).toFixed(2)} refund from the configured payment provider.`,
              estimatedCost: asNumber(step.input.amount, 0),
              dataAffected: ['payment provider', 'order refund audit'],
              rollbackPossible: false,
              resourceId: typeof step.input.orderId === 'string' ? step.input.orderId : undefined,
              riskLevel: 'high',
            };
          } else if (step.action === 'reserve_stock' || step.action === 'release_stock') {
            options = {
              summary: step.action === 'reserve_stock' ? 'Reserve product stock' : 'Release a stock reservation',
              expectedEffect: 'Change available-to-promise inventory using the reviewed reservation data.',
              dataAffected: ['inventory reservations', 'available stock'],
              rollbackPossible: true,
              resourceId: typeof step.input.productId === 'string' ? step.input.productId : typeof step.input.reservationId === 'string' ? step.input.reservationId : undefined,
              riskLevel: 'medium',
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
  if (actor === 'system' || actor === 'main-agent' || actor.startsWith('agent:')) {
    throw Object.assign(new Error('The AI agent cannot approve its own proposed action.'), { code: 'SELF_APPROVAL_FORBIDDEN' });
  }
  const currentWorkflow = agentStore.getState().workflows.find((item) => item.id === approval.workflowId);
  const currentStep = currentWorkflow?.steps.find((item) => item.id === approval.stepId);
  // Rejecting or requesting changes never executes the action, so a missing step
  // or changed input must not block the reviewer from clearing a stale approval.
  // These integrity guards only matter when we are about to APPROVE and run it.
  if (status === 'approved') {
    if (!currentStep) throw new Error('Approval workflow step was not found.');
    if (approval.payloadHash !== stableHash(currentStep.input)) {
      throw Object.assign(new Error('The action input changed after approval was requested. Request a new approval.'), { code: 'APPROVAL_PAYLOAD_MISMATCH' });
    }
  }
  if (status === 'approved' && approval.resourceVersion !== undefined && approval.resourceId) {
    const campaign = agentStore.getState().campaigns.find((item) => item.id === approval.resourceId);
    if (campaign && campaign.version !== approval.resourceVersion) {
      throw Object.assign(new Error('The campaign changed after approval was requested. Request a new approval for the current version.'), { code: 'APPROVAL_VERSION_MISMATCH' });
    }
  }

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

export function updateCampaignDraft(campaignId: string, patch: Partial<Pick<Campaign, 'name' | 'telegramMessageKh' | 'telegramMessageEn' | 'segmentIds' | 'budget' | 'scheduledAt' | 'objective' | 'campaignPurpose' | 'targetAudience' | 'tone' | 'contentStyle' | 'contentShape' | 'desiredReaction' | 'creativeAngle' | 'creativeRationale' | 'callToAction'>>): Campaign {
  return agentStore.mutate((draft) => {
    const campaign = draft.campaigns.find((item) => item.id === campaignId);
    if (!campaign) throw new Error('Campaign not found.');
    if (!['draft', 'awaiting_review', 'rejected'].includes(campaign.status)) throw new Error('Only reviewable campaigns may be edited.');
    Object.assign(campaign, patch);
    campaign.contentFingerprint = crypto.createHash('sha256').update(`${campaign.telegramMessageKh}
${campaign.telegramMessageEn}`).digest('hex');
    if (patch.telegramMessageKh !== undefined || patch.telegramMessageEn !== undefined) {
      campaign.variationNotes = [...(campaign.variationNotes ?? []), 'Content was manually edited during admin review.'];
    }
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
