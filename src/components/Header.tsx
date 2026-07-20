import React from 'react';
import { ShoppingBag, LayoutDashboard, Store, RefreshCw, Sparkles, User } from 'lucide-react';
import { CartItem } from '../types';

interface HeaderProps {
  activeView: 'store' | 'admin';
  setActiveView: (view: 'store' | 'admin') => void;
  cart: CartItem[];
  onOpenCart: () => void;
  onResetDB: () => void;
  isResetting: boolean;
  userProfile: any;
  onOpenAuthModal: () => void;
}

export default function Header({
  activeView,
  setActiveView,
  cart,
  onOpenCart,
  onResetDB,
  isResetting,
  userProfile,
  onOpenAuthModal
}: HeaderProps) {
  const cartItemsCount = cart.reduce((count, item) => count + item.quantity, 0);


  return (
    <header className="sticky top-0 z-40 w-full bg-white/85 backdrop-blur-md border-b border-gray-100 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand Logo and Name */}
        <div className="flex items-center space-x-2.5 cursor-pointer" onClick={() => setActiveView('store')}>
          <div className="bg-emerald-600 text-white p-2 rounded-xl flex items-center justify-center shadow-xs">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <h1 className="font-sans font-bold text-lg tracking-tight text-gray-900 leading-none">
              Shopping Cambodia
            </h1>
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">
              Cambodian Marketplace
            </span>
          </div>
        </div>

        {/* View Switches & Actions */}
        <div className="flex items-center space-x-2 sm:space-x-4">
          <button
            id="nav-store-btn"
            onClick={() => setActiveView('store')}
            className={`flex items-center space-x-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-all ${
              activeView === 'store'
                ? 'bg-emerald-50 text-emerald-700 shadow-2xs'
                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
            }`}
          >
            <Store className="w-4 h-4" />
            <span className="hidden sm:inline">Storefront</span>
          </button>

          <button
            id="nav-admin-btn"
            onClick={() => setActiveView('admin')}
            className={`flex items-center space-x-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-all ${
              activeView === 'admin'
                ? 'bg-emerald-50 text-emerald-700 shadow-2xs'
                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
            }`}
          >
            <LayoutDashboard className="w-4 h-4" />
            <span className="hidden sm:inline">Admin Panel</span>
          </button>

          {/* Reset System Trigger */}
          <button
            id="reset-db-btn"
            onClick={onResetDB}
            disabled={isResetting}
            title="Reset Store to Defaults"
            className="p-2 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-all disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${isResetting ? 'animate-spin' : ''}`} />
          </button>

          {/* Vertical Separator */}
          <div className="h-6 w-[1px] bg-gray-200" />

          {/* User Auth / Profile Button */}
          {userProfile ? (
            <button
              id="user-profile-btn"
              onClick={onOpenAuthModal}
              className="flex items-center space-x-2 bg-gray-50 hover:bg-gray-100 text-gray-700 px-3 py-2 rounded-lg text-sm font-medium border border-gray-200 transition-all cursor-pointer"
            >
              <div className="h-6 w-6 rounded-full bg-emerald-600 text-white flex items-center justify-center text-xs font-bold font-sans shadow-2xs">
                {userProfile.displayName ? userProfile.displayName.charAt(0).toUpperCase() : 'U'}
              </div>
              <span className="hidden md:inline max-w-[80px] truncate">{userProfile.displayName}</span>
              <span className={`text-[9px] px-1.5 py-0.5 rounded uppercase font-bold tracking-wider scale-90 ${
                userProfile.role === 'admin' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
              }`}>
                {userProfile.role}
              </span>
            </button>
          ) : (
            <button
              id="open-auth-btn"
              onClick={onOpenAuthModal}
              className="flex items-center space-x-1.5 bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 px-3 py-2 rounded-lg text-sm font-medium transition-all cursor-pointer"
            >
              <User className="w-4 h-4 text-gray-400" />
              <span>Sign In</span>
            </button>
          )}

          {/* Cart Trigger */}
          <button
            id="open-cart-btn"
            onClick={onOpenCart}
            className="relative flex items-center space-x-2 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium shadow-sm transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
          >
            <ShoppingBag className="w-4 h-4" />
            <span className="hidden xs:inline">Cart</span>
            {cartItemsCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-500 px-1 text-xs font-bold text-white shadow-xs animate-pulse">
                {cartItemsCount}
              </span>
            )}
          </button>

        </div>
      </div>
    </header>
  );
}
