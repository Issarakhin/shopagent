import React from 'react';
import { CheckCircle2, ShoppingBag, Sparkles, UserRound } from 'lucide-react';
import type { CartItem } from '../types';
import type { TelegramMiniAppUser } from '../telegram-webapp';

export default function TelegramHeader({ cart, user, onOpenCart }: {
  cart: CartItem[];
  user: TelegramMiniAppUser | null;
  onOpenCart: () => void;
}) {
  const cartItemsCount = cart.reduce((count, item) => count + item.quantity, 0);
  const name = user?.displayName || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Telegram user';
  return (
    <header className="sticky top-0 z-40 w-full border-b border-gray-100 bg-white/90 shadow-xs backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center space-x-2.5">
          <div className="flex items-center justify-center rounded-xl bg-emerald-600 p-2 text-white shadow-xs"><Sparkles className="h-5 w-5" /></div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold tracking-tight text-gray-900">Shopping Cambodia</h1>
            <span className="block truncate font-mono text-[10px] uppercase tracking-widest text-gray-500">Telegram Marketplace</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex max-w-[205px] items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50 px-2.5 py-2">
            {user?.photoUrl ? <img src={user.photoUrl} className="h-7 w-7 rounded-full object-cover" alt="" /> : <UserRound className="h-5 w-5 text-emerald-600" />}
            <div className="hidden min-w-0 sm:block">
              <p className="flex items-center gap-1 truncate text-xs font-semibold text-emerald-900"><CheckCircle2 className="h-3 w-3 shrink-0" />{name}</p>
              <p className="truncate text-[9px] text-emerald-700">Auto signed in · TG {user?.id ?? '...'}</p>
            </div>
          </div>
          <button onClick={onOpenCart} className="relative inline-flex h-10 w-10 items-center justify-center rounded-xl bg-gray-900 text-white shadow-sm" aria-label="Open cart">
            <ShoppingBag className="h-5 w-5" />
            {cartItemsCount > 0 && <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-bold text-white">{cartItemsCount}</span>}
          </button>
        </div>
      </div>
    </header>
  );
}
