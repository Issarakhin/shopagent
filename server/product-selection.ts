export type ProductSelectionStrategy =
  | 'specific_product'
  | 'highest_stock'
  | 'clearance'
  | 'lowest_sales'
  | 'best_seller'
  | 'high_interest_low_conversion'
  | 'category_match'
  | 'smart_boost';

export interface SelectableProduct {
  id: string;
  name: string;
  description: string;
  category: string;
  price: number;
  stock: number;
  unit: string;
  status: string;
}

export interface ProductSelectionEvent {
  type: string;
  productId?: string;
  quantity?: number;
  createdAt: string;
}

export interface ProductSelectionCandidate {
  productId: string;
  productName: string;
  category: string;
  price: number;
  stock: number;
  unit: string;
  sold30d: number;
  views30d: number;
  carts30d: number;
  purchases30d: number;
  conversionRate: number;
  boostScore: number;
  selectionScore: number;
  selectionReason: string;
}

export interface ProductSelectionResult {
  strategy: ProductSelectionStrategy;
  strategyLabel: string;
  request: string;
  scope: string;
  criteriaSummary: string;
  selectedProductIds: string[];
  rankedProducts: ProductSelectionCandidate[];
  confidence: number;
  noDiscountAssumed: boolean;
}

const CATEGORY_ALIASES: Record<string, string[]> = {
  Meats: ['meat', 'meats', 'beef', 'chicken', 'pork'],
  Fishes: ['fish', 'fishes', 'seafood', 'prawn', 'prawns', 'shrimp'],
  Fruits: ['fruit', 'fruits', 'durian', 'mango', 'mangoes', 'orange', 'oranges'],
  Sweets: ['sweet', 'sweets', 'dessert', 'desserts', 'cookie', 'cookies', 'cake', 'cakes'],
  Handicrafts: ['handicraft', 'handicrafts', 'craft', 'crafts', 'pottery', 'krama', 'basket'],
};

const GENERIC_PRODUCT_WORDS = new Set([
  'cambodian', 'khmer', 'fresh', 'whole', 'local', 'product', 'products', 'item', 'items',
  'fish', 'fishes', 'fruit', 'fruits', 'meat', 'meats', 'sweet', 'sweets', 'handicraft', 'handicrafts',
]);

function normalize(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function hasAny(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

function desiredCount(request: string): number {
  const normalized = normalize(request);
  const numeric = normalized.match(/\b(?:top|select|choose|boost|promote)\s+(\d{1,2})\b/);
  if (numeric) return Math.max(1, Math.min(5, Number(numeric[1])));
  const words: Array<[RegExp, number]> = [
    [/\b(?:top|choose|select|boost|promote)\s+five\b/, 5],
    [/\b(?:top|choose|select|boost|promote)\s+four\b/, 4],
    [/\b(?:top|choose|select|boost|promote)\s+three\b/, 3],
    [/\b(?:top|choose|select|boost|promote)\s+two\b/, 2],
  ];
  for (const [pattern, count] of words) if (pattern.test(normalized)) return count;
  return 1;
}

function inferCategory(request: string, products: SelectableProduct[]): string | undefined {
  const normalized = normalize(request);
  for (const [category, aliases] of Object.entries(CATEGORY_ALIASES)) {
    if (aliases.some((alias) => new RegExp(`\\b${alias}\\b`, 'i').test(normalized))) return category;
  }
  return products.find((product) => new RegExp(`\\b${normalize(product.category)}\\b`, 'i').test(normalized))?.category;
}

function inferStrategy(request: string, hasSpecificProducts: boolean, category?: string): ProductSelectionStrategy {
  const normalized = normalize(request);
  if (hasSpecificProducts) return 'specific_product';
  if (hasAny(normalized, ['clearance', 'clear stock', 'clear inventory', 'move stock', 'move inventory', 'overstock', 'over stock', 'excess stock', 'surplus', 'dead stock'])) return 'clearance';
  if (hasAny(normalized, ['most stock', 'highest stock', 'largest stock', 'biggest stock', 'most inventory', 'highest inventory', 'lots of stock', 'stock the most'])) return 'highest_stock';
  if (hasAny(normalized, ['low selling', 'low-selling', 'slow selling', 'slow-selling', 'slow moving', 'slow-moving', 'least sold', 'lowest sales', 'poor sales', 'not selling'])) return 'lowest_sales';
  if (hasAny(normalized, ['best seller', 'best-selling', 'best selling', 'top seller', 'top-selling', 'most sold', 'highest sales'])) return 'best_seller';
  if (hasAny(normalized, ['viewed but not bought', 'views but no sales', 'high views low sales', 'high interest low conversion', 'added to cart but not bought', 'cart but no purchase'])) return 'high_interest_low_conversion';
  if (category) return 'category_match';
  return 'smart_boost';
}

function findNamedProductIds(request: string, products: SelectableProduct[]): string[] {
  const normalizedRequest = normalize(request);
  const direct = products
    .filter((product) => normalizedRequest.includes(normalize(product.name)))
    .sort((a, b) => b.name.length - a.name.length)
    .map((product) => product.id);
  if (direct.length) return direct;

  const matches = products.map((product) => {
    const tokens = normalize(product.name)
      .split(' ')
      .filter((token) => token.length >= 4 && !GENERIC_PRODUCT_WORDS.has(token));
    const matched = tokens.filter((token) => new RegExp(`\\b${token}\\b`, 'i').test(normalizedRequest));
    return { id: product.id, tokenCount: tokens.length, matchedCount: matched.length };
  }).filter((item) => item.matchedCount >= 2 || (item.tokenCount === 1 && item.matchedCount === 1));

  const best = Math.max(0, ...matches.map((item) => item.matchedCount));
  return matches.filter((item) => item.matchedCount === best).map((item) => item.id);
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function strategyLabel(strategy: ProductSelectionStrategy): string {
  return ({
    specific_product: 'Explicitly requested product',
    highest_stock: 'Highest available stock',
    clearance: 'Clearance candidate',
    lowest_sales: 'Slow-moving product',
    best_seller: 'Best-selling product',
    high_interest_low_conversion: 'High interest, low conversion',
    category_match: 'Requested product category',
    smart_boost: 'Smart boost opportunity',
  } satisfies Record<ProductSelectionStrategy, string>)[strategy];
}

function criteriaSummary(strategy: ProductSelectionStrategy, scope: string): string {
  const summaries: Record<ProductSelectionStrategy, string> = {
    specific_product: `Use the exact product named by the admin within ${scope}.`,
    highest_stock: `Choose the eligible product with the greatest available stock within ${scope}.`,
    clearance: `Choose a surplus or slow-moving candidate within ${scope} using high stock, low 30-day sales, and weak conversion. No discount is assumed.`,
    lowest_sales: `Choose an in-stock product within ${scope} with the lowest 30-day sales while preferring useful available stock.`,
    best_seller: `Choose the strongest 30-day seller within ${scope}.`,
    high_interest_low_conversion: `Choose a product within ${scope} with strong views or cart activity but weak purchase conversion.`,
    category_match: `Choose the strongest smart-boost candidate inside ${scope}.`,
    smart_boost: 'Choose the strongest current smart-boost opportunity using stock, sales, interest, and conversion signals.',
  };
  return summaries[strategy];
}

export function resolveCampaignProductSelection(options: {
  request: string;
  products: SelectableProduct[];
  sales30d: Map<string, { quantity: number; revenue: number }>;
  events: ProductSelectionEvent[];
  preferredProductIds?: string[];
  boostScores?: Map<string, number>;
  maxProducts?: number;
}): ProductSelectionResult {
  const { request, products, sales30d, events } = options;
  const activeProducts = products.filter((product) => product.status === 'active' && product.stock > 0);
  const explicitIds = (options.preferredProductIds ?? []).filter((productId) => activeProducts.some((product) => product.id === productId));
  const namedIds = explicitIds.length ? explicitIds : findNamedProductIds(request, activeProducts);
  const category = namedIds.length ? undefined : inferCategory(request, activeProducts);
  const strategy = inferStrategy(request, namedIds.length > 0, category);
  const count = Math.max(1, Math.min(5, options.maxProducts ?? desiredCount(request)));

  let candidates = activeProducts;
  if (namedIds.length) candidates = activeProducts.filter((product) => namedIds.includes(product.id));
  else if (category) candidates = activeProducts.filter((product) => product.category.toLowerCase() === category.toLowerCase());

  if (!candidates.length) {
    return {
      strategy,
      strategyLabel: strategyLabel(strategy),
      request,
      scope: category ?? 'all active products',
      criteriaSummary: criteriaSummary(strategy, category ?? 'all active products'),
      selectedProductIds: [],
      rankedProducts: [],
      confidence: 0,
      noDiscountAssumed: strategy === 'clearance',
    };
  }

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const metricRows = candidates.map((product) => {
    const recentEvents = events.filter((event) => event.productId === product.id && new Date(event.createdAt).getTime() >= cutoff);
    const views = recentEvents.filter((event) => event.type === 'product_view').length;
    const carts = recentEvents.filter((event) => event.type === 'add_to_cart').length;
    const eventPurchases = recentEvents
      .filter((event) => event.type === 'purchase')
      .reduce((sum, event) => sum + (event.quantity ?? 1), 0);
    const sold = sales30d.get(product.id)?.quantity ?? 0;
    const purchases = Math.max(sold, eventPurchases);
    return {
      product,
      sold,
      views,
      carts,
      purchases,
      conversion: views > 0 ? purchases / views : purchases > 0 ? 1 : 0,
      boostScore: options.boostScores?.get(product.id) ?? 0,
    };
  });

  const maxStock = Math.max(1, ...metricRows.map((row) => row.product.stock));
  const maxSales = Math.max(1, ...metricRows.map((row) => row.sold));
  const maxViews = Math.max(1, ...metricRows.map((row) => row.views));
  const maxCarts = Math.max(1, ...metricRows.map((row) => row.carts));
  const maxPurchases = Math.max(1, ...metricRows.map((row) => row.purchases));
  const maxBoost = Math.max(1, ...metricRows.map((row) => row.boostScore));

  const ranked = metricRows.map((row) => {
    const stockNorm = row.product.stock / maxStock;
    const salesNorm = row.sold / maxSales;
    const viewsNorm = row.views / maxViews;
    const cartsNorm = row.carts / maxCarts;
    const purchaseNorm = row.purchases / maxPurchases;
    const boostNorm = row.boostScore / maxBoost;
    let score = 0;
    let reason = '';

    switch (strategy) {
      case 'specific_product':
        score = 100;
        reason = `${row.product.name} was explicitly requested by the admin and has ${row.product.stock} ${row.product.unit} available.`;
        break;
      case 'highest_stock':
        score = stockNorm * 100;
        reason = `${row.product.name} has ${row.product.stock} ${row.product.unit} available, ranked by highest stock in the requested scope.`;
        break;
      case 'clearance':
        score = stockNorm * 55 + (1 - salesNorm) * 30 + (1 - Math.min(1, row.conversion)) * 15;
        reason = `${row.product.name} is a clearance candidate with ${row.product.stock} ${row.product.unit} available and ${row.sold} units sold in the last 30 days. No discount was assumed.`;
        break;
      case 'lowest_sales':
        score = (1 - salesNorm) * 70 + stockNorm * 30;
        reason = `${row.product.name} has ${row.sold} units sold in the last 30 days and ${row.product.stock} ${row.product.unit} available.`;
        break;
      case 'best_seller':
        score = salesNorm * 70 + purchaseNorm * 20 + viewsNorm * 10;
        reason = `${row.product.name} is ranked from ${row.sold} units sold in the last 30 days plus current engagement.`;
        break;
      case 'high_interest_low_conversion':
        score = viewsNorm * 55 + cartsNorm * 25 + (1 - Math.min(1, row.conversion)) * 20;
        reason = `${row.product.name} has ${row.views} views and ${row.carts} cart events with a ${Math.round(row.conversion * 100)}% observed conversion rate.`;
        break;
      case 'category_match':
        score = boostNorm * 70 + stockNorm * 30;
        reason = `${row.product.name} matches the requested ${row.product.category} category and has the strongest available boost signals in that category.`;
        break;
      case 'smart_boost':
      default:
        score = boostNorm * 80 + stockNorm * 20;
        reason = `${row.product.name} is the strongest smart-boost opportunity using current stock, sales, interest, and conversion signals.`;
        break;
    }

    return {
      productId: row.product.id,
      productName: row.product.name,
      category: row.product.category,
      price: row.product.price,
      stock: row.product.stock,
      unit: row.product.unit,
      sold30d: row.sold,
      views30d: row.views,
      carts30d: row.carts,
      purchases30d: row.purchases,
      conversionRate: round(row.conversion),
      boostScore: round(row.boostScore, 1),
      selectionScore: round(score, 1),
      selectionReason: reason,
    } satisfies ProductSelectionCandidate;
  }).sort((a, b) => b.selectionScore - a.selectionScore || b.stock - a.stock || a.productName.localeCompare(b.productName));

  const selected = ranked.slice(0, count);
  const scope = namedIds.length ? 'the explicitly named product' : category ?? 'all active products';
  const confidence = namedIds.length ? 0.99 : category ? 0.92 : strategy === 'smart_boost' ? 0.75 : 0.88;

  return {
    strategy,
    strategyLabel: strategyLabel(strategy),
    request,
    scope,
    criteriaSummary: criteriaSummary(strategy, scope),
    selectedProductIds: selected.map((item) => item.productId),
    rankedProducts: selected,
    confidence,
    noDiscountAssumed: strategy === 'clearance',
  };
}
