import crypto from 'crypto';
import type { MarketTrendSignal } from '../types.js';

export interface TrendScanProduct {
  id: string;
  name: string;
  description: string;
  category: string;
  stock: number;
  unit: string;
  status: string;
}

export interface TrendScanResult {
  market: 'Cambodia';
  windowDays: number;
  summary: string;
  trends: MarketTrendSignal[];
  searchedAt: string;
  source: 'openai-web-search';
}

const TREND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['market', 'windowDays', 'summary', 'trends'],
  properties: {
    market: { type: 'string', enum: ['Cambodia'] },
    windowDays: { type: 'integer' },
    summary: { type: 'string' },
    trends: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title', 'summary', 'consumerNeed', 'whyNow', 'direction', 'confidence',
          'keywords', 'matchedCategories', 'matchedProductIds', 'recommendedAngles', 'evidence',
        ],
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          consumerNeed: { type: 'string' },
          whyNow: { type: 'string' },
          direction: { type: 'string', enum: ['rising', 'steady', 'seasonal', 'emerging', 'uncertain'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          keywords: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          matchedCategories: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          matchedProductIds: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          recommendedAngles: { type: 'array', items: { type: 'string' }, maxItems: 6 },
          evidence: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'url', 'source', 'publishedAt', 'relevance'],
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
                source: { type: 'string' },
                publishedAt: { type: ['string', 'null'] },
                relevance: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const;

function responseText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') throw new Error('OpenAI returned an invalid trend response.');
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === 'string') return record.output_text;
  const output = Array.isArray(record.output) ? record.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? (item as Record<string, unknown>).content as unknown[]
      : [];
    for (const entry of content) {
      if (!entry || typeof entry !== 'object') continue;
      const text = (entry as Record<string, unknown>).text;
      if (typeof text === 'string') return text;
    }
  }
  throw new Error('OpenAI returned no trend text.');
}

function parseDomains(): string[] {
  return String(process.env.MARKET_TREND_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function sanitizeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function validateTrendPayload(value: unknown, products: TrendScanProduct[], windowDays: number): Omit<TrendScanResult, 'searchedAt' | 'source'> {
  if (!value || typeof value !== 'object') throw new Error('Market trend output must be an object.');
  const record = value as Record<string, unknown>;
  if (record.market !== 'Cambodia') throw new Error('Market trend output must target Cambodia.');
  if (!Array.isArray(record.trends)) throw new Error('Market trend output is missing trends.');
  const validIds = new Set(products.map((product) => product.id));
  const validCategories = new Set(products.map((product) => product.category.toLowerCase()));
  const trends: MarketTrendSignal[] = [];

  for (const raw of record.trends.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const title = String(item.title ?? '').trim();
    const summary = String(item.summary ?? '').trim();
    const consumerNeed = String(item.consumerNeed ?? '').trim();
    const whyNow = String(item.whyNow ?? '').trim();
    if (!title || !summary || !consumerNeed || !whyNow) continue;
    const direction = ['rising', 'steady', 'seasonal', 'emerging', 'uncertain'].includes(String(item.direction))
      ? String(item.direction) as MarketTrendSignal['direction']
      : 'uncertain';
    const confidence = Math.max(0, Math.min(1, Number(item.confidence) || 0));
    const keywords = Array.isArray(item.keywords) ? item.keywords.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 12) : [];
    const matchedCategories = Array.isArray(item.matchedCategories)
      ? item.matchedCategories.map(String).filter((category) => validCategories.has(category.toLowerCase())).slice(0, 8)
      : [];
    const matchedProductIds = Array.isArray(item.matchedProductIds)
      ? item.matchedProductIds.map(String).filter((productId) => validIds.has(productId)).slice(0, 8)
      : [];
    const recommendedAngles = Array.isArray(item.recommendedAngles)
      ? item.recommendedAngles.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 6)
      : [];
    const evidence = Array.isArray(item.evidence)
      ? item.evidence.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return [];
          const evidenceItem = entry as Record<string, unknown>;
          const url = sanitizeUrl(evidenceItem.url);
          if (!url) return [];
          return [{
            title: String(evidenceItem.title ?? 'Source').trim() || 'Source',
            url,
            source: String(evidenceItem.source ?? new URL(url).hostname).trim() || new URL(url).hostname,
            publishedAt: typeof evidenceItem.publishedAt === 'string' && evidenceItem.publishedAt.trim() ? evidenceItem.publishedAt.trim() : undefined,
            relevance: String(evidenceItem.relevance ?? '').trim(),
          }];
        }).slice(0, 8)
      : [];
    if (!evidence.length) continue;
    trends.push({
      id: `trend_${crypto.randomUUID()}`,
      market: 'Cambodia',
      title,
      summary,
      consumerNeed,
      whyNow,
      direction,
      confidence,
      keywords,
      matchedCategories,
      matchedProductIds,
      recommendedAngles,
      evidence,
      discoveredAt: new Date().toISOString(),
      windowDays,
    });
  }

  return {
    market: 'Cambodia',
    windowDays,
    summary: String(record.summary ?? '').trim() || `Found ${trends.length} Cambodia market signals.`,
    trends,
  };
}

export async function scanCambodiaMarketTrends(products: TrendScanProduct[], request = ''): Promise<TrendScanResult> {
  if (String(process.env.MARKET_TREND_SCAN_ENABLED ?? 'true').toLowerCase() === 'false') {
    throw Object.assign(new Error('Cambodia market trend scanning is disabled.'), { code: 'MARKET_TREND_SCAN_DISABLED' });
  }
  if (!process.env.OPENAI_API_KEY) {
    throw Object.assign(new Error('OPENAI_API_KEY is required for live Cambodia market trend scanning.'), { code: 'OPENAI_KEY_REQUIRED' });
  }

  const windowDays = Math.max(1, Math.min(30, Number(process.env.MARKET_TREND_WINDOW_DAYS ?? 7)));
  const maxResults = Math.max(1, Math.min(10, Number(process.env.MARKET_TREND_MAX_RESULTS ?? 6)));
  const catalogue = products
    .filter((product) => product.status === 'active')
    .slice(0, 200)
    .map((product) => ({
      id: product.id,
      name: product.name,
      description: product.description,
      category: product.category,
      availableStock: product.stock,
      unit: product.unit,
    }));
  const domains = parseDomains();
  const webTool: Record<string, unknown> = {
    type: 'web_search',
    search_context_size: ['low', 'medium', 'high'].includes(String(process.env.MARKET_TREND_SEARCH_CONTEXT))
      ? String(process.env.MARKET_TREND_SEARCH_CONTEXT)
      : 'medium',
    user_location: {
      type: 'approximate',
      country: 'KH',
      city: 'Phnom Penh',
      timezone: 'Asia/Phnom_Penh',
    },
  };
  if (domains.length) webTool.filters = { allowed_domains: domains };

  const instructions = `You are the Cambodia Market Trend Scanner for Shopping Cambodia.\n\nUse web search to find current, evidence-backed consumer and product demand signals relevant to Cambodia. Search both English-language and Khmer-language public web/media sources when useful. Focus on the last ${windowDays} days unless a seasonal event needs slightly wider context.\n\nPrioritize Cambodia-specific evidence: Cambodian media, retail and lifestyle coverage, food and recipe interest, agriculture and supply context, public consumer discussions indexed on the web, festivals, holidays, tourism demand, gifting, weather-linked demand, and product/category stories. Regional evidence may support a Cambodia trend only when the Cambodia relevance is explained.\n\nDo not call something a trend because of one weak source. Prefer multiple independent signals. Do not invent social-media metrics, search volumes, buyer counts, prices, discounts, shortages, or product facts. Only use product IDs from the supplied catalogue. A matched product is a candidate, not an instruction to publish or change anything.\n\nReturn at most ${maxResults} commercially relevant trends. Every trend must include at least one real evidence URL used during web search. Confidence must reflect evidence strength and Cambodia relevance.`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
      instructions,
      tools: [webTool],
      input: JSON.stringify({
        market: 'Cambodia',
        requestedFocus: request || 'Discover current market opportunities relevant to our catalogue.',
        trendWindowDays: windowDays,
        catalogue,
        todayCambodia: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Phnom_Penh', dateStyle: 'full' }).format(new Date()),
      }),
      text: {
        format: {
          type: 'json_schema',
          name: 'shopping_cambodia_market_trends',
          strict: true,
          schema: TREND_SCHEMA,
        },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw Object.assign(new Error(`OpenAI market trend scan failed (${response.status}): ${detail.slice(0, 800)}`), { code: 'MARKET_TREND_SCAN_FAILED' });
  }

  const payload = await response.json();
  const parsed = validateTrendPayload(JSON.parse(responseText(payload)), products, windowDays);
  return {
    ...parsed,
    trends: parsed.trends.slice(0, maxResults),
    searchedAt: new Date().toISOString(),
    source: 'openai-web-search',
  };
}
