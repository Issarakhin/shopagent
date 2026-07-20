import { agentStore } from './store.js';
import {
  availableToPromise,
  paidLikeOrders,
  productSalesMap,
  readOrders,
  readProducts,
} from './business-data.js';
import type {
  CustomerSegment,
  DynamicPricingRecommendation,
  InventoryForecast,
  ProductBoost,
  RevenueOpportunity,
} from './types.js';

const DAY = 24 * 60 * 60 * 1000;
const now = () => new Date().toISOString();

function eventCounts(productId: string, days = 30) {
  const cutoff = Date.now() - days * DAY;
  const events = agentStore.getState().events.filter((event) => event.productId === productId && new Date(event.createdAt).getTime() >= cutoff);
  return {
    views: events.filter((event) => event.type === 'product_view').length,
    carts: events.filter((event) => event.type === 'add_to_cart').length,
    purchases: events.filter((event) => event.type === 'purchase').reduce((sum, event) => sum + (event.quantity ?? 1), 0),
  };
}

export function calculateProductBoosts(): ProductBoost[] {
  const products = readProducts();
  const sales = productSalesMap(30);
  const previous = agentStore.getState().boosts;
  const boosts = products
    .filter((product) => product.status === 'active' && availableToPromise(product) > 0)
    .map((product) => {
      const sold = sales.get(product.id)?.quantity ?? 0;
      const events = eventCounts(product.id);
      const stockScore = Math.min(100, availableToPromise(product) * 6);
      const slowSalesScore = Math.max(0, 100 - sold * 12);
      const interestScore = Math.min(100, events.views * 4 + events.carts * 10);
      const conversionPenalty = events.views > 0 ? Math.min(40, (events.purchases / events.views) * 100) : 0;
      const estimatedMarginScore = 40;
      const score = Math.round(stockScore * 0.32 + slowSalesScore * 0.30 + interestScore * 0.18 + estimatedMarginScore * 0.20 - conversionPenalty * 0.12);
      const existing = previous.find((item) => item.productId === product.id);
      const reasonParts = [];
      if (availableToPromise(product) >= 10) reasonParts.push('healthy available stock');
      if (sold <= 2) reasonParts.push('low recent sales');
      if (events.views >= 5 && events.purchases === 0) reasonParts.push('interest without conversion');
      if (!reasonParts.length) reasonParts.push('balanced opportunity signal');
      return {
        id: existing?.id ?? `boost_${product.id}`,
        productId: product.id,
        score: Math.max(0, Math.min(100, score)),
        reason: reasonParts.join(', '),
        status: existing?.status ?? 'recommended',
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
        approvalId: existing?.approvalId,
        expiresAt: existing?.expiresAt,
      } satisfies ProductBoost;
    })
    .sort((a, b) => b.score - a.score);

  agentStore.mutate((draft) => {
    draft.boosts = boosts;
  });
  return boosts;
}

export function calculateInventoryForecasts(): InventoryForecast[] {
  const products = readProducts();
  const sales = productSalesMap(30);
  const forecasts = products.map((product) => {
    const quantity = sales.get(product.id)?.quantity ?? 0;
    const dailyDemand = quantity / 30;
    const available = availableToPromise(product);
    const daysOfCover = dailyDemand > 0 ? available / dailyDemand : null;
    const leadTimeDays = 7;
    const safetyDays = 5;
    const recommended = Math.max(0, Math.ceil(dailyDemand * (leadTimeDays + safetyDays) - available));
    const reorderDate = daysOfCover !== null
      ? new Date(Date.now() + Math.max(0, daysOfCover - leadTimeDays) * DAY).toISOString()
      : undefined;
    const confidence = Math.min(0.95, 0.35 + Math.min(quantity, 30) / 50);
    return {
      id: `forecast_${product.id}`,
      productId: product.id,
      dailyDemand: Number(dailyDemand.toFixed(3)),
      daysOfCover: daysOfCover === null ? null : Number(daysOfCover.toFixed(1)),
      reorderDate,
      recommendedReorderQuantity: recommended,
      confidence: Number(confidence.toFixed(2)),
      generatedAt: now(),
    } satisfies InventoryForecast;
  });
  agentStore.mutate((draft) => {
    draft.inventoryForecasts = forecasts;
  });
  return forecasts;
}

export function calculateDynamicPricing(): DynamicPricingRecommendation[] {
  const products = readProducts();
  const sales = productSalesMap(30);
  const previous = agentStore.getState().pricingRecommendations;
  const recommendations = products.map((product) => {
    const sold = sales.get(product.id)?.quantity ?? 0;
    const available = availableToPromise(product);
    const events = eventCounts(product.id);
    let percent = 0;
    const reasons: string[] = [];

    if (available >= 20 && sold <= 2) {
      percent -= 8;
      reasons.push('high stock with slow sales');
    }
    if (available <= 5 && sold >= 5) {
      percent += 6;
      reasons.push('strong demand with limited stock');
    }
    if (events.views >= 10 && events.carts >= 3 && events.purchases === 0) {
      percent -= 4;
      reasons.push('high interest but weak conversion');
    }
    percent = Math.max(-12, Math.min(10, percent));
    const recommendedPrice = Math.max(0.5, Number((product.price * (1 + percent / 100)).toFixed(2)));
    const existing = previous.find((item) => item.productId === product.id && item.status !== 'applied');
    return {
      id: existing?.id ?? `price_${product.id}_${Date.now()}`,
      productId: product.id,
      currentPrice: product.price,
      recommendedPrice,
      changePercent: percent,
      reason: reasons.join(', ') || 'keep current price; no strong pricing signal',
      confidence: Number(Math.min(0.9, 0.45 + (sold + events.views / 5) / 50).toFixed(2)),
      status: existing?.status ?? 'recommended',
      createdAt: existing?.createdAt ?? now(),
      approvalId: existing?.approvalId,
    } satisfies DynamicPricingRecommendation;
  });
  agentStore.mutate((draft) => {
    draft.pricingRecommendations = recommendations;
  });
  return recommendations;
}

export function calculateCustomerSegments(): CustomerSegment[] {
  const orders = readOrders().filter((order) => order.status !== 'cancelled');
  const customers = new Map<string, { count: number; revenue: number; last: number }>();
  for (const order of orders) {
    const key = order.customerEmail.toLowerCase();
    const current = customers.get(key) ?? { count: 0, revenue: 0, last: 0 };
    current.count += 1;
    current.revenue += order.totalAmount;
    current.last = Math.max(current.last, new Date(order.createdAt).getTime());
    customers.set(key, current);
  }
  const records = [...customers.entries()];
  const segment = (id: string, name: string, description: string, filter: (value: { count: number; revenue: number; last: number }) => boolean, ruleSummary: string): CustomerSegment => ({
    id,
    name,
    description,
    customerEmails: records.filter(([, value]) => filter(value)).map(([email]) => email),
    ruleSummary,
    generatedAt: now(),
  });
  const segments = [
    segment('vip', 'VIP customers', 'High-value repeat customers.', (value) => value.count >= 3 || value.revenue >= 150, '3+ orders or $150+ lifetime value'),
    segment('recent', 'Recent customers', 'Customers active in the last 30 days.', (value) => value.last >= Date.now() - 30 * DAY, 'last order within 30 days'),
    segment('at-risk', 'At-risk customers', 'Previously active customers who have not ordered recently.', (value) => value.count >= 2 && value.last < Date.now() - 60 * DAY, '2+ orders and inactive for 60+ days'),
    segment('new', 'New customers', 'Customers with exactly one order.', (value) => value.count === 1, 'exactly one order'),
  ];
  agentStore.mutate((draft) => {
    draft.customerSegments = segments;
  });
  return segments;
}

export function calculateRevenueOpportunities(): RevenueOpportunity[] {
  const products = readProducts();
  const boosts = calculateProductBoosts();
  const pricing = calculateDynamicPricing();
  const forecasts = calculateInventoryForecasts();
  const opportunities: RevenueOpportunity[] = [];

  const topBoost = boosts.find((item) => item.score >= 55);
  if (topBoost) {
    const product = products.find((item) => item.id === topBoost.productId);
    opportunities.push({
      id: `opportunity_boost_${topBoost.productId}`,
      title: `Boost ${product?.name ?? topBoost.productId}`,
      description: `Smart boost score ${topBoost.score}/100 because of ${topBoost.reason}.`,
      estimatedMonthlyImpact: Number(((product?.price ?? 0) * 4).toFixed(2)),
      confidence: 0.62,
      recommendedSkill: 'marketing',
      recommendedAction: 'activate_product_boost',
      createdAt: now(),
    });
  }

  const priceOpportunity = pricing.find((item) => item.changePercent !== 0);
  if (priceOpportunity) {
    const product = products.find((item) => item.id === priceOpportunity.productId);
    opportunities.push({
      id: `opportunity_price_${priceOpportunity.productId}`,
      title: `Review price for ${product?.name ?? priceOpportunity.productId}`,
      description: `${priceOpportunity.changePercent > 0 ? 'Increase' : 'Reduce'} price by ${Math.abs(priceOpportunity.changePercent)}%: ${priceOpportunity.reason}.`,
      estimatedMonthlyImpact: Number((Math.abs(priceOpportunity.recommendedPrice - priceOpportunity.currentPrice) * 10).toFixed(2)),
      confidence: priceOpportunity.confidence,
      recommendedSkill: 'finance',
      recommendedAction: 'apply_approved_price',
      createdAt: now(),
    });
  }

  const stockRisk = forecasts.find((item) => item.recommendedReorderQuantity > 0);
  if (stockRisk) {
    const product = products.find((item) => item.id === stockRisk.productId);
    opportunities.push({
      id: `opportunity_stock_${stockRisk.productId}`,
      title: `Prevent stockout for ${product?.name ?? stockRisk.productId}`,
      description: `Recommended reorder quantity: ${stockRisk.recommendedReorderQuantity}.`,
      estimatedMonthlyImpact: Number(((product?.price ?? 0) * stockRisk.recommendedReorderQuantity * 0.25).toFixed(2)),
      confidence: stockRisk.confidence,
      recommendedSkill: 'inventory',
      recommendedAction: 'recommend_reorder',
      createdAt: now(),
    });
  }

  agentStore.mutate((draft) => {
    draft.revenueOpportunities = opportunities;
  });
  return opportunities;
}

export function learnFromCampaign(campaignId: string): void {
  const state = agentStore.getState();
  const campaign = state.campaigns.find((item) => item.id === campaignId);
  if (!campaign) return;
  const total = campaign.sentCount + campaign.failedCount + campaign.skippedCount;
  const deliveryRate = total > 0 ? campaign.sentCount / total : 0;
  agentStore.mutate((draft) => {
    draft.memories.unshift({
      id: `memory_campaign_${campaign.id}_${Date.now()}`,
      type: 'outcome',
      topic: 'telegram_campaign_delivery',
      content: `Campaign ${campaign.name} delivered to ${campaign.sentCount}/${total} eligible attempts (${Math.round(deliveryRate * 100)}%).`,
      confidence: total >= 10 ? 0.8 : 0.55,
      source: `campaign:${campaign.id}`,
      createdAt: now(),
      metadata: { deliveryRate, sent: campaign.sentCount, failed: campaign.failedCount, skipped: campaign.skippedCount },
    });
    draft.memories = draft.memories.slice(0, 500);
  });
}

export function storePublicBoosts() {
  return agentStore.getState().boosts.filter((item) => item.status === 'active' && (!item.expiresAt || new Date(item.expiresAt).getTime() > Date.now()));
}
