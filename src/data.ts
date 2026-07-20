import { Category, Product } from './types';

export const INITIAL_CATEGORIES: Category[] = [
  { id: 'cat_meats', name: 'Meats', description: 'Fresh Cambodian beef, pork, chicken, and locally prepared meat products.', icon: 'Beef' },
  { id: 'cat_fishes', name: 'Fishes', description: 'Freshwater fish, prawns, and seafood commonly enjoyed across Cambodia.', icon: 'Fish' },
  { id: 'cat_fruits', name: 'Fruits', description: 'Seasonal Cambodian fruit sourced from local farms and provinces.', icon: 'Apple' },
  { id: 'cat_sweets', name: 'Sweets', description: 'Traditional Cambodian desserts, snacks, and locally made treats.', icon: 'Cake' },
  { id: 'cat_handicrafts', name: 'Handicrafts', description: 'Handwoven silk, ceramics, palm-leaf goods, and artisan products from Cambodia.', icon: 'Sparkles' }
];

export const INITIAL_PRODUCTS: Product[] = [
  {
    id: 'prod_m1', name: 'Cambodian Beef Lok Lak Cut',
    description: 'Tender beef pieces prepared for Cambodian lok lak, stir-frying, or grilling.',
    category: 'Meats', price: 12.50, stock: 25,
    imageUrl: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=600&auto=format&fit=crop&q=80', unit: 'kg', status: 'active'
  },
  {
    id: 'prod_m2', name: 'Free-Range Cambodian Chicken',
    description: 'Locally raised chicken suitable for soups, grilling, and traditional Khmer dishes.',
    category: 'Meats', price: 7.50, stock: 40,
    imageUrl: 'https://images.unsplash.com/photo-1604503468506-a8da13d82791?w=600&auto=format&fit=crop&q=80', unit: 'kg', status: 'active'
  },
  {
    id: 'prod_m3', name: 'Khmer Lemongrass Pork',
    description: 'Fresh pork prepared for marinating with lemongrass, garlic, and Khmer spices.',
    category: 'Meats', price: 8.75, stock: 15,
    imageUrl: 'https://images.unsplash.com/photo-1524438422290-6878e1f41d4d?w=600&auto=format&fit=crop&q=80', unit: 'kg', status: 'active'
  },
  {
    id: 'prod_f1', name: 'Tonle Sap Fish Fillet',
    description: 'Fresh freshwater fish fillet ideal for steaming, frying, or traditional Khmer soups.',
    category: 'Fishes', price: 8.99, stock: 20,
    imageUrl: 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=600&auto=format&fit=crop&q=80', unit: 'kg', status: 'active'
  },
  {
    id: 'prod_f2', name: 'Fresh Kampot Prawns',
    description: 'Fresh prawns suitable for grilling, stir-frying, and seafood dishes.',
    category: 'Fishes', price: 11.50, stock: 35,
    imageUrl: 'https://images.unsplash.com/photo-1559737605-de6a7ce93a46?w=600&auto=format&fit=crop&q=80', unit: 'pack', status: 'active'
  },
  {
    id: 'prod_f3', name: 'Whole Mekong River Fish',
    description: 'Cleaned whole freshwater fish with mild flavor and firm meat.',
    category: 'Fishes', price: 6.75, stock: 12,
    imageUrl: 'https://images.unsplash.com/photo-1534604973900-c43ab4c2e0ab?w=600&auto=format&fit=crop&q=80', unit: 'pcs', status: 'active'
  },
  {
    id: 'prod_fr1', name: 'Kampot Durian',
    description: 'Rich and aromatic seasonal durian sourced from Kampot province.',
    category: 'Fruits', price: 9.50, stock: 30,
    imageUrl: 'https://images.unsplash.com/photo-1550828520-4cb496926fc9?w=600&auto=format&fit=crop&q=80', unit: 'kg', status: 'active'
  },
  {
    id: 'prod_fr2', name: 'Battambang Oranges',
    description: 'Juicy Cambodian oranges sourced from farms in Battambang.',
    category: 'Fruits', price: 3.25, stock: 80,
    imageUrl: 'https://images.unsplash.com/photo-1547514701-42782101795e?w=600&auto=format&fit=crop&q=80', unit: 'kg', status: 'active'
  },
  {
    id: 'prod_fr3', name: 'Keo Romeat Mangoes',
    description: 'Popular Cambodian mangoes with a fragrant aroma and naturally sweet flavor.',
    category: 'Fruits', price: 3.99, stock: 45,
    imageUrl: 'https://images.unsplash.com/photo-1553279768-865429fa0078?w=600&auto=format&fit=crop&q=80', unit: 'kg', status: 'active'
  },
  {
    id: 'prod_s1', name: 'Num Ansom Chek',
    description: 'Traditional sticky-rice banana cake wrapped in banana leaves.',
    category: 'Sweets', price: 2.50, stock: 30,
    imageUrl: 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=600&auto=format&fit=crop&q=80', unit: 'pack', status: 'active'
  },
  {
    id: 'prod_s2', name: 'Palm Sugar Cookies',
    description: 'Locally made cookies sweetened with Cambodian palm sugar.',
    category: 'Sweets', price: 4.50, stock: 28,
    imageUrl: 'https://images.unsplash.com/photo-1499636136210-6f4ee915583e?w=600&auto=format&fit=crop&q=80', unit: 'box', status: 'active'
  },
  {
    id: 'prod_s3', name: 'Khmer Coconut Rice Cakes',
    description: 'Soft rice cakes with coconut flavor inspired by traditional Cambodian desserts.',
    category: 'Sweets', price: 3.75, stock: 22,
    imageUrl: 'https://images.unsplash.com/photo-1551024601-bec78aea704b?w=600&auto=format&fit=crop&q=80', unit: 'pack', status: 'active'
  },
  {
    id: 'prod_h1', name: 'Kampong Chhnang Pottery',
    description: 'Handmade Cambodian ceramic pottery produced by local artisans.',
    category: 'Handicrafts', price: 18.50, stock: 15,
    imageUrl: 'https://images.unsplash.com/photo-1610701596007-11502861dcfa?w=600&auto=format&fit=crop&q=80', unit: 'pcs', status: 'active'
  },
  {
    id: 'prod_h2', name: 'Cambodian Krama Scarf',
    description: 'Traditional handwoven Cambodian krama suitable for everyday use or gifting.',
    category: 'Handicrafts', price: 12.00, stock: 30,
    imageUrl: 'https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=600&auto=format&fit=crop&q=80', unit: 'pcs', status: 'active'
  },
  {
    id: 'prod_h3', name: 'Palm-Leaf Storage Basket',
    description: 'Handwoven storage basket made from locally sourced palm leaves.',
    category: 'Handicrafts', price: 14.99, stock: 25,
    imageUrl: 'https://images.unsplash.com/photo-1610701596007-11502861dcfa?w=600&auto=format&fit=crop&q=80', unit: 'pcs', status: 'active'
  }
];
