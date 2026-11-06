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
import { cambodiaParts, runCambodiaMarketIntelligence } from './market-intelligence/daily-market-task.js';
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
      if (
        !Number.isFinite(Number(value.adjustment)) &&
        !Number.isFinite(Number(value.setTo)) &&
        !Number.isFinite(Number(value.reduceByPercent)) &&
        !Number.isFinite(Number(value.setToPercent))
      ) {
        return 'Provide a numeric adjustment, setTo, reduceByPercent, or setToPercent value before inventory approval.';
      }
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
      // Percentage forms let the agent compute the new amount from the live DB
      // stock itself, so a "reduce by 20%" command needs no hand-fed number.
      const hasReduceByPercent = input.reduceByPercent !== undefined && Number.isFinite(Number(input.reduceByPercent));
      const hasSetToPercent = input.setToPercent !== undefined && Number.isFinite(Number(input.setToPercent));
      if (!hasSetTo && !hasAdjustment && !hasReduceByPercent && !hasSetToPercent) {
        return fail(step.skill, step.action, 'INVALID_INVENTORY_CHANGE', 'Provide setTo, adjustment, reduceByPercent, or setToPercent as a number.');
      }
      let nextStock: number;
      if (hasSetTo) {
        nextStock = Math.trunc(Number(input.setTo));
      } else if (hasAdjustment) {
        nextStock = previousStock + Math.trunc(Number(input.adjustment));
      } else if (hasReduceByPercent) {
        nextStock = Math.round(previousStock * (1 - Number(input.reduceByPercent) / 100));
      } else {
        nextStock = Math.round(previousStock * (Number(input.setToPercent) / 100));
      }
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

    case 'sales:create_offer_draft': {
      const orders = readOrders().filter((order) => order.status !== 'cancelled');
      if (!orders.length) return fail(step.skill, step.action, 'NO_CUSTOMER_DATA', 'No customer order history is available to build a grounded offer.');
      const products = readProducts();
      const history = aggregateCustomerHistory(orders);
      const requestedEmail = typeof input.customerEmail === 'string' ? input.customerEmail.toLowerCase() : '';
      const depLead = Object.values(dependencies).flatMap((value) => (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).leads)) ? (value as Record<string, unknown>).leads as Array<Record<string, unknown>> : [])[0];
      const depEmail = typeof depLead?.email === 'string' ? depLead.email.toLowerCase() : '';
      const targetKey = (requestedEmail && history.has(requestedEmail) && requestedEmail)
        || (depEmail && history.has(depEmail) && depEmail)
        || [...history.values()].sort((a, b) => b.revenue - a.revenue)[0].email;
      const customer = history.get(targetKey)!;
      // Recommend a relevant, in-stock product: first a repeat of something they
      // bought, otherwise a top available product in their favourite category.
      const boughtInStock = customer.productIds
        .map((pid) => products.find((p) => p.id === pid))
        .find((p) => p && availableToPromise(p) > 0);
      const favCategory = customer.topCategory;
      const categoryPick = products.find((p) => p.category === favCategory && availableToPromise(p) > 0 && !customer.productIds.includes(p.id));
      const recommended = boughtInStock ?? categoryPick ?? products.find((p) => availableToPromise(p) > 0);
      const topProducts = customer.productNames.slice(0, 3).join(', ') || 'your past purchases';
      const subject = recommended ? `A ${recommended.name} pick for you, ${customer.name}` : `An offer for you, ${customer.name}`;
      const body = recommended
        ? `Hi ${customer.name}, thank you for your ${customer.orders} order${customer.orders === 1 ? '' : 's'} with Shopping Cambodia (you've enjoyed ${topProducts}). Based on what you buy, you may like ${recommended.name} ($${recommended.price.toFixed(2)}/${recommended.unit}), which is in stock now. Reply if you'd like us to set some aside.`
        : `Hi ${customer.name}, thank you for your ${customer.orders} order${customer.orders === 1 ? '' : 's'} with Shopping Cambodia. We'd love to help you find your next favourite — reply and tell us what you're after.`;
      return success(step.skill, step.action, `Personalized offer draft prepared for ${customer.name}. No customer was contacted.`, {
        draft: {
          customerEmail: customer.email,
          customerName: customer.name,
          subject,
          body,
          recommendedProductId: recommended?.id,
          basedOn: { orders: customer.orders, revenue: Number(customer.revenue.toFixed(2)), topProducts: customer.productNames.slice(0, 3), favouriteCategory: favCategory, lastOrderAt: customer.lastOrderAt },
        },
      });
    }

    case 'sales:update_pipeline':
      return success(step.skill, step.action, 'Pipeline update recorded.', { stage: input.stage ?? 'engaged' });

    case 'sales:prepare_follow_up': {
      const orders = readOrders().filter((order) => order.status !== 'cancelled');
      const history = aggregateCustomerHistory(orders);
      const requestedEmail = typeof input.customerEmail === 'string' ? input.customerEmail.toLowerCase() : '';
      const target = (requestedEmail && history.get(requestedEmail))
        ?? [...history.values()].sort((a, b) => new Date(b.lastOrderAt).getTime() - new Date(a.lastOrderAt).getTime())[0];
      if (!target) return success(step.skill, step.action, 'Consent-aware follow-up draft prepared.', { message: 'Thank you for shopping with Shopping Cambodia. Reply only if you would like product updates.' });
      const lastItems = target.productNames.slice(0, 2).join(' and ') || 'your recent order';
      const message = `Hi ${target.name}, thank you for choosing Shopping Cambodia for ${lastItems}. We hope everything was great. If you'd like occasional updates on products you care about, just reply YES — otherwise no need to do anything.`;
      return success(step.skill, step.action, `Consent-aware follow-up draft prepared for ${target.name}.`, {
        customerEmail: target.email,
        customerName: target.name,
        message,
        basedOn: { lastOrderAt: target.lastOrderAt, recentProducts: target.productNames.slice(0, 2) },
      });
    }

    case 'sales:qualify_customer_lead': {
      const inquiry = String(input.inquiryText ?? input.requestText ?? input.userRequest ?? '').trim();
      if (!inquiry) return fail(step.skill, step.action, 'MISSING_INQUIRY', 'An inquiry text is required to qualify a lead.');
      const products = readProducts();
      const matched = matchProductsToText(inquiry, products);
      const lang = detectLeadLanguage(inquiry);
      // Phnom Penh relevance: CONFIRMED only when the caller passes an explicit
      // confirmedLocation; a Khmer word or hashtag is merely inferred, never proof.
      const confirmed = input.confirmedLocation === true || /phnom\s*penh|ភ្នំពេញ/i.test(String(input.location ?? ''));
      const inferred = /ភ្នំពេញ|phnom\s*penh|#?khmer|កម្ពុជា|cambodia/i.test(inquiry);
      const locationBasis = confirmed
        ? 'Confirmed from an explicit location the lead provided.'
        : inferred
          ? 'Inferred only (Khmer/Cambodia signal in the text) — not confirmed.'
          : 'No location signal.';
      const consent = input.consentToContact === true;
      const qualified = matched.length > 0;
      const lead = {
        id: id('lead'),
        source: (['telegram', 'web_inquiry', 'referral', 'manual', 'social_public'] as const).includes(input.source as any) ? input.source as any : 'manual',
        sourceUrl: typeof input.sourceUrl === 'string' ? input.sourceUrl : undefined,
        inquiryText: inquiry.slice(0, 1000),
        language: lang,
        productInterestIds: matched.map((p) => p.id),
        locationConfirmed: confirmed,
        locationBasis,
        consentToContact: consent,
        qualification: (qualified ? 'qualified' : 'unqualified') as 'qualified' | 'unqualified',
        qualificationReason: qualified
          ? `Matches ${matched.map((p) => p.name).join(', ')} in the live catalogue.${confirmed ? ' Location confirmed in Phnom Penh.' : ''}`
          : 'No in-catalogue product matched this inquiry.',
        contactHandle: typeof input.contactHandle === 'string' ? input.contactHandle : undefined,
        interactions: [{ at: now(), type: 'captured', note: 'Lead captured from a permitted source.' }],
        workflowId: workflow.id,
        createdAt: now(),
        updatedAt: now(),
      };
      agentStore.mutate((draft) => { draft.leads.unshift(lead); });
      return success(step.skill, step.action, `Lead ${lead.qualification} (${matched.length} product match${matched.length === 1 ? '' : 'es'}).`, { lead, matchedProducts: matched.map((p) => ({ id: p.id, name: p.name })) }, confirmed ? [] : ['Phnom Penh location is inferred, not confirmed.']);
    }

    case 'sales:draft_lead_outreach': {
      const leadId = String(input.leadId ?? '');
      const lead = agentStore.getState().leads.find((item) => item.id === leadId) ?? agentStore.getState().leads[0];
      if (!lead) return fail(step.skill, step.action, 'LEAD_NOT_FOUND', 'No lead is available to draft outreach for.');
      if (!lead.consentToContact) return fail(step.skill, step.action, 'NO_CONSENT', 'This lead has not consented to be contacted. Outreach is blocked.');
      const outreachProducts = readProducts().filter((p) => lead.productInterestIds.includes(p.id));
      const productLine = outreachProducts.map((p) => `${p.name} ($${p.price.toFixed(2)}/${p.unit})`).join(', ') || 'the products you asked about';
      const en = `Hello! Thanks for your interest in ${productLine} at Shopping Cambodia. It's available now — reply here if you'd like details or to order. (You can opt out any time.)`;
      const kh = `សួស្តី! អរគុណសម្រាប់ចំណាប់អារម្មណ៍លើ ${productLine} នៅ Shopping Cambodia។ ឆ្លើយតបប្រសិនបើអ្នកចង់ដឹងព័ត៌មានបន្ថែម ឬកម្មង់។`;
      return success(step.skill, step.action, 'Lead outreach drafted (not sent — outbound needs approval).', {
        leadId: lead.id, messageEn: en, messageKh: kh, combined: `${kh}\n\n${en}`,
      }, ['Draft only. No message was sent; outbound outreach requires explicit approval and a compliant channel.']);
    }

    case 'sales:discover_social_opportunities': {
      // Honest compliance boundary: automated listening/scraping of Facebook,
      // Instagram, TikTok, etc. is NOT available without approved platform API
      // credentials. We never scrape private accounts or fabricate leads.
      const configured = Boolean(process.env.SOCIAL_LISTENING_PROVIDER && process.env.SOCIAL_LISTENING_TOKEN);
      if (!configured) {
        return success(step.skill, step.action, 'No approved social-listening source is configured, so no public signals were collected.', {
          configured: false,
          opportunities: [],
          compliantAlternatives: [
            'Capture genuine inbound inquiries via the Telegram bot or a website inquiry form (with consent), then qualify them with sales.qualify_customer_lead.',
            'Connect an approved platform API (e.g. Meta Graph API for your OWN business page, or an authorized listening provider) and set SOCIAL_LISTENING_PROVIDER + SOCIAL_LISTENING_TOKEN.',
          ],
        }, ['Live public social discovery requires authorized platform API access; none is configured.']);
      }
      return success(step.skill, step.action, 'Social-listening provider configured; no live integration implemented yet.', { configured: true, opportunities: [] }, ['Provider configured but the live query is not implemented — reporting honestly rather than inventing leads.']);
    }

    case 'support:categorize_ticket': {
      const text = String(input.requestText ?? input.reason ?? '').toLowerCase();
      const category = /refund|money back|charge|payment/.test(text) ? 'refund'
        : /where|track|delivery|arrive|ship|late|delay/.test(text) ? 'delivery'
        : /broken|damaged|wrong|missing|defect/.test(text) ? 'product_issue'
        : input.orderId ? 'order_help'
        : 'general';
      const priority = /urgent|asap|angry|refund|damaged|wrong|not received/.test(text) ? 'high' : 'normal';
      return success(step.skill, step.action, `Support request categorized as ${category} (${priority} priority).`, { category, priority, orderId: input.orderId });
    }

    case 'support:draft_reply': {
      // Ground the reply in the real order when one is referenced, so support is
      // specific and accurate instead of a generic holding message.
      const orderId = typeof input.orderId === 'string' ? input.orderId : '';
      const order = orderId ? readOrders().find((item) => item.id === orderId) : undefined;
      if (orderId && !order) return fail(step.skill, step.action, 'ORDER_NOT_FOUND', 'The referenced order was not found.');
      let reply: string;
      if (order) {
        const itemSummary = order.items.map((line) => `${line.quantity}× ${line.productName}`).join(', ');
        const statusText: Record<string, string> = {
          pending: 'is being prepared',
          processing: 'is being processed and will ship soon',
          shipped: 'has shipped and is on the way',
          delivered: 'has been delivered',
          cancelled: 'was cancelled',
        };
        reply = `Hi ${order.customerName}, thank you for reaching out about order ${order.id} (${itemSummary}, total $${order.totalAmount.toFixed(2)}). Your order ${statusText[order.status] ?? `is currently "${order.status}"`}. ${order.status === 'shipped' ? 'Please allow a little time for delivery to your address.' : order.status === 'delivered' ? 'We hope everything arrived in good condition — let us know if anything is not right.' : 'We will keep you updated on its progress.'} Is there anything else we can help with?`;
      } else {
        reply = 'Thank you for contacting Shopping Cambodia support. To help you quickly, could you share your order number? We will then look into it using your verified order details.';
      }
      return success(step.skill, step.action, 'Support reply drafted from verified order data without sending.', { reply, orderId: order?.id });
    }

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

    case 'logistics:create_shipment': {
      const orderId = String(input.orderId ?? '');
      const order = readOrders().find((item) => item.id === orderId);
      if (!order) return fail(step.skill, step.action, 'ORDER_NOT_FOUND', 'An exact valid orderId is required to create a shipment.');
      const shipmentId = id('shipment');
      const trackingNumber = `SC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const shipment = {
        id: shipmentId,
        orderId,
        customerName: order.customerName,
        destination: order.customerAddress,
        itemCount: order.items.reduce((sum, line) => sum + line.quantity, 0),
        status: 'ready_for_carrier_booking' as const,
        trackingNumber,
        carrier: typeof input.carrier === 'string' ? input.carrier : undefined,
        note: typeof input.reason === 'string' ? input.reason : undefined,
        workflowId: workflow.id,
        createdAt: now(),
        updatedAt: now(),
      };
      agentStore.mutate((draft) => { draft.shipments.unshift(shipment); });
      return success(step.skill, step.action, `Shipment ${trackingNumber} created for order ${orderId}.`, { shipment }, ['External carrier booking is not connected; tracking number is internal.']);
    }

    case 'logistics:check_delivery_delay': {
      const cutoff = Date.now() - 5 * 24 * 60 * 60 * 1000;
      const delayed = readOrders().filter((order) => ['processing', 'shipped'].includes(order.status) && new Date(order.createdAt).getTime() < cutoff);
      return success(step.skill, step.action, `Found ${delayed.length} potentially delayed orders.`, { delayed });
    }

    case 'logistics:report_delivery_exception': {
      const orderId = String(input.orderId ?? '');
      const order = readOrders().find((item) => item.id === orderId);
      if (!order) return fail(step.skill, step.action, 'ORDER_NOT_FOUND', 'An exact valid orderId is required to report a delivery exception.');
      const allowedTypes = ['delayed', 'address_issue', 'damaged', 'lost', 'other'] as const;
      const type = allowedTypes.includes(input.type as typeof allowedTypes[number]) ? input.type as typeof allowedTypes[number] : 'other';
      const allowedSeverity = ['low', 'medium', 'high'] as const;
      const severity = allowedSeverity.includes(input.severity as typeof allowedSeverity[number]) ? input.severity as typeof allowedSeverity[number] : 'medium';
      const exception = {
        id: id('delivery_exception'),
        orderId,
        type,
        severity,
        description: String(input.reason ?? input.description ?? `Delivery exception reported for order ${orderId}.`),
        status: 'open' as const,
        workflowId: workflow.id,
        createdAt: now(),
      };
      agentStore.mutate((draft) => { draft.deliveryExceptions.unshift(exception); });
      return success(step.skill, step.action, `Delivery exception recorded for order ${orderId} (${type}, ${severity}).`, { exception });
    }


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

    case 'marketing:prepare_telegram_message': {
      // Return the actual drafted campaign content for review, not a placeholder.
      const campaignId = findCampaignId(input, dependencies);
      const campaign = campaignId
        ? agentStore.getState().campaigns.find((item) => item.id === campaignId)
        : agentStore.getState().campaigns[0];
      if (campaign && (campaign.telegramMessageEn || campaign.telegramMessageKh)) {
        return success(step.skill, step.action, 'Telegram message prepared from the reviewed campaign draft.', {
          campaignId: campaign.id,
          messageEn: campaign.telegramMessageEn,
          messageKh: campaign.telegramMessageKh,
          combined: `${campaign.telegramMessageKh}\n\n${campaign.telegramMessageEn}`.trim(),
        });
      }
      return fail(step.skill, step.action, 'NO_CAMPAIGN_CONTENT', 'No drafted campaign message is available to prepare. Create a campaign draft first.');
    }

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
      // Learn preferentially from past campaigns about the SAME products, then
      // fall back to general verified lessons — so creative feedback is relevant.
      const verifiedMemory = currentState.memories
        .filter((memory) => memory.confidence >= 0.5 && (memory.type === 'outcome' || memory.type === 'learning'))
        .map((memory) => {
          const memProductIds = Array.isArray(memory.metadata?.productIds) ? (memory.metadata!.productIds as unknown[]).map(String) : [];
          const relevant = memProductIds.some((pid) => selectedIds.has(pid));
          return { memory, relevant };
        })
        .sort((a, b) => Number(b.relevant) - Number(a.relevant))
        .slice(0, 12)
        .map(({ memory }) => ({ topic: memory.topic, content: memory.content, confidence: memory.confidence }));
      const userRequest = String(input.userRequest ?? input.campaignGoal ?? workflow.goal ?? `Promote ${selected.map((product) => product.name).join(', ')}`);
      const campaignGoal = String(input.campaignGoal ?? userRequest);
      const requestedAudience = typeof input.targetAudience === 'string' && input.targetAudience.trim()
        ? input.targetAudience.trim()
        : 'consented Telegram subscribers in the selected segments';
      const campaignSales = productSalesMap(30);
      const content = await draftCampaignContent({
        products: selected.map((product) => ({
          id: product.id,
          name: product.name,
          description: product.description,
          category: product.category,
          price: product.price,
          stock: availableToPromise(product),
          unit: product.unit,
          sold30d: campaignSales.get(product.id)?.quantity ?? 0,
          revenue30d: campaignSales.get(product.id)?.revenue ?? 0,
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

// Aggregate a customer's verified order history by email, so sales actions can
// personalize offers and follow-ups from real purchases instead of generic text.
interface CustomerHistory {
  email: string;
  name: string;
  orders: number;
  revenue: number;
  lastOrderAt: string;
  productIds: string[];
  productNames: string[];
  topCategory: string;
}

function aggregateCustomerHistory(orders: ReturnType<typeof readOrders>): Map<string, CustomerHistory> {
  const products = readProducts();
  const categoryOf = new Map(products.map((p) => [p.id, p.category]));
  const map = new Map<string, CustomerHistory & { categoryCounts: Record<string, number> }>();
  for (const order of orders) {
    const key = order.customerEmail.toLowerCase();
    const current = map.get(key) ?? { email: key, name: order.customerName, orders: 0, revenue: 0, lastOrderAt: order.createdAt, productIds: [], productNames: [], topCategory: '', categoryCounts: {} };
    current.orders += 1;
    current.revenue += order.totalAmount;
    if (new Date(order.createdAt).getTime() > new Date(current.lastOrderAt).getTime()) current.lastOrderAt = order.createdAt;
    for (const item of order.items) {
      if (!current.productIds.includes(item.productId)) {
        current.productIds.push(item.productId);
        current.productNames.push(item.productName);
      }
      const category = categoryOf.get(item.productId);
      if (category) current.categoryCounts[category] = (current.categoryCounts[category] ?? 0) + item.quantity;
    }
    map.set(key, current);
  }
  const result = new Map<string, CustomerHistory>();
  for (const [key, value] of map) {
    const topCategory = Object.entries(value.categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const { categoryCounts, ...rest } = value;
    result.set(key, { ...rest, topCategory });
  }
  return result;
}

// Match an inquiry to REAL catalogue products by name/category tokens. Returns
// only actual products — never invents interest.
function matchProductsToText(text: string, products: ReturnType<typeof readProducts>): ReturnType<typeof readProducts> {
  const lower = text.toLowerCase();
  const scored = products
    .map((product) => {
      const name = String(product.name ?? '').toLowerCase();
      const category = String(product.category ?? '').toLowerCase();
      let score = 0;
      if (name && lower.includes(name)) score += 3;
      if (category && lower.includes(category)) score += 1;
      for (const token of name.split(/\s+/).filter((t) => t.length >= 4)) {
        if (lower.includes(token)) score += 1;
      }
      return { product, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return scored.map((entry) => entry.product);
}

// Lightweight language detection for lead text: Khmer script vs Latin.
function detectLeadLanguage(text: string): 'km' | 'en' | 'both' {
  const hasKhmer = /[ក-៿]/.test(text);
  const hasLatin = /[a-z]/i.test(text);
  return hasKhmer && hasLatin ? 'both' : hasKhmer ? 'km' : 'en';
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
  // Pull the current telegramChats audience right before sending so a newly
  // started subscriber is always included, not just whoever is cached in state.
  await agentStore.refreshTelegramSubscribers().catch(() => undefined);
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
  let firstSendError = '';
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
      const message = error instanceof Error ? error.message : String(error);
      if (!firstSendError) firstSendError = message;
      agentStore.mutate((draft) => {
        const recipient = draft.campaignRecipients.find((item) => item.id === recipientId);
        if (recipient) Object.assign(recipient, { status: 'failed', error: message, retryCount: 1 });
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
  // Close the learning loop automatically: every campaign that actually reached
  // someone records what creative approach was used and how it performed, so the
  // next draft can learn from it without relying on a separate analytics step.
  if (sent > 0) {
    try { learnFromCampaign(campaign.id); } catch { /* learning must never fail a send */ }
  }
  if (sent === 0) {
    const reason = failed
      ? `Telegram publishing failed for every eligible recipient. Reason: ${firstSendError || 'unknown'}.${/TELEGRAM_LIVE_SEND/.test(firstSendError) ? ' Set TELEGRAM_LIVE_SEND=true on the backend.' : /chat not found|bot was blocked|can't initiate|Forbidden/i.test(firstSendError) ? ' The recipient has not pressed Start on the bot (Telegram blocks messages until they do).' : /bot token|unauthorized|not configured/i.test(firstSendError) ? ' Check TELEGRAM_BOT_TOKEN.' : ''}`
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

// Once-a-day market update broadcast to consented Telegram subscribers. Composes
// a short message from the day's market-intelligence picks and sends it. Opt-in
// via DAILY_MARKET_BROADCAST_ENABLED=true so it never spams unless turned on, and
// it respects subscriber consent + the marketing frequency cap. Guarded to run at
// most once per Cambodia day.
export async function broadcastDailyMarketUpdate(actor = 'system'): Promise<{ skipped: boolean; reason?: string; sent?: number; failed?: number }> {
  if (String(process.env.DAILY_MARKET_BROADCAST_ENABLED ?? 'false').toLowerCase() !== 'true') {
    return { skipped: true, reason: 'daily_broadcast_disabled' };
  }
  const todayKey = cambodiaParts().dateKey;
  const alreadySent = agentStore.getState().auditLogs.some(
    (log) => log.action === 'daily_market_broadcast' && log.success && (log.resultSummary ?? '').includes(todayKey),
  );
  if (alreadySent) return { skipped: true, reason: 'already_sent_today' };

  await agentStore.refreshTelegramSubscribers().catch(() => undefined);
  const state = agentStore.getState();
  const recs = (state.dailyBoostRecommendations ?? []).slice(0, 3);
  if (!recs.length) return { skipped: true, reason: 'no_recommendations' };

  const lines = recs.map((item: any, index: number) => {
    const detail = item.trendTitle || item.category || '';
    return `${index + 1}. ${item.productName}${detail ? ` — ${detail}` : ''}`;
  });
  const en = `Today's picks from Shopping Cambodia:\n${lines.join('\n')}\n\nReply here to order or ask us anything.`;
  const kh = `ជម្រើសប្រចាំថ្ងៃពី Shopping Cambodia៖\n${lines.join('\n')}\n\nឆ្លើយតបនៅទីនេះដើម្បីកម្មង់ ឬសួរយើងបាន។`;

  const eligible = state.telegramSubscribers.filter((subscriber) => isSubscriberEligible(subscriber, ['all-consented']));
  let sent = 0;
  let failed = 0;
  let firstError = '';
  for (const subscriber of eligible) {
    try {
      const message = subscriber.language === 'km' ? kh : subscriber.language === 'en' ? en : `${kh}\n\n${en}`;
      await sendTelegram(subscriber.chatId, message);
      sent += 1;
      agentStore.mutate((draft) => {
        const target = draft.telegramSubscribers.find((item) => item.id === subscriber.id);
        if (target) target.lastMarketingMessageAt = now();
      });
    } catch (error) {
      failed += 1;
      if (!firstError) firstError = error instanceof Error ? error.message : String(error);
    }
  }
  agentStore.addAudit({
    actor,
    actorRole: 'system',
    action: 'daily_market_broadcast',
    resultSummary: `Daily market broadcast ${todayKey}: sent ${sent}, failed ${failed}${firstError ? ` (${firstError})` : ''}.`,
    success: sent > 0,
  });
  return { skipped: false, sent, failed };
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
  // Validate every step against the live skill registry before we persist or run
  // anything: unknown skills/actions and disabled skills/actions must never execute.
  for (const item of plan.workflow.steps) {
    const skill = state.skills.find((s) => s.id === item.skill);
    if (!skill) throw Object.assign(new Error(`Unknown skill in plan: ${item.skill}.`), { code: 'UNKNOWN_SKILL' });
    if (!skill.enabled) throw Object.assign(new Error(`Skill ${item.skill} is disabled.`), { code: 'SKILL_DISABLED' });
    const action = skill.actions.find((a) => a.id === item.action);
    if (!action) throw Object.assign(new Error(`Unknown action ${item.action} for skill ${item.skill}.`), { code: 'UNKNOWN_ACTION' });
    if (!action.enabled) throw Object.assign(new Error(`Action ${item.skill}:${item.action} is disabled.`), { code: 'ACTION_DISABLED' });
  }
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
              expectedEffect:
                step.input.setTo !== undefined ? `Set stock to ${String(step.input.setTo)}.`
                : step.input.reduceByPercent !== undefined ? `Reduce stock by ${String(step.input.reduceByPercent)}% of the current database level.`
                : step.input.setToPercent !== undefined ? `Set stock to ${String(step.input.setToPercent)}% of the current database level.`
                : `Change stock by ${String(step.input.adjustment ?? 'the reviewed amount')}.`,
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

// Re-drive workflows that were mid-execution when the process stopped. Runs on
// boot so an interrupted run resumes instead of hanging. Workflows waiting on a
// human approval are left untouched (they resume when the approval is decided).
export async function resumePendingWorkflows(actor = 'system'): Promise<number> {
  const resumable = agentStore.getState().workflows.filter(
    (workflow) => workflow.status === 'running' || workflow.status === 'pending',
  );
  let resumed = 0;
  for (const workflow of resumable) {
    try {
      await runWorkflow(workflow.id, actor);
      resumed += 1;
    } catch (error) {
      console.error(`Failed to resume workflow ${workflow.id}:`, error instanceof Error ? error.message : error);
    }
  }
  return resumed;
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
