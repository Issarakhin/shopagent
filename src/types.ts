export type CategoryName = 'Meats' | 'Fishes' | 'Fruits' | 'Sweets' | 'Handicrafts';

export interface Category {
  id: string;
  name: CategoryName;
  description: string;
  icon: string; // Lucide icon name
}

export interface Product {
  id: string;
  name: string;
  description: string;
  category: CategoryName;
  price: number;
  stock: number;
  imageUrl: string;
  unit: string; // e.g., "kg", "pcs", "pack", "item"
  status: 'active' | 'draft';
}

export interface OrderItem {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
}

export interface Order {
  id: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerAddress: string;
  items: OrderItem[];
  totalAmount: number;
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
  createdAt: string;
}

export interface CartItem {
  product: Product;
  quantity: number;
}

export interface SalesStats {
  totalRevenue: number;
  totalOrders: number;
  totalProducts: number;
  revenueByCategory: { category: string; amount: number }[];
  ordersOverTime: { date: string; orders: number; revenue: number }[];
  topProducts: { name: string; quantity: number; revenue: number }[];
}
