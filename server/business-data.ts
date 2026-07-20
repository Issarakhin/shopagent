import fs from 'fs';
import path from 'path';
import { INITIAL_PRODUCTS, INITIAL_CATEGORIES } from '../src/data.js';
import type { Category, Order, Product } from '../src/types.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const RESERVATIONS_FILE = path.join(DATA_DIR, 'inventory-reservations.json');
const BUDGET_FILE = path.join(DATA_DIR, 'budget.json');

export interface InventoryReservation {
  id: string;
  productId: string;
  quantity: number;
  workflowId: string;
  status: 'active' | 'released' | 'committed';
  createdAt: string;
  releasedAt?: string;
}

export interface BudgetState {
  currency: 'USD';
  monthlyLimit: number;
  reserved: number;
  spent: number;
  updatedAt: string;
}

function ensureFile(file: string, value: unknown) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

export function ensureBusinessData() {
  ensureFile(PRODUCTS_FILE, INITIAL_PRODUCTS);
  ensureFile(CATEGORIES_FILE, INITIAL_CATEGORIES);
  ensureFile(ORDERS_FILE, []);
  ensureFile(RESERVATIONS_FILE, []);
  ensureFile(BUDGET_FILE, {
    currency: 'USD',
    monthlyLimit: Number(process.env.MONTHLY_MARKETING_BUDGET ?? 1000),
    reserved: 0,
    spent: 0,
    updatedAt: new Date().toISOString(),
  } satisfies BudgetState);
}

function readJson<T>(file: string, fallback: T): T {
  ensureBusinessData();
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(file: string, value: T): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export const readProducts = (): Product[] => readJson<Product[]>(PRODUCTS_FILE, INITIAL_PRODUCTS);
export const writeProducts = (value: Product[]) => writeJson(PRODUCTS_FILE, value);
export const readCategories = (): Category[] => readJson<Category[]>(CATEGORIES_FILE, INITIAL_CATEGORIES);
export const readOrders = (): Order[] => readJson<Order[]>(ORDERS_FILE, []);
export const writeOrders = (value: Order[]) => writeJson(ORDERS_FILE, value);
export const readReservations = (): InventoryReservation[] => readJson<InventoryReservation[]>(RESERVATIONS_FILE, []);
export const writeReservations = (value: InventoryReservation[]) => writeJson(RESERVATIONS_FILE, value);
export const readBudget = (): BudgetState => readJson<BudgetState>(BUDGET_FILE, {
  currency: 'USD', monthlyLimit: 1000, reserved: 0, spent: 0, updatedAt: new Date().toISOString(),
});
export const writeBudget = (value: BudgetState) => writeJson(BUDGET_FILE, value);

export function paidLikeOrders(): Order[] {
  return readOrders().filter((order) => ['processing', 'shipped', 'delivered'].includes(order.status));
}

export function productSalesMap(days = 30): Map<string, { quantity: number; revenue: number }> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const map = new Map<string, { quantity: number; revenue: number }>();
  for (const order of paidLikeOrders()) {
    const created = new Date(order.createdAt).getTime();
    if (Number.isFinite(created) && created < cutoff) continue;
    for (const item of order.items) {
      const current = map.get(item.productId) ?? { quantity: 0, revenue: 0 };
      current.quantity += item.quantity;
      current.revenue += item.price * item.quantity;
      map.set(item.productId, current);
    }
  }
  return map;
}

export function reservedQuantity(productId: string): number {
  return readReservations()
    .filter((item) => item.productId === productId && item.status === 'active')
    .reduce((sum, item) => sum + item.quantity, 0);
}

export function availableToPromise(product: Product): number {
  return Math.max(0, product.stock - reservedQuantity(product.id));
}
