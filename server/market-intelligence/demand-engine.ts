import type { BuyerDemandSnapshot, StoreEvent } from '../types.js';
import type { SelectableProduct } from '../product-selection.js';

const DAY = 24 * 60 * 60 * 1000;

function count(events: StoreEvent[], type: StoreEvent['type']): number {
  return events.filter((event) => event.type === type).reduce((sum, event) => sum + (event.quantity ?? 1), 0);
}

function growth(current: number, previous: number): number {
  if (previous <= 0) return current > 0 ? 1 : 0;
  return Math.max(-1, Math.min(3, (current - previous) / previous));
}

export function buildBuyerDemandSnapshots(options: {
  products: SelectableProduct[];
  events: StoreEvent[];
  sales30d: Map<string, { quantity: number; revenue: number }>;
}): BuyerDemandSnapshot[] {
  const now = Date.now();
  const currentStart = now - 7 * DAY;
  const previousStart = now - 14 * DAY;

  return options.products.map((product) => {
    const productEvents = options.events.filter((event) => event.productId === product.id);
    const current = productEvents.filter((event) => new Date(event.createdAt).getTime() >= currentStart);
    const previous = productEvents.filter((event) => {
      const time = new Date(event.createdAt).getTime();
      return time >= previousStart && time < currentStart;
    });
    const views7d = count(current, 'product_view');
    const viewsPrevious7d = count(previous, 'product_view');
    const carts7d = count(current, 'add_to_cart');
    const cartsPrevious7d = count(previous, 'add_to_cart');
    const purchases7d = count(current, 'purchase');
    const purchasesPrevious7d = count(previous, 'purchase');
    const searches7d = count(current, 'search');
    const searchesPrevious7d = count(previous, 'search');
    const conversionRate7d = views7d > 0 ? Math.min(1, purchases7d / views7d) : purchases7d > 0 ? 1 : 0;
    const momentum = (
      growth(views7d, viewsPrevious7d) * 0.35
      + growth(carts7d, cartsPrevious7d) * 0.25
      + growth(purchases7d, purchasesPrevious7d) * 0.3
      + growth(searches7d, searchesPrevious7d) * 0.1
    );

    return {
      productId: product.id,
      views7d,
      viewsPrevious7d,
      carts7d,
      cartsPrevious7d,
      purchases7d,
      purchasesPrevious7d,
      searches7d,
      searchesPrevious7d,
      sold30d: options.sales30d.get(product.id)?.quantity ?? 0,
      conversionRate7d: Number(conversionRate7d.toFixed(3)),
      demandMomentum: Number(Math.max(-1, Math.min(2, momentum)).toFixed(3)),
      calculatedAt: new Date().toISOString(),
    };
  });
}
