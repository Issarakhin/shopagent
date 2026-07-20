import React, { useState, useEffect } from 'react';
import * as Icons from 'lucide-react';
import {
  Plus, Edit, Trash2, Save, X, TrendingUp, Coins, Package, Clock, Eye, Check, RefreshCw, 
  Layers, Search, SlidersHorizontal, Image, ChevronRight, CheckSquare, Sparkles, FileText
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, 
  BarChart, Bar, Cell, PieChart, Pie, Legend
} from 'recharts';
import { Product, Category, Order, SalesStats, CategoryName } from '../types';
import { db } from '../firebase';
import { doc, setDoc, deleteDoc, runTransaction } from 'firebase/firestore';
import AgentAdminCenter from './AgentAdminCenter';

// Self-contained high-quality HTML5 canvas image resizing and compression helper
const compressImage = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = document.createElement('img');
      img.src = event.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 400;
        const MAX_HEIGHT = 400;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        resolve(dataUrl);
      };
      img.onerror = (err) => reject(err);
    };
    reader.onerror = (err) => reject(err);
  });
};

interface AdminDashboardProps {
  products: Product[];
  categories: Category[];
  orders: Order[];
  stats: SalesStats | null;
  onRefreshData: () => void;
  onShowNotification: (message: string, type: 'success' | 'error' | 'warning') => void;
}

export default function AdminDashboard({
  products,
  categories,
  orders,
  stats,
  onRefreshData,
  onShowNotification
}: AdminDashboardProps) {
  const [activeTab, setActiveTab] = useState<'agent' | 'analytics' | 'inventory' | 'orders' | 'categories'>('agent');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Search & Filter for Inventory
  const [inventorySearch, setInventorySearch] = useState('');
  const [inventoryCategory, setInventoryCategory] = useState('all');

  // New Product Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProductName, setNewProductName] = useState('');
  const [newProductCategory, setNewProductCategory] = useState<CategoryName>('Meats');
  const [newProductDescription, setNewProductDescription] = useState('');
  const [newProductPrice, setNewProductPrice] = useState('');
  const [newProductStock, setNewProductStock] = useState('');
  const [newProductImageUrl, setNewProductImageUrl] = useState('');
  const [newProductUnit, setNewProductUnit] = useState('kg');
  const [newProductStatus, setNewProductStatus] = useState<'active' | 'draft'>('active');

  // Edit Product State
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  // New Category Form State
  const [showCatForm, setShowCatForm] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [newCatDescription, setNewCatDescription] = useState('');
  const [newCatIcon, setNewCatIcon] = useState('Sparkles');

  // Manual trigger to pull fresh metrics from Express
  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    await onRefreshData();
    setIsRefreshing(false);
    onShowNotification('Dashboard data synced with server.', 'success');
  };

  // Create Product Submit Handler
  const handleAddProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProductName || !newProductPrice || !newProductStock) {
      onShowNotification('Please fill in Name, Price, and Stock level.', 'warning');
      return;
    }

    try {
      const prodId = `prod_${Date.now()}`;
      const newProduct: Product = {
        id: prodId,
        name: newProductName,
        description: newProductDescription,
        category: newProductCategory,
        price: Number(newProductPrice),
        stock: Number(newProductStock),
        imageUrl: newProductImageUrl || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&auto=format&fit=crop&q=80',
        unit: newProductUnit,
        status: newProductStatus
      };

      await setDoc(doc(db, 'products', prodId), newProduct);

      onShowNotification(`Product "${newProductName}" added successfully!`, 'success');
      onRefreshData();

      // Reset Form fields
      setNewProductName('');
      setNewProductDescription('');
      setNewProductPrice('');
      setNewProductStock('');
      setNewProductImageUrl('');
      setNewProductUnit('kg');
      setNewProductStatus('active');
      setShowAddForm(false);
    } catch (err: any) {
      onShowNotification(err.message || 'Failed to create product.', 'error');
    }
  };

  // Edit Product Form Handler
  const handleEditProductSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProduct) return;

    try {
      await setDoc(doc(db, 'products', editingProduct.id), editingProduct);

      onShowNotification(`Product updated successfully!`, 'success');
      setEditingProduct(null);
      onRefreshData();
    } catch (err: any) {
      onShowNotification(err.message || 'Failed to update product.', 'error');
    }
  };

  // Delete Product Handler
  const handleDeleteProduct = async (productId: string, productName: string) => {
    if (!window.confirm(`Are you sure you want to delete "${productName}" from the catalog?`)) {
      return;
    }

    try {
      await deleteDoc(doc(db, 'products', productId));

      onShowNotification('Product removed from database.', 'success');
      onRefreshData();
    } catch (err: any) {
      onShowNotification(err.message || 'Failed to delete product.', 'error');
    }
  };

  // Update Order Status Handler (Cancelling order restocks products, restoring order checks stock and deducts)
  const handleUpdateOrderStatus = async (orderId: string, newStatus: string) => {
    try {
      await runTransaction(db, async (transaction) => {
        const orderRef = doc(db, 'orders', orderId);
        const orderDoc = await transaction.get(orderRef);

        if (!orderDoc.exists()) {
          throw new Error('Order not found.');
        }

        const oldStatus = orderDoc.data().status;
        const items = orderDoc.data().items || [];

        // If status is changed to cancelled, restock products
        if (newStatus === 'cancelled' && oldStatus !== 'cancelled') {
          for (const item of items) {
            const productRef = doc(db, 'products', item.productId);
            const productDoc = await transaction.get(productRef);
            if (productDoc.exists()) {
              const currentStock = productDoc.data().stock || 0;
              transaction.update(productRef, { stock: currentStock + item.quantity });
            }
          }
        } 
        // If restoring a cancelled order, check and deduct stock
        else if (oldStatus === 'cancelled' && newStatus !== 'cancelled') {
          for (const item of items) {
            const productRef = doc(db, 'products', item.productId);
            const productDoc = await transaction.get(productRef);
            if (productDoc.exists()) {
              const currentStock = productDoc.data().stock || 0;
              if (currentStock < item.quantity) {
                throw new Error(`Insufficient stock to restore order for "${item.productName}".`);
              }
              transaction.update(productRef, { stock: currentStock - item.quantity });
            }
          }
        }

        transaction.update(orderRef, { status: newStatus });
      });

      onShowNotification(`Order #${orderId.slice(-6)} updated to "${newStatus}"`, 'success');
      onRefreshData();
    } catch (err: any) {
      onShowNotification(err.message || 'Failed to update status.', 'error');
    }
  };

  // Create Category Handler
  const handleAddCategorySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatName) return;

    try {
      const catId = `cat_${Date.now()}`;
      const newCategory: Category = {
        id: catId,
        name: newCatName as any,
        description: newCatDescription,
        icon: newCatIcon
      };

      await setDoc(doc(db, 'categories', catId), newCategory);

      onShowNotification(`Category "${newCatName}" added successfully.`, 'success');
      setNewCatName('');
      setNewCatDescription('');
      setNewCatIcon('Sparkles');
      setShowCatForm(false);
      onRefreshData();
    } catch (err: any) {
      onShowNotification(err.message || 'Failed to add category.', 'error');
    }
  };

  // Filter products for inventory management view
  const filteredInventory = products.filter(product => {
    const matchesSearch = product.name.toLowerCase().includes(inventorySearch.toLowerCase()) || 
                          product.category.toLowerCase().includes(inventorySearch.toLowerCase()) ||
                          product.id.includes(inventorySearch);
    const matchesCategory = inventoryCategory === 'all' || product.category.toLowerCase() === inventoryCategory.toLowerCase();
    return matchesSearch && matchesCategory;
  });

  // Color mapping for Pie Charts / Category breakdown
  const COLORS = ['#059669', '#0d9488', '#0284c7', '#7c3aed', '#db2777', '#ea580c', '#ca8a04'];

  return (
    <div className="py-8">
      
      {/* Admin Title Area */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <h2 className="font-sans font-extrabold text-2xl tracking-tight text-gray-900">
            Control Dashboard
          </h2>
          <p className="text-sm text-gray-500 leading-relaxed font-sans">
            Oversee real-time storefront sales, inventory stocking, custom categories, and order processing workflows.
          </p>
        </div>

        <button
          onClick={handleManualRefresh}
          disabled={isRefreshing}
          className="self-start sm:self-auto flex items-center space-x-2 bg-white text-gray-700 border border-gray-200 px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-gray-50 active:scale-95 transition-all shadow-2xs cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          <span>Sync Live Database</span>
        </button>
      </div>

      {/* Analytics Card Deck (Always Displayed at the Top) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
        {/* Metric 1: Total Revenue */}
        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-3xs flex items-center space-x-4">
          <div className="p-3.5 bg-emerald-50 text-emerald-600 rounded-xl">
            <Coins className="w-5 h-5" />
          </div>
          <div>
            <span className="text-xs font-mono text-gray-400 uppercase tracking-wider block">Total Sales</span>
            <span className="text-2xl font-bold font-mono text-gray-900">${stats?.totalRevenue?.toFixed(2) || '0.00'}</span>
          </div>
        </div>

        {/* Metric 2: Total Orders */}
        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-3xs flex items-center space-x-4">
          <div className="p-3.5 bg-teal-50 text-teal-600 rounded-xl">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div>
            <span className="text-xs font-mono text-gray-400 uppercase tracking-wider block">Completed Orders</span>
            <span className="text-2xl font-bold font-mono text-gray-900">{stats?.totalOrders || 0}</span>
          </div>
        </div>

        {/* Metric 3: Active Catalog */}
        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-3xs flex items-center space-x-4">
          <div className="p-3.5 bg-blue-50 text-blue-600 rounded-xl">
            <Package className="w-5 h-5" />
          </div>
          <div>
            <span className="text-xs font-mono text-gray-400 uppercase tracking-wider block">Product Models</span>
            <span className="text-2xl font-bold font-mono text-gray-900">{stats?.totalProducts || 0} items</span>
          </div>
        </div>

        {/* Metric 4: Pending Fullfillment */}
        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-3xs flex items-center space-x-4">
          <div className="p-3.5 bg-amber-50 text-amber-600 rounded-xl">
            <Clock className="w-5 h-5" />
          </div>
          <div>
            <span className="text-xs font-mono text-gray-400 uppercase tracking-wider block">Pending Fulfillment</span>
            <span className="text-2xl font-bold font-mono text-gray-900">
              {orders.filter(o => o.status === 'pending' || o.status === 'processing').length} orders
            </span>
          </div>
        </div>
      </div>

      {/* Admin Tabs */}
      <div className="border-b border-gray-200 mb-8 flex overflow-x-auto whitespace-nowrap">
        <button
          onClick={() => setActiveTab('agent')}
          className={`pb-3.5 px-4 font-semibold text-sm transition-all relative border-b-2 cursor-pointer ${
            activeTab === 'agent'
              ? 'text-emerald-700 border-emerald-600'
              : 'text-gray-500 hover:text-gray-900 border-transparent'
          }`}
        >
          Main Agent & Skills
        </button>
        <button
          onClick={() => setActiveTab('analytics')}
          className={`pb-3.5 px-4 font-semibold text-sm transition-all relative border-b-2 cursor-pointer ${
            activeTab === 'analytics'
              ? 'text-emerald-700 border-emerald-600'
              : 'text-gray-500 hover:text-gray-900 border-transparent'
          }`}
        >
          Sales & Analytics
        </button>
        <button
          onClick={() => setActiveTab('inventory')}
          className={`pb-3.5 px-4 font-semibold text-sm transition-all relative border-b-2 cursor-pointer ${
            activeTab === 'inventory'
              ? 'text-emerald-700 border-emerald-600'
              : 'text-gray-500 hover:text-gray-900 border-transparent'
          }`}
        >
          Product Catalog ({products.length})
        </button>
        <button
          onClick={() => setActiveTab('orders')}
          className={`pb-3.5 px-4 font-semibold text-sm transition-all relative border-b-2 cursor-pointer ${
            activeTab === 'orders'
              ? 'text-emerald-700 border-emerald-600'
              : 'text-gray-500 hover:text-gray-900 border-transparent'
          }`}
        >
          Fulfillment Orders ({orders.length})
        </button>
        <button
          onClick={() => setActiveTab('categories')}
          className={`pb-3.5 px-4 font-semibold text-sm transition-all relative border-b-2 cursor-pointer ${
            activeTab === 'categories'
              ? 'text-emerald-700 border-emerald-600'
              : 'text-gray-500 hover:text-gray-900 border-transparent'
          }`}
        >
          Department Categories ({categories.length})
        </button>
      </div>

      {/* TAB CONTENT: MAIN AGENT AND SKILLS */}
      {activeTab === 'agent' && (
        <AgentAdminCenter products={products} onShowNotification={onShowNotification} />
      )}

      {/* TAB CONTENT: ANALYTICS */}
      {activeTab === 'analytics' && (
        <div className="space-y-8">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            {/* Chart 1: Revenue & Order Over Time */}
            <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-3xs lg:col-span-2">
              <h4 className="font-sans font-bold text-gray-900 text-sm mb-1.5 flex items-center space-x-1.5">
                <span>Revenue Performance Over Time</span>
              </h4>
              <p className="text-xs text-gray-400 mb-6 font-sans">
                Daily volume of sales and order completions recorded on the server database.
              </p>
              
              <div className="w-full h-72">
                {stats && stats.ordersOverTime.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={stats.ordersOverTime} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.2}/>
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="date" stroke="#94a3b8" fontSize={10} tickLine={false} />
                      <YAxis stroke="#94a3b8" fontSize={10} tickLine={false} />
                      <Tooltip contentStyle={{ fontSize: '11px', borderRadius: '12px', border: '1px solid #f1f5f9' }} />
                      <Area type="monotone" dataKey="revenue" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorRevenue)" name="Revenue ($)" />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">
                    No timeline tracking data found. Try creating an order.
                  </div>
                )}
              </div>
            </div>

            {/* Chart 2: Category Breakdown */}
            <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-3xs">
              <h4 className="font-sans font-bold text-gray-900 text-sm mb-1.5 flex items-center space-x-1.5">
                <span>Sales Revenue By Department</span>
              </h4>
              <p className="text-xs text-gray-400 mb-6 font-sans">
                Financial share across Meats, Fishes, Fruits, Sweets, and Handicrafts.
              </p>

              <div className="w-full h-64 flex flex-col justify-center">
                {stats && stats.revenueByCategory.some(c => c.amount > 0) ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={stats.revenueByCategory}
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={80}
                        paddingAngle={4}
                        dataKey="amount"
                        nameKey="category"
                      >
                        {stats.revenueByCategory.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => `$${value}`} contentStyle={{ fontSize: '11px', borderRadius: '12px' }} />
                      <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: '10px' }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="text-center py-12 text-sm text-gray-400">
                    No department metrics registered yet. Place an order to generate analytics.
                  </div>
                )}
              </div>
            </div>

          </div>

          {/* Table: Top Products & Customer logs */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            
            {/* Top Products */}
            <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-3xs">
              <h4 className="font-sans font-bold text-gray-900 text-sm mb-3">
                Top Selling Products
              </h4>
              {stats && stats.topProducts.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead>
                      <tr className="border-b border-gray-100 text-gray-400 text-xs font-semibold font-mono uppercase tracking-wider">
                        <th className="pb-3 font-normal">Product Name</th>
                        <th className="pb-3 text-right font-normal">Quantity Sold</th>
                        <th className="pb-3 text-right font-normal">Revenue</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {stats.topProducts.map((p, idx) => (
                        <tr key={idx} className="hover:bg-gray-50/50">
                          <td className="py-3 font-medium text-gray-800">{p.name}</td>
                          <td className="py-3 text-right text-gray-500">{p.quantity} units</td>
                          <td className="py-3 text-right font-semibold font-mono text-gray-900">${p.revenue.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-center text-sm text-gray-400 py-12">
                  No products have been sold yet.
                </p>
              )}
            </div>

            {/* Quick Customer Feed */}
            <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-3xs">
              <h4 className="font-sans font-bold text-gray-900 text-sm mb-3">
                Recent Customer Feed
              </h4>
              {orders.length > 0 ? (
                <div className="space-y-4">
                  {orders.slice(-4).reverse().map(order => (
                    <div key={order.id} className="flex justify-between items-center bg-gray-50 p-3 rounded-xl border border-gray-100">
                      <div className="flex items-center space-x-3">
                        <div className="h-9 w-9 bg-emerald-100 text-emerald-800 rounded-full flex items-center justify-center font-bold text-sm">
                          {order.customerName.charAt(0)}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-gray-800">{order.customerName}</p>
                          <p className="text-xs text-gray-400">{order.customerEmail}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold font-mono text-gray-900">${order.totalAmount.toFixed(2)}</p>
                        <p className="text-[10px] font-mono text-gray-400">{new Date(order.createdAt).toLocaleDateString()}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-sm text-gray-400 py-12">
                  No recent customers recorded.
                </p>
              )}
            </div>

          </div>
        </div>
      )}

      {/* TAB CONTENT: INVENTORY */}
      {activeTab === 'inventory' && (
        <div className="space-y-6">
          
          {/* Inventory Controls */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-4 rounded-xl border border-gray-100 shadow-3xs">
            <div className="flex flex-1 flex-col sm:flex-row gap-3">
              {/* Search */}
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
                <input
                  type="text"
                  placeholder="Filter inventory..."
                  value={inventorySearch}
                  onChange={(e) => setInventorySearch(e.target.value)}
                  className="w-full pl-9 pr-4 py-2 bg-gray-50 text-xs border border-gray-100 rounded-lg outline-hidden focus:ring-2 focus:ring-emerald-500/20 text-gray-800 focus:bg-white"
                />
              </div>

              {/* Department Filter */}
              <select
                value={inventoryCategory}
                onChange={(e) => setInventoryCategory(e.target.value)}
                className="bg-white border border-gray-200 text-xs rounded-lg px-3 py-2 text-gray-700 outline-hidden"
              >
                <option value="all">All Departments</option>
                {categories.map(c => (
                  <option key={c.id} value={c.name}>{c.name}</option>
                ))}
              </select>
            </div>

            {/* Add product button */}
            <button
              onClick={() => {
                setEditingProduct(null);
                setShowAddForm(!showAddForm);
              }}
              className="inline-flex items-center space-x-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-4 py-2.5 rounded-lg font-bold transition-all shadow-xs cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Add New Product</span>
            </button>
          </div>

          {/* Add Product Drawer/Form */}
          {showAddForm && (
            <form onSubmit={handleAddProduct} className="bg-white p-6 rounded-2xl border border-emerald-100 shadow-xs space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-gray-100">
                <h4 className="font-sans font-bold text-gray-950 text-sm flex items-center space-x-1.5">
                  <Sparkles className="w-4.5 h-4.5 text-emerald-600" />
                  <span>Create Product Model</span>
                </h4>
                <button type="button" onClick={() => setShowAddForm(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {/* Name */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Product Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Dry Aged Ribeye"
                    value={newProductName}
                    onChange={(e) => setNewProductName(e.target.value)}
                    className="w-full text-xs border border-gray-200 rounded-lg p-2 text-gray-800 outline-hidden focus:ring-2 focus:ring-emerald-500/10"
                  />
                </div>

                {/* Category */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Category / Dept *</label>
                  <select
                    value={newProductCategory}
                    onChange={(e) => setNewProductCategory(e.target.value as CategoryName)}
                    className="w-full text-xs border border-gray-200 rounded-lg p-2 text-gray-800 outline-hidden"
                  >
                    {categories.map(c => (
                      <option key={c.id} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                </div>

                {/* Price */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ($) *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    placeholder="e.g. 19.99"
                    value={newProductPrice}
                    onChange={(e) => setNewProductPrice(e.target.value)}
                    className="w-full text-xs border border-gray-200 rounded-lg p-2 text-gray-800 outline-hidden focus:ring-2 focus:ring-emerald-500/10"
                  />
                </div>

                {/* Stock */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Stock Level *</label>
                  <input
                    type="number"
                    min="0"
                    required
                    placeholder="e.g. 50"
                    value={newProductStock}
                    onChange={(e) => setNewProductStock(e.target.value)}
                    className="w-full text-xs border border-gray-200 rounded-lg p-2 text-gray-800 outline-hidden focus:ring-2 focus:ring-emerald-500/10"
                  />
                </div>

                {/* Unit */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Sale Unit *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. kg, box, pcs"
                    value={newProductUnit}
                    onChange={(e) => setNewProductUnit(e.target.value)}
                    className="w-full text-xs border border-gray-200 rounded-lg p-2 text-gray-800 outline-hidden"
                  />
                </div>

                {/* Image URL & Local Upload */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Product Image (URL or Local File)</label>
                  <div className="flex gap-2">
                    <input
                      type="url"
                      placeholder="https://images.unsplash.com/..."
                      value={newProductImageUrl}
                      onChange={(e) => setNewProductImageUrl(e.target.value)}
                      className="flex-1 text-xs border border-gray-200 rounded-lg p-2 text-gray-800 outline-hidden focus:ring-2 focus:ring-emerald-500/10"
                    />
                    <label className="flex items-center justify-center bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer transition-all border border-gray-200 shrink-0">
                      <span>Upload</span>
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            try {
                              const base64 = await compressImage(file);
                              setNewProductImageUrl(base64);
                              onShowNotification('Image uploaded and processed!', 'success');
                            } catch (err) {
                              onShowNotification('Failed to process image.', 'error');
                            }
                          }
                        }}
                      />
                    </label>
                  </div>
                  {newProductImageUrl && (
                    <div className="mt-2 relative inline-block">
                      <img src={newProductImageUrl} alt="Preview" className="h-14 w-14 object-cover rounded-md border border-gray-100" />
                      <button
                        type="button"
                        onClick={() => setNewProductImageUrl('')}
                        className="absolute -top-1 -right-1 bg-red-500 text-white p-0.5 rounded-full hover:bg-red-600 shadow-xs cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Product Description</label>
                <textarea
                  rows={2}
                  placeholder="Detailed description of premium features..."
                  value={newProductDescription}
                  onChange={(e) => setNewProductDescription(e.target.value)}
                  className="w-full text-xs border border-gray-200 rounded-lg p-2 text-gray-800 outline-hidden focus:ring-2 focus:ring-emerald-500/10 resize-none"
                />
              </div>

              {/* Draft toggle and submit */}
              <div className="flex items-center justify-between pt-3 border-t border-gray-100">
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="is-draft-check"
                    checked={newProductStatus === 'draft'}
                    onChange={(e) => setNewProductStatus(e.target.checked ? 'draft' : 'active')}
                    className="rounded-sm text-emerald-600 focus:ring-emerald-500/10 h-4 w-4"
                  />
                  <label htmlFor="is-draft-check" className="text-xs font-medium text-gray-600 cursor-pointer">
                    Save as Draft (Hide from storefront)
                  </label>
                </div>

                <div className="flex space-x-3">
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="px-4 py-2 border border-gray-200 text-gray-500 rounded-lg text-xs font-semibold hover:bg-gray-50 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-all cursor-pointer"
                  >
                    Add to Database
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Edit Product Inline Card */}
          {editingProduct && (
            <form onSubmit={handleEditProductSubmit} className="bg-amber-50/50 p-6 rounded-2xl border border-amber-200/60 shadow-xs space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-amber-200/50">
                <h4 className="font-sans font-bold text-amber-900 text-sm flex items-center space-x-1.5">
                  <Edit className="w-4.5 h-4.5" />
                  <span>Edit Product: {editingProduct.name}</span>
                </h4>
                <button type="button" onClick={() => setEditingProduct(null)} className="text-amber-800 hover:text-amber-950">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {/* Name */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Product Name</label>
                  <input
                    type="text"
                    required
                    value={editingProduct.name}
                    onChange={(e) => setEditingProduct({ ...editingProduct, name: e.target.value })}
                    className="w-full text-xs border border-gray-200 bg-white rounded-lg p-2 text-gray-800 outline-hidden"
                  />
                </div>

                {/* Category */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Category</label>
                  <select
                    value={editingProduct.category}
                    onChange={(e) => setEditingProduct({ ...editingProduct, category: e.target.value as CategoryName })}
                    className="w-full text-xs border border-gray-200 bg-white rounded-lg p-2 text-gray-800 outline-hidden"
                  >
                    {categories.map(c => (
                      <option key={c.id} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                </div>

                {/* Price */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={editingProduct.price}
                    onChange={(e) => setEditingProduct({ ...editingProduct, price: Number(e.target.value) })}
                    className="w-full text-xs border border-gray-200 bg-white rounded-lg p-2 text-gray-800 outline-hidden"
                  />
                </div>

                {/* Stock */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Stock Level</label>
                  <input
                    type="number"
                    required
                    value={editingProduct.stock}
                    onChange={(e) => setEditingProduct({ ...editingProduct, stock: Number(e.target.value) })}
                    className="w-full text-xs border border-gray-200 bg-white rounded-lg p-2 text-gray-800 outline-hidden"
                  />
                </div>

                {/* Unit */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Sale Unit</label>
                  <input
                    type="text"
                    required
                    value={editingProduct.unit}
                    onChange={(e) => setEditingProduct({ ...editingProduct, unit: e.target.value })}
                    className="w-full text-xs border border-gray-200 bg-white rounded-lg p-2 text-gray-800 outline-hidden"
                  />
                </div>

                {/* Status */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
                  <select
                    value={editingProduct.status}
                    onChange={(e) => setEditingProduct({ ...editingProduct, status: e.target.value as 'active' | 'draft' })}
                    className="w-full text-xs border border-gray-200 bg-white rounded-lg p-2 text-gray-800 outline-hidden"
                  >
                    <option value="active">Active (Visible)</option>
                    <option value="draft">Draft (Hidden)</option>
                  </select>
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Product Description</label>
                <textarea
                  rows={2}
                  value={editingProduct.description}
                  onChange={(e) => setEditingProduct({ ...editingProduct, description: e.target.value })}
                  className="w-full text-xs border border-gray-200 bg-white rounded-lg p-2 text-gray-800 outline-hidden resize-none"
                />
              </div>

              {/* Image URL & Local Upload */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Product Image (URL or Local File)</label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={editingProduct.imageUrl}
                    onChange={(e) => setEditingProduct({ ...editingProduct, imageUrl: e.target.value })}
                    className="flex-1 text-xs border border-gray-200 bg-white rounded-lg p-2 text-gray-800 outline-hidden"
                  />
                  <label className="flex items-center justify-center bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer transition-all border border-gray-200 shrink-0">
                    <span>Upload</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          try {
                            const base64 = await compressImage(file);
                            setEditingProduct({ ...editingProduct, imageUrl: base64 });
                            onShowNotification('Image uploaded and processed!', 'success');
                          } catch (err) {
                            onShowNotification('Failed to process image.', 'error');
                          }
                        }
                      }}
                    />
                  </label>
                </div>
                {editingProduct.imageUrl && (
                  <div className="mt-2 relative inline-block">
                    <img src={editingProduct.imageUrl} alt="Preview" className="h-14 w-14 object-cover rounded-md border border-gray-100" />
                    <button
                      type="button"
                      onClick={() => setEditingProduct({ ...editingProduct, imageUrl: '' })}
                      className="absolute -top-1 -right-1 bg-red-500 text-white p-0.5 rounded-full hover:bg-red-600 shadow-xs cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>

              <div className="flex justify-end space-x-3 pt-3 border-t border-amber-200/50">
                <button
                  type="button"
                  onClick={() => setEditingProduct(null)}
                  className="px-4 py-2 border border-gray-200 text-gray-500 rounded-lg text-xs font-semibold hover:bg-gray-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold transition-all cursor-pointer"
                >
                  Commit Updates
                </button>
              </div>
            </form>
          )}

          {/* Inventory Table Container */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-3xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-gray-50/75 border-b border-gray-100 text-gray-400 text-xs font-semibold font-mono uppercase tracking-wider">
                    <th className="py-4 px-6 font-normal">Reference ID</th>
                    <th className="py-4 px-6 font-normal">Product Model</th>
                    <th className="py-4 px-6 font-normal">Department</th>
                    <th className="py-4 px-6 font-normal">Pricing</th>
                    <th className="py-4 px-6 font-normal">Available Stock</th>
                    <th className="py-4 px-6 font-normal text-center">Status</th>
                    <th className="py-4 px-6 font-normal text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filteredInventory.map(product => {
                    const isOutOfStock = product.stock === 0;
                    const isLowStock = product.stock > 0 && product.stock <= 5;

                    return (
                      <tr key={product.id} className="hover:bg-gray-50/50 transition-colors">
                        {/* ID */}
                        <td className="py-4 px-6 font-mono text-xs text-gray-400">
                          #{product.id.slice(-6)}
                        </td>

                        {/* Image & Title */}
                        <td className="py-4 px-6">
                          <div className="flex items-center space-x-3">
                            <img
                              src={product.imageUrl}
                              alt={product.name}
                              referrerPolicy="no-referrer"
                              className="w-10 h-10 rounded-lg object-cover bg-gray-50 flex-shrink-0 border border-gray-100"
                            />
                            <div>
                              <p className="font-sans font-bold text-gray-900 text-sm leading-tight">{product.name}</p>
                              <p className="text-xs text-gray-400 truncate max-w-[180px]">{product.description}</p>
                            </div>
                          </div>
                        </td>

                        {/* Category */}
                        <td className="py-4 px-6">
                          <span className="inline-flex items-center px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-emerald-50 text-emerald-800">
                            {product.category}
                          </span>
                        </td>

                        {/* Price */}
                        <td className="py-4 px-6 font-mono text-sm font-bold text-gray-900">
                          ${product.price.toFixed(2)}
                          <span className="text-gray-400 text-[10px] font-light"> / {product.unit}</span>
                        </td>

                        {/* Stock */}
                        <td className="py-4 px-6">
                          {isOutOfStock ? (
                            <span className="text-xs font-semibold text-red-500 font-mono">Out of Stock</span>
                          ) : isLowStock ? (
                            <span className="text-xs font-semibold text-amber-500 font-mono">Low: {product.stock} {product.unit}</span>
                          ) : (
                            <span className="text-xs font-mono text-gray-600">{product.stock} {product.unit}</span>
                          )}
                        </td>

                        {/* Status */}
                        <td className="py-4 px-6 text-center">
                          {product.status === 'active' ? (
                            <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-800">
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-600">
                              Draft
                            </span>
                          )}
                        </td>

                        {/* Actions */}
                        <td className="py-4 px-6 text-right whitespace-nowrap">
                          <div className="inline-flex space-x-2">
                            {/* Edit */}
                            <button
                              type="button"
                              onClick={() => {
                                setShowAddForm(false);
                                setEditingProduct(product);
                              }}
                              className="p-1.5 text-gray-400 hover:text-emerald-700 hover:bg-emerald-50 rounded-md transition-all cursor-pointer"
                            >
                              <Edit className="w-4 h-4" />
                            </button>
                            {/* Delete */}
                            <button
                              type="button"
                              onClick={() => handleDeleteProduct(product.id, product.name)}
                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-all cursor-pointer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filteredInventory.length === 0 && (
              <div className="py-12 text-center text-gray-400 text-sm">
                No inventory records found.
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB CONTENT: ORDERS */}
      {activeTab === 'orders' && (
        <div className="space-y-6">
          <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-3xs flex items-center justify-between">
            <span className="text-xs font-mono text-gray-400 uppercase tracking-widest">Fulfillment List</span>
            <span className="text-xs font-mono text-gray-500 font-bold">{orders.length} total orders recorded</span>
          </div>

          {orders.length === 0 ? (
            <div className="bg-white rounded-2xl border border-dashed border-gray-200 py-16 px-4 text-center">
              <div className="inline-flex p-4 bg-gray-50 text-gray-400 rounded-full mb-4">
                <FileText className="w-8 h-8" />
              </div>
              <h4 className="font-sans font-semibold text-gray-900 text-lg mb-1">
                No orders placed yet
              </h4>
              <p className="text-gray-400 text-sm max-w-md mx-auto">
                Once a customer purchases items on the storefront, their order invoice, total prices, and shipping addresses will appear here in real-time.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {orders.slice().reverse().map(order => {
                return (
                  <div key={order.id} className="bg-white rounded-2xl border border-gray-100 shadow-3xs p-5 flex flex-col justify-between">
                    <div>
                      {/* Header */}
                      <div className="flex justify-between items-start border-b border-gray-50 pb-3.5 mb-3.5">
                        <div>
                          <span className="font-mono text-xs text-gray-400 block">Order ID</span>
                          <span className="font-mono text-sm font-bold text-gray-900">#{order.id}</span>
                        </div>
                        
                        {/* Status Select Badge */}
                        <div>
                          <select
                            id={`status-select-${order.id}`}
                            value={order.status}
                            onChange={(e) => handleUpdateOrderStatus(order.id, e.target.value)}
                            className={`text-xs font-bold rounded-lg px-2.5 py-1.5 border-0 cursor-pointer outline-hidden ${
                              order.status === 'delivered' ? 'bg-emerald-100 text-emerald-800' :
                              order.status === 'shipped' ? 'bg-blue-100 text-blue-800' :
                              order.status === 'processing' ? 'bg-indigo-100 text-indigo-800' :
                              order.status === 'cancelled' ? 'bg-red-100 text-red-800' :
                              'bg-amber-100 text-amber-800' // pending
                            }`}
                          >
                            <option value="pending">Pending</option>
                            <option value="processing">Processing</option>
                            <option value="shipped">Shipped</option>
                            <option value="delivered">Delivered</option>
                            <option value="cancelled">Cancelled</option>
                          </select>
                        </div>
                      </div>

                      {/* Customer Details Grid */}
                      <div className="space-y-2 mb-4 bg-gray-50 p-3 rounded-xl border border-gray-100/50">
                        <p className="text-[10px] font-mono text-gray-400 uppercase tracking-widest border-b border-gray-200/50 pb-1 mb-1.5">Delivery Profile</p>
                        <div className="text-xs text-gray-700">
                          <strong>Customer:</strong> {order.customerName}
                        </div>
                        <div className="text-xs text-gray-700">
                          <strong>Email:</strong> {order.customerEmail}
                        </div>
                        {order.customerPhone && (
                          <div className="text-xs text-gray-700">
                            <strong>Phone:</strong> {order.customerPhone}
                          </div>
                        )}
                        <div className="text-xs text-gray-700">
                          <strong>Address:</strong> {order.customerAddress}
                        </div>
                      </div>

                      {/* Items List */}
                      <div className="space-y-2.5 mb-4">
                        <p className="text-[10px] font-mono text-gray-400 uppercase tracking-widest">Ordered Items</p>
                        {order.items.map((item, idx) => (
                          <div key={idx} className="flex justify-between items-center text-xs">
                            <span className="text-gray-600 truncate max-w-[200px]">
                              • {item.productName} <span className="text-gray-400">x{item.quantity}</span>
                            </span>
                            <span className="font-semibold text-gray-900 font-mono">${(item.price * item.quantity).toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Footer */}
                    <div className="border-t border-gray-50 pt-3.5 mt-2 flex items-baseline justify-between">
                      <span className="text-xs font-mono text-gray-400">{new Date(order.createdAt).toLocaleString()}</span>
                      <div>
                        <span className="text-xs text-gray-400 mr-1.5 font-sans">Total amount Paid:</span>
                        <span className="text-lg font-bold font-mono text-gray-900">${order.totalAmount.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB CONTENT: CATEGORIES */}
      {activeTab === 'categories' && (
        <div className="space-y-6">
          <div className="flex justify-between items-center bg-white p-4 rounded-xl border border-gray-100 shadow-3xs">
            <span className="text-xs font-mono text-gray-400 uppercase tracking-widest">Departments Catalog</span>
            <button
              onClick={() => setShowCatForm(!showCatForm)}
              className="inline-flex items-center space-x-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-3.5 py-2 rounded-lg font-bold transition-all shadow-xs cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Custom Category</span>
            </button>
          </div>

          {/* New Category Form Drawer */}
          {showCatForm && (
            <form onSubmit={handleAddCategorySubmit} className="bg-white p-5 rounded-2xl border border-emerald-100 shadow-xs space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-gray-100">
                <h4 className="font-sans font-bold text-gray-950 text-sm flex items-center space-x-1.5">
                  <Layers className="w-4.5 h-4.5 text-emerald-600" />
                  <span>Create Custom Shop Department</span>
                </h4>
                <button type="button" onClick={() => setShowCatForm(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Category Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Vegetables, Dairy, Bakery"
                    value={newCatName}
                    onChange={(e) => setNewCatName(e.target.value)}
                    className="w-full text-xs border border-gray-200 rounded-lg p-2 text-gray-800 outline-hidden focus:ring-2 focus:ring-emerald-500/10"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Lucide Icon name (Optional)</label>
                  <select
                    value={newCatIcon}
                    onChange={(e) => setNewCatIcon(e.target.value)}
                    className="w-full text-xs border border-gray-200 rounded-lg p-2 text-gray-800 outline-hidden"
                  >
                    <option value="Sparkles">Sparkles (Default)</option>
                    <option value="Apple">Apple</option>
                    <option value="Beef">Beef</option>
                    <option value="Fish">Fish</option>
                    <option value="Cake">Cake</option>
                    <option value="Heart">Heart</option>
                    <option value="Leaf">Leaf</option>
                    <option value="Gift">Gift</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Department Description</label>
                <input
                  type="text"
                  placeholder="Detailed description of what kinds of products this department stocks..."
                  value={newCatDescription}
                  onChange={(e) => setNewCatDescription(e.target.value)}
                  className="w-full text-xs border border-gray-200 rounded-lg p-2 text-gray-800 outline-hidden focus:ring-2 focus:ring-emerald-500/10"
                />
              </div>

              <div className="flex justify-end space-x-3 pt-3 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setShowCatForm(false)}
                  className="px-4 py-2 border border-gray-200 text-gray-500 rounded-lg text-xs font-semibold hover:bg-gray-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-all cursor-pointer"
                >
                  Create Department
                </button>
              </div>
            </form>
          )}

          {/* Department List Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {categories.map(cat => {
              const count = products.filter(p => p.category.toLowerCase() === cat.name.toLowerCase()).length;
              return (
                <div key={cat.id} className="bg-white rounded-2xl border border-gray-100 shadow-3xs p-5 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center space-x-3.5 mb-3.5">
                      <div className="bg-emerald-50 text-emerald-700 p-2.5 rounded-xl">
                        {/* Dynamic Icon */}
                        {(() => {
                          const IconComp = (Icons as any)[cat.icon];
                          return IconComp ? <IconComp className="w-5 h-5" /> : <Icons.Sparkles className="w-5 h-5" />;
                        })()}
                      </div>
                      <div>
                        <h4 className="font-sans font-bold text-gray-900 text-sm leading-none">{cat.name}</h4>
                        <span className="text-[10px] font-mono text-gray-400 mt-1 block">ID: #{cat.id}</span>
                      </div>
                    </div>
                    <p className="text-gray-500 text-xs leading-relaxed mb-4">
                      {cat.description || 'No department description provided.'}
                    </p>
                  </div>
                  
                  <div className="border-t border-gray-50 pt-3 flex justify-between items-center text-xs text-gray-400 font-mono">
                    <span>Department Size</span>
                    <span className="text-emerald-700 font-bold">{count} items</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
}
