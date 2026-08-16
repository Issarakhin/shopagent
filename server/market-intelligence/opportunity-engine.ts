import type { BuyerDemandSnapshot, Campaign, DailyBoostRecommendation, MarketTrendSignal } from '../types.js';
import type { SelectableProduct } from '../product-selection.js';

function normalize(value: string): string[] {
  return value.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter((token) => token.length >= 3);
}

function productTrendRelevance(product: SelectableProduct, trend: MarketTrendSignal): number {
  if (trend.matchedProductIds.includes(product.id)) return 1;
  if (trend.matchedCategories.some((category) => category.toLowerCase() === product.category.toLowerCase())) return 0.8;
  const productTokens = new Set(normalize(`${product.name} ${product.category} ${product.description}`));
  const trendTokens = new Set(normalize(`${trend.title} ${trend.summary} ${trend.consumerNeed} ${trend.keywords.join(' ')}`));
  let matches = 0;
  for (const token of productTokens) if (trendTokens.has(token)) matches += 1;
  return Math.min(0.75, matches / Math.max(2, Math.min(productTokens.size, 8)));
}

function campaignFatigue(productId: string, campaigns: Campaign[]): number {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = campaigns.filter((campaign) => campaign.productIds.includes(productId) && new Date(campaign.createdAt).getTime() >= cutoff);
  return Math.min(1, recent.length / 4);
}

function demandScore(snapshot: BuyerDemandSnapshot | undefined): number {
  if (!snapshot) return 0.45;
  return Math.max(0, Math.min(1, 0.5 + snapshot.demandMomentum / 2));
}

function conversionOpportunity(snapshot: BuyerDemandSnapshot | undefined): number {
  if (!snapshot || snapshot.views7d < 3) return 0.4;
  return Math.max(0, Math.min(1, 1 - snapshot.conversionRate7d));
}

function confidence(score: number, trend: MarketTrendSignal, relevance: number, evidenceCount: number): number {
  const evidence = Math.min(1, evidenceCount / 3);
  const value = trend.confidence * 0.5 + relevance * 0.25 + evidence * 0.15 + Math.min(1, score / 100) * 0.1;
  return Number(Math.max(0, Math.min(0.98, value)).toFixed(2));
}

export function buildDailyBoostRecommendations(options: {
  products: SelectableProduct[];
  trends: MarketTrendSignal[];
  demand: BuyerDemandSnapshot[];
  campaigns: Campaign[];
  maxRecommendations?: number;
}): DailyBoostRecommendation[] {
  const active = options.products.filter((product) => product.status === 'active' && product.stock > 0);
  const maxStock = Math.max(1, ...active.map((product) => product.stock));
  const demandMap = new Map(options.demand.map((item) => [item.productId, item]));
  const candidates: DailyBoostRecommendation[] = [];

  for (const product of active) {
    const stockScore = product.stock / maxStock;
    const snapshot = demandMap.get(product.id);
    const fatigue = campaignFatigue(product.id, options.campaigns);
    for (const trend of options.trends) {
      const relevance = productTrendRelevance(product, trend);
      if (relevance < 0.28) continue;
      const currentDemand = demandScore(snapshot);
      const conversionGap = conversionOpportunity(snapshot);
      const freshness = 1 - fatigue;
      const score = Math.max(0, Math.min(100,
        trend.confidence * 35
        + relevance * 25
        + stockScore * 15
        + currentDemand * 12
        + conversionGap * 8
        + freshness * 5
      ));
      const reasons = [
        `${trend.title} matches ${product.name}.`,
        `${product.stock} ${product.unit} are currently available.`,
        snapshot
          ? `Seven-day demand momentum is ${snapshot.demandMomentum >= 0 ? 'positive or stable' : 'declining'} (${snapshot.demandMomentum.toFixed(2)}).`
          : 'Internal buyer-demand history is still limited.',
        fatigue > 0 ? 'The product has recent campaign exposure, so campaign fatigue reduced the score.' : 'The product has low recent campaign fatigue.',
      ];
      candidates.push({
        id: `daily_boost_${product.id}_${trend.id}`,
        productId: product.id,
        productName: product.name,
        category: product.category,
        market: 'Cambodia',
        opportunityType: trend.direction === 'seasonal' ? 'seasonal_demand' : trend.direction === 'rising' ? 'rising_demand' : 'market_fit',
        score: Number(score.toFixed(1)),
        confidence: confidence(score, trend, relevance, trend.evidence.length),
        trendId: trend.id,
        trendTitle: trend.title,
        trendSummary: trend.summary,
        consumerNeed: trend.consumerNeed,
        stock: product.stock,
        unit: product.unit,
        demandMomentum: snapshot?.demandMomentum ?? 0,
        conversionRate7d: snapshot?.conversionRate7d ?? 0,
        sold30d: snapshot?.sold30d ?? 0,
        selectionReason: reasons.join(' '),
        recommendedCampaignAngle: trend.recommendedAngles[0] ?? `Connect ${product.name} to ${trend.consumerNeed}`,
        evidence: trend.evidence,
        generatedAt: new Date().toISOString(),
        status: 'recommended',
      });
    }
  }

  const byProduct = new Map<string, DailyBoostRecommendation>();
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (!byProduct.has(candidate.productId)) byProduct.set(candidate.productId, candidate);
  }
  return [...byProduct.values()]
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence)
    .slice(0, Math.max(1, Math.min(5, options.maxRecommendations ?? 3)));
}
