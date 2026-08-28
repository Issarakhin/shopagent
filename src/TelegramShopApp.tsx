import React, { useEffect, useMemo, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { auth, db, seedDatabaseIfEmpty } from './firebase';
import { signInWithCustomToken } from 'firebase/auth';
import type { CartItem, Category, Order, Product } from './types';
import StoreFront from './components/StoreFront';
import TelegramHeader from './components/TelegramHeader';
import TelegramCart from './components/TelegramCart';
import { initializeTelegramWebApp, waitForTelegramWebApp, type TelegramMiniAppUser } from './telegram-webapp';
import { telegramApi } from './telegram-api';
import { trackStoreEvent } from './agent-api';
import { ShieldCheck } from 'lucide-react';

export default function TelegramShopApp() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [user, setUser] = useState<TelegramMiniAppUser | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' | 'warning' } | null>(null);

  const cartStorageKey = useMemo(() => user?.id ? `shopping_cambodia_tg_cart_${user.id}` : '', [user?.id]);

  function notify(message: string, type: 'success' | 'error' | 'warning') {
    setNotification({ message, type });
    window.setTimeout(() => setNotification(null), 3500);
  }

  useEffect(() => { void trackStoreEvent({ type: 'acquisition_visit', metadata: { source: 'telegram_webapp' } }); }, []);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Shopping Cambodia';

    let robots = document.querySelector('meta[name="robots"]') as HTMLMetaElement | null;
    const createdRobots = !robots;
    if (!robots) {
      robots = document.createElement('meta');
      robots.name = 'robots';
      document.head.appendChild(robots);
    }
    const previousRobotsContent = robots.content;
    robots.content = 'noindex, nofollow, noarchive, nosnippet';

    return () => {
      document.title = previousTitle;
      if (createdRobots) robots?.remove();
      else if (robots) robots.content = previousRobotsContent;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      await waitForTelegramWebApp(2500);
      const tg = initializeTelegramWebApp();
      if (!tg?.initData) {
      setFatalError('Open this shop from the Shopping Cambodia Telegram bot. Telegram identity data was not provided.');
        setLoading(false);
        return;
      }


      try {
        // (2) Frontend passes Telegram's raw, signed InitData to the backend.
        const session = await telegramApi.session(tg.initData);

        // (3) Backend must validate Telegram and sync it to an existing
        // Shopping Cambodia/Firebase account before the storefront continues.
        if (!session?.authenticated || !session?.sync?.validatedInitData || !session?.sync?.accountSynced || !session?.user?.id || !session?.firebaseCustomToken) {
          throw new Error('Telegram automatic sign-in failed.');
        }

        // Backend returns a Firebase custom token for the SAME existing web
        // account. The Mini App never asks for email/password.
        const credential = await signInWithCustomToken(auth, session.firebaseCustomToken);
        if (credential.user.uid !== session.user.firebaseUid) {
          throw new Error('Telegram account sync returned an unexpected Firebase user.');
        }
        setUser(session.user as TelegramMiniAppUser);
        console.info('[Telegram Mini App] backend account sync complete', session.sync);

        // Only access account/database-backed storefront data AFTER Firebase
        // authentication succeeds. This also works with secure Firestore rules.
        await seedDatabaseIfEmpty();
        const [pSnap, cSnap] = await Promise.all([
          getDocs(collection(db, 'products')),
          getDocs(collection(db, 'categories')),
        ]);
        setProducts(pSnap.docs.map((d) => d.data() as Product));
        setCategories(cSnap.docs.map((d) => d.data() as Category));
      } catch (error) {
        setFatalError(error instanceof Error ? error.message : 'Could not open Telegram shop.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!cartStorageKey) return;
    try {
      const saved = localStorage.getItem(cartStorageKey);
      if (saved) setCart(JSON.parse(saved));
    } catch (error) {
      console.warn('Could not restore Telegram cart.', error);
    }
  }, [cartStorageKey]);

  function saveCart(next: CartItem[]) {
    setCart(next);
    if (cartStorageKey) localStorage.setItem(cartStorageKey, JSON.stringify(next));
  }

  function addToCart(product: Product, quantity: number) {
    const existing = cart.find((item) => item.product.id === product.id);
    const nextQuantity = (existing?.quantity ?? 0) + quantity;
    if (nextQuantity > product.stock) return notify(`Only ${product.stock} ${product.unit} available.`, 'warning');
    const next = existing
      ? cart.map((item) => item.product.id === product.id ? { ...item, quantity: nextQuantity } : item)
      : [...cart, { product, quantity }];
    saveCart(next);
    notify(`${product.name} added to cart.`, 'success');
    void trackStoreEvent({ type: 'add_to_cart', productId: product.id, quantity, value: product.price * quantity, userId: user?.firebaseUid ?? user?.userId });
  }

  function updateQuantity(productId: string, quantity: number) {
    if (quantity <= 0) return saveCart(cart.filter((item) => item.product.id !== productId));
    const product = products.find((item) => item.id === productId);
    if (product && quantity > product.stock) return notify(`Only ${product.stock} ${product.unit} available.`, 'warning');
    saveCart(cart.map((item) => item.product.id === productId ? { ...item, quantity } : item));
  }

  async function checkoutSuccess(order: Order) {
    for (const item of order.items) {
      void trackStoreEvent({ type: 'purchase', productId: item.productId, quantity: item.quantity, value: item.price * item.quantity, userId: user?.firebaseUid ?? user?.userId, metadata: { orderId: order.id, source: 'telegram_webapp' } });
    }
    saveCart([]);
    try {
      const pSnap = await getDocs(collection(db, 'products'));
      setProducts(pSnap.docs.map((d) => d.data() as Product));
    } catch {}
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center bg-gray-50"><div className="text-center"><div className="mx-auto h-9 w-9 animate-spin rounded-full border-4 border-emerald-100 border-t-emerald-600" /><p className="mt-3 text-sm font-semibold text-gray-600">Opening Shopping Cambodia…</p></div></div>;

  if (fatalError) return <div className="flex min-h-screen items-center justify-center bg-gray-50 p-5"><div className="max-w-md rounded-3xl border border-gray-100 bg-white p-7 text-center shadow-lg"><div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-600"><ShieldCheck className="h-6 w-6" /></div><h1 className="text-xl font-bold text-gray-900">Telegram access required</h1><p className="mt-2 text-sm leading-6 text-gray-500">{fatalError}</p><p className="mt-4 text-xs text-gray-400">Telegram verifies your identity and signs you into the same linked Shopping Cambodia web account automatically.</p></div></div>;

  return <div className="min-h-screen bg-gray-50 font-sans">
    {notification && <div className="fixed left-1/2 top-3 z-[60] w-[92%] max-w-md -translate-x-1/2"><div className={`rounded-xl border p-3 text-xs font-semibold shadow-lg ${notification.type === 'success' ? 'border-emerald-100 bg-emerald-50 text-emerald-800' : notification.type === 'error' ? 'border-red-100 bg-red-50 text-red-800' : 'border-amber-100 bg-amber-50 text-amber-800'}`}>{notification.message}</div></div>}
    <TelegramHeader cart={cart} user={user} onOpenCart={() => setCartOpen(true)} />
    <main className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
      <StoreFront products={products} categories={categories} cart={cart} onAddToCart={addToCart} onUpdateCartQuantity={updateQuantity} userId={user?.firebaseUid ?? user?.userId} />
    </main>
    <TelegramCart isOpen={cartOpen} onClose={() => setCartOpen(false)} cart={cart} user={user} onUpdateQuantity={updateQuantity} onRemoveItem={(id) => saveCart(cart.filter((item) => item.product.id !== id))} onCheckoutSuccess={checkoutSuccess} onShowNotification={notify} />
    <footer className="mt-12 border-t border-gray-100 bg-white px-4 py-7 text-center text-xs text-gray-400">Shopping Cambodia · Telegram Mini App · Telegram verified · Existing web account auto-synced</footer>
  </div>;
}
