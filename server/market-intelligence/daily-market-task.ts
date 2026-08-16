import crypto from 'crypto';
import { agentStore } from '../store.js';
import { availableToPromise, productSalesMap, readProducts } from '../business-data.js';
import type { MarketIntelligenceRun } from '../types.js';
import { scanCambodiaMarketTrends } from './trend-scanner.js';
import { buildBuyerDemandSnapshots } from './demand-engine.js';
import { buildDailyBoostRecommendations } from './opportunity-engine.js';

function cambodiaParts(date = new Date()): { dateKey: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return { dateKey: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

export function shouldRunDailyMarketScan(now = new Date()): boolean {
  const state = agentStore.getState();
  if (!state.controls.marketIntelligenceEnabled) return false;
  if (!state.heartbeat.checks.marketTrends) return false;
  if (String(process.env.MARKET_TREND_SCAN_ENABLED ?? 'true').toLowerCase() === 'false') return false;
  if (!process.env.OPENAI_API_KEY) return false;
  const current = cambodiaParts(now);
  const scanHour = Math.max(0, Math.min(23, Number(process.env.MARKET_TREND_SCAN_HOUR_KH ?? 7)));
  if (current.hour < scanHour) return false;
  const latestSuccess = state.marketIntelligenceRuns.find((run) => run.status === 'completed');
  return latestSuccess?.cambodiaDate !== current.dateKey;
}

export function latestMarketIntelligence() {
  const state = agentStore.getState();
  const latestRun = state.marketIntelligenceRuns[0];
  const runId = latestRun?.id;
  return {
    run: latestRun,
    trends: runId ? state.marketTrends.filter((trend) => trend.runId === runId) : state.marketTrends.slice(0, 10),
    recommendations: runId ? state.dailyBoostRecommendations.filter((item) => item.runId === runId) : state.dailyBoostRecommendations.slice(0, 5),
  };
}

export async function runCambodiaMarketIntelligence(options: {
  actor?: string;
  force?: boolean;
  request?: string;
} = {}) {
  const actor = options.actor ?? 'system';
  const current = cambodiaParts();
  const state = agentStore.getState();
  if (!options.force) {
    const completedToday = state.marketIntelligenceRuns.find((run) => run.status === 'completed' && run.cambodiaDate === current.dateKey);
    if (completedToday) return { skipped: true, reason: 'already_scanned_today', ...latestMarketIntelligence() };
  }

  const runId = `market_run_${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();
  const run: MarketIntelligenceRun = {
    id: runId,
    market: 'Cambodia',
    cambodiaDate: current.dateKey,
    status: 'running',
    request: options.request ?? 'Daily Cambodia market trend discovery',
    startedAt,
    trendCount: 0,
    recommendationCount: 0,
  };
  agentStore.mutate((draft) => {
    draft.marketIntelligenceRuns.unshift(run);
    draft.marketIntelligenceRuns = draft.marketIntelligenceRuns.slice(0, 60);
  });

  try {
    const products = readProducts().map((product) => ({ ...product, stock: availableToPromise(product) }));
    const scan = await scanCambodiaMarketTrends(products, options.request);
    const fresh = agentStore.getState();
    const demand = buildBuyerDemandSnapshots({ products, events: fresh.events, sales30d: productSalesMap(30) });
    const recommendations = buildDailyBoostRecommendations({
      products,
      trends: scan.trends,
      demand,
      campaigns: fresh.campaigns,
      maxRecommendations: Number(process.env.MARKET_TREND_RECOMMENDATION_COUNT ?? 3),
    }).map((item) => ({ ...item, runId }));
    const trends = scan.trends.map((trend) => ({ ...trend, runId }));
    const completedAt = new Date().toISOString();

    agentStore.mutate((draft) => {
      draft.marketTrends = [...trends, ...draft.marketTrends].slice(0, 150);
      draft.dailyBoostRecommendations = [...recommendations, ...draft.dailyBoostRecommendations].slice(0, 100);
      const target = draft.marketIntelligenceRuns.find((item) => item.id === runId);
      if (target) {
        target.status = 'completed';
        target.completedAt = completedAt;
        target.trendCount = trends.length;
        target.recommendationCount = recommendations.length;
        target.summary = scan.summary;
      }
      if (recommendations.length) {
        draft.memories.unshift({
          id: `memory_market_${Date.now()}`,
          type: 'observation',
          topic: 'cambodia_daily_market_opportunities',
          content: recommendations.slice(0, 3).map((item) => `${item.productName}: ${item.score}/100 because ${item.trendTitle}`).join(' | '),
          confidence: Math.max(...recommendations.map((item) => item.confidence)),
          source: `market-intelligence:${runId}`,
          createdAt: completedAt,
          metadata: {
            runId,
            productIds: recommendations.map((item) => item.productId),
            recommendationIds: recommendations.map((item) => item.id),
          },
        });
        draft.memories = draft.memories.slice(0, 500);
      }
    });
    agentStore.addAudit({
      actor,
      actorRole: actor === 'system' ? 'system' : 'admin',
      action: 'cambodia_market_intelligence_scan',
      resultSummary: `Found ${trends.length} market trends and ${recommendations.length} daily boost recommendations.`,
      success: true,
    });
    return { skipped: false, run: agentStore.getState().marketIntelligenceRuns.find((item) => item.id === runId), trends, recommendations };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    agentStore.mutate((draft) => {
      const target = draft.marketIntelligenceRuns.find((item) => item.id === runId);
      if (target) {
        target.status = 'failed';
        target.completedAt = new Date().toISOString();
        target.error = message;
      }
    });
    agentStore.addAudit({ actor, actorRole: actor === 'system' ? 'system' : 'admin', action: 'cambodia_market_intelligence_scan', resultSummary: 'Cambodia market intelligence scan failed.', success: false, error: { code: 'MARKET_INTELLIGENCE_FAILED', message } });
    throw error;
  }
}
