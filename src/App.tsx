import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import StoreFront from './components/StoreFront';
import AdminDashboard from './components/AdminDashboard';
import Cart from './components/Cart';
import AuthModal from './components/AuthModal';
import { Product, Category, Order, CartItem, SalesStats } from './types';
import { ShoppingBag, ArrowRight, ShieldCheck, Heart, Github, Star } from 'lucide-react';
import { auth, db, seedDatabaseIfEmpty } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { collection, getDocs, doc, getDoc, setDoc, writeBatch } from 'firebase/firestore';
import { trackStoreEvent } from './agent-api';

export default function App() {
  const [activeView, setActiveView] = useState<'store' | 'admin'>('store');
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [stats, setStats] = useState<SalesStats | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [notification, setNotification] = useState<{
    message: string;
    type: 'success' | 'error' | 'warning';
  } | null>(null);

  // Load cart from Local Storage on startup
  useEffect(() => {
    const savedCart = localStorage.getItem('nourish_craft_cart');
    if (savedCart) {
      try {
        setCart(JSON.parse(savedCart));
      } catch (e) {
        console.error('Failed to load saved cart state:', e);
      }
    }
  }, []);

  // Sync cart to Local Storage on change
  const saveCartToStorage = (updatedCart: CartItem[]) => {
    setCart(updatedCart);
    localStorage.setItem('nourish_craft_cart', JSON.stringify(updatedCart));
  };

  // Listen to Auth State
  const refreshUserProfile = async () => {
    const user = auth.currentUser;
    if (user) {
      try {
        const uDoc = await getDoc(doc(db, 'users', user.uid));
        if (uDoc.exists()) {
          setUserProfile(uDoc.data());
        } else {
          // If the profile document doesn't exist, create it as a default buyer
          const defaultProfile = {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName || 'Anonymous User',
            role: 'buyer',
            phone: '',
            address: '',
            createdAt: new Date().toISOString()
          };
          await setDoc(doc(db, 'users', user.uid), defaultProfile);
          setUserProfile(defaultProfile);
        }
      } catch (err) {
        console.error('Error fetching user profile from Firestore:', err);
      }
    } else {
      setUserProfile(null);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        await refreshUserProfile();
      } else {
        setUserProfile(null);
      }
    });
    return () => unsubscribe();
  }, []);

  // Calculate sales metrics on client side dynamically
  const calculateStats = (pList: Product[], oList: Order[], cList: Category[]) => {
    const activeOrders = oList.filter(o => o.status !== 'cancelled');

    // Total Revenue (excluding cancelled orders)
    const totalRevenue = activeOrders.reduce((sum, o) => sum + o.totalAmount, 0);

    // Total Orders & Products
    const totalOrders = oList.length;
    const totalProducts = pList.length;

    // Revenue by Category
    const categoryRevenueMap: { [key: string]: number } = {};
    cList.forEach(cat => {
      categoryRevenueMap[cat.name] = 0;
    });

    activeOrders.forEach(order => {
      order.items.forEach(item => {
        const product = pList.find(p => p.id === item.productId);
        const category = product ? product.category : 'Handicrafts';
        categoryRevenueMap[category] = (categoryRevenueMap[category] || 0) + (item.price * item.quantity);
      });
    });

    const revenueByCategory = Object.keys(categoryRevenueMap).map(cat => ({
      category: cat,
      amount: Number(categoryRevenueMap[cat].toFixed(2))
    }));

    // Orders and Revenue over time (Grouped by Date)
    const statsByDate: { [date: string]: { orders: number; revenue: number } } = {};
    
    // Fill in past 7 days to keep graphs full
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      statsByDate[dateStr] = { orders: 0, revenue: 0 };
    }

    oList.forEach(order => {
      if (!order.createdAt) return;
      const dateStr = order.createdAt.split('T')[0];
      if (statsByDate[dateStr]) {
        statsByDate[dateStr].orders += 1;
        if (order.status !== 'cancelled') {
          statsByDate[dateStr].revenue += order.totalAmount;
        }
      } else {
        statsByDate[dateStr] = {
          orders: 1,
          revenue: order.status !== 'cancelled' ? order.totalAmount : 0
        };
      }
    });

    const ordersOverTime = Object.keys(statsByDate).sort().map(date => ({
      date,
      orders: statsByDate[date].orders,
      revenue: Number(statsByDate[date].revenue.toFixed(2))
    }));

    // Top Selling Products
    const productSalesMap: { [name: string]: { quantity: number; revenue: number } } = {};
    activeOrders.forEach(order => {
      order.items.forEach(item => {
        if (!productSalesMap[item.productName]) {
          productSalesMap[item.productName] = { quantity: 0, revenue: 0 };
        }
        productSalesMap[item.productName].quantity += item.quantity;
        productSalesMap[item.productName].revenue += item.price * item.quantity;
      });
    });

    const topProducts = Object.keys(productSalesMap)
      .map(name => ({
        name,
        quantity: productSalesMap[name].quantity,
        revenue: Number(productSalesMap[name].revenue.toFixed(2))
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    return {
      totalRevenue: Number(totalRevenue.toFixed(2)),
      totalOrders,
      totalProducts,
      revenueByCategory,
      ordersOverTime,
      topProducts
    };
  };

  // Fetch all database records from Firestore
  const refreshAllData = async () => {
    try {
      // Direct Firestore seeding helper
      await seedDatabaseIfEmpty();

      const [pSnap, cSnap, oSnap] = await Promise.all([
        getDocs(collection(db, 'products')),
        getDocs(collection(db, 'categories')),
        getDocs(collection(db, 'orders'))
      ]);

      const pList: Product[] = [];
      pSnap.forEach(d => {
        pList.push(d.data() as Product);
      });

      const cList: Category[] = [];
      cSnap.forEach(d => {
        cList.push(d.data() as Category);
      });

      const oList: Order[] = [];
      oSnap.forEach(d => {
        oList.push(d.data() as Order);
      });

      // Sort lists
      setProducts(pList);
      setCategories(cList);
      setOrders(oList);

      const computedStats = calculateStats(pList, oList, cList);
      setStats(computedStats);
    } catch (err) {
      console.error('Failed to load records from Firestore:', err);
      showNotification('Error syncing with Firestore. Using default values.', 'error');
    }
  };

  // Initial load
  useEffect(() => {
    refreshAllData();
  }, []);

  // Display top floating alerts
  const showNotification = (message: string, type: 'success' | 'error' | 'warning') => {
    setNotification({ message, type });
    setTimeout(() => {
      setNotification(current => current?.message === message ? null : current);
    }, 4000);
  };

  // Reset database in Firestore to defaults
  const handleResetDB = async () => {
    if (!window.confirm('WARNING: This will reset all Firestore inventories, orders, and newly created categories back to factory defaults. Continue?')) {
      return;
    }

    setIsResetting(true);
    try {
      const [pSnap, cSnap, oSnap] = await Promise.all([
        getDocs(collection(db, 'products')),
        getDocs(collection(db, 'categories')),
        getDocs(collection(db, 'orders'))
      ]);

      // Simple batches of deletes
      const batch = writeBatch(db);
      pSnap.forEach(d => {
        batch.delete(doc(db, 'products', d.id));
      });
      cSnap.forEach(d => {
        batch.delete(doc(db, 'categories', d.id));
      });
      oSnap.forEach(d => {
        batch.delete(doc(db, 'orders', d.id));
      });

      await batch.commit();

      // Seed again
      await seedDatabaseIfEmpty();

      showNotification('Store database has been reset and re-seeded to factory defaults.', 'success');
      saveCartToStorage([]); // Reset cart
      await refreshAllData();
    } catch (err) {
      console.error('Reset failed:', err);
      showNotification('Failed to execute cloud database reset.', 'error');
    } finally {
      setIsResetting(false);
    }
  };

  // Cart operations
  const handleAddToCart = (product: Product, quantity: number) => {
    const existingIndex = cart.findIndex(item => item.product.id === product.id);
    const inCartQty = existingIndex > -1 ? cart[existingIndex].quantity : 0;
    const targetQty = inCartQty + quantity;

    if (targetQty > product.stock) {
      showNotification(`Insufficient stock! Only ${product.stock} ${product.unit} available.`, 'warning');
      return;
    }

    let updatedCart: CartItem[];
    if (existingIndex > -1) {
      updatedCart = [...cart];
      updatedCart[existingIndex].quantity = targetQty;
    } else {
      updatedCart = [...cart, { product, quantity }];
    }

    saveCartToStorage(updatedCart);
    void trackStoreEvent({ type: 'add_to_cart', productId: product.id, quantity, value: product.price * quantity, userId: auth.currentUser?.uid });
    showNotification(`"${product.name}" added to cart.`, 'success');
  };

  const handleUpdateCartQuantity = (productId: string, quantity: number) => {
    if (quantity <= 0) {
      handleRemoveCartItem(productId);
      return;
    }

    const updatedCart = cart.map(item => {
      if (item.product.id === productId) {
        return { ...item, quantity };
      }
      return item;
    });

    saveCartToStorage(updatedCart);
  };

  const handleRemoveCartItem = (productId: string) => {
    const updatedCart = cart.filter(item => item.product.id !== productId);
    saveCartToStorage(updatedCart);
    showNotification('Item removed from cart.', 'warning');
  };

  const handleCheckoutSuccess = async (newOrder: Order) => {
    for (const item of newOrder.items) {
      void trackStoreEvent({ type: 'purchase', productId: item.productId, quantity: item.quantity, value: item.price * item.quantity, userId: auth.currentUser?.uid, metadata: { orderId: newOrder.id } });
    }
    saveCartToStorage([]);
    await refreshAllData();
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-between font-sans selection:bg-emerald-500/20 selection:text-emerald-900">
      
      {/* Floating Global Notifications */}
      {notification && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-md w-[90%] pointer-events-auto">
          <div className={`p-4 rounded-xl border flex items-center space-x-3 shadow-lg transition-all transform animate-bounce ${
            notification.type === 'success' ? 'bg-emerald-50 border-emerald-100 text-emerald-800' :
            notification.type === 'error' ? 'bg-red-50 border-red-100 text-red-800' :
            'bg-amber-50 border-amber-100 text-amber-800'
          }`}>
            <span className="text-base">
              {notification.type === 'success' ? '✓' : notification.type === 'error' ? '✕' : '⚠'}
            </span>
            <p className="text-xs font-semibold leading-relaxed">{notification.message}</p>
          </div>
        </div>
      )}

      {/* Primary Header Component */}
      <Header
        activeView={activeView}
        setActiveView={setActiveView}
        cart={cart}
        onOpenCart={() => setIsCartOpen(true)}
        onResetDB={handleResetDB}
        isResetting={isResetting}
        userProfile={userProfile}
        onOpenAuthModal={() => setIsAuthModalOpen(true)}
      />

      {/* Main Body */}
      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 w-full">
        {activeView === 'store' ? (
          <StoreFront
            products={products}
            categories={categories}
            cart={cart}
            onAddToCart={handleAddToCart}
            onUpdateCartQuantity={handleUpdateCartQuantity}
          />
        ) : userProfile?.role === 'admin' ? (
          <AdminDashboard
            products={products}
            categories={categories}
            orders={orders}
            stats={stats}
            onRefreshData={refreshAllData}
            onShowNotification={showNotification}
          />
        ) : (
          /* Admin Access Restricted Screen */
          <div className="py-20 flex flex-col items-center justify-center text-center">
            <div className="bg-white border border-gray-100 text-gray-800 p-8 rounded-2xl max-w-md shadow-lg">
              <div className="mx-auto flex items-center justify-center h-14 w-14 rounded-full bg-amber-50 border border-amber-200 mb-5">
                <ShieldCheck className="h-7 w-7 text-amber-600 animate-pulse" />
              </div>
              <h3 className="text-lg font-bold font-sans mb-3 text-gray-900">Admin Authentication Required</h3>
              <p className="text-xs text-gray-500 font-sans leading-relaxed mb-6">
                You are currently viewing the storefront as a guest or standard buyer. 
                The Admin Dashboard allows you to create products, upload pictures, adjust stocks, 
                and process orders, which requires an authorized administrator account.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <button
                  onClick={() => setIsAuthModalOpen(true)}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold px-5 py-2.5 rounded-lg text-sm transition-all shadow-xs cursor-pointer flex-1"
                >
                  Sign In / Sign Up as Admin
                </button>
                <button
                  onClick={() => setActiveView('store')}
                  className="bg-white hover:bg-gray-50 border border-gray-200 text-gray-700 font-semibold px-5 py-2.5 rounded-lg text-sm transition-all cursor-pointer flex-1"
                >
                  Back to Store
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Sliding Slide-over Cart */}
      <Cart
        isOpen={isCartOpen}
        onClose={() => setIsCartOpen(false)}
        cart={cart}
        onUpdateQuantity={handleUpdateCartQuantity}
        onRemoveItem={handleRemoveCartItem}
        onCheckoutSuccess={handleCheckoutSuccess}
        onShowNotification={showNotification}
        userProfile={userProfile}
      />

      {/* Login / Profile Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        userProfile={userProfile}
        onShowNotification={showNotification}
        onRefreshProfile={refreshUserProfile}
      />

      {/* Elegant Footer */}
      <footer className="bg-white border-t border-gray-100 py-12 mt-16 text-gray-400 text-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex flex-col items-center md:items-start text-center md:text-left gap-1.5">
            <h5 className="font-sans font-bold text-gray-800 text-base flex items-center space-x-1">
              <span>Shopping Cambodia</span>
            </h5>
            <p className="text-xs font-light text-gray-500 max-w-sm">
              A Cambodian marketplace for local food, traditional products, and handcrafted goods.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-6 text-xs text-gray-400">
            <span className="flex items-center space-x-1 text-emerald-600 font-medium">
              <ShieldCheck className="w-4 h-4" />
              <span>Cloud Firestore Connected</span>
            </span>
            <span className="hidden sm:inline">•</span>
            <span className="font-mono text-[11px] bg-gray-50 text-gray-500 px-2 py-1 rounded-md border border-gray-100">
              PORT 3000 Ingress
            </span>
          </div>

          <p className="text-xs text-gray-400 font-sans text-center md:text-right">
            © {new Date().getFullYear()} Shopping Cambodia Firebase & Cloud ready.
          </p>
        </div>
      </footer>
    </div>
  );
}
