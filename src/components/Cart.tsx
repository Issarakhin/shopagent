import React, { useState, useEffect } from 'react';
import { X, Trash2, Plus, Minus, ShoppingBag, Mail, User, Phone, MapPin, CreditCard, CheckCircle, ShieldCheck } from 'lucide-react';
import { CartItem, Order, OrderItem } from '../types';
import { db } from '../firebase';
import { doc, runTransaction } from 'firebase/firestore';

interface CartProps {
  isOpen: boolean;
  onClose: () => void;
  cart: CartItem[];
  onUpdateQuantity: (productId: string, quantity: number) => void;
  onRemoveItem: (productId: string) => void;
  onCheckoutSuccess: (newOrder: Order) => void;
  onShowNotification: (message: string, type: 'success' | 'error' | 'warning') => void;
  userProfile: any;
}

export default function Cart({
  isOpen,
  onClose,
  cart,
  onUpdateQuantity,
  onRemoveItem,
  onCheckoutSuccess,
  onShowNotification,
  userProfile
}: CartProps) {
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [placedOrder, setPlacedOrder] = useState<Order | null>(null);

  // Pre-fill profile info for logged-in buyers
  useEffect(() => {
    if (userProfile && isOpen) {
      setCustomerName(userProfile.displayName || '');
      setCustomerEmail(userProfile.email || '');
      setCustomerPhone(userProfile.phone || '');
      setCustomerAddress(userProfile.address || '');
    }
  }, [userProfile, isOpen]);

  if (!isOpen) return null;

  const subtotal = cart.reduce((total, item) => total + item.product.price * item.quantity, 0);
  const tax = subtotal * 0.08; // 8% standard tax
  const total = subtotal + tax;

  const handleCheckoutSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerName || !customerEmail || !customerAddress) {
      onShowNotification('Please fill in all required fields.', 'warning');
      return;
    }

    setIsSubmitting(true);

    try {
      const orderId = `ord_${Date.now()}`;
      const orderItems: OrderItem[] = cart.map(item => ({
        productId: item.product.id,
        productName: item.product.name,
        quantity: item.quantity,
        price: item.product.price
      }));

      const newOrder: Order = {
        id: orderId,
        customerName,
        customerEmail,
        customerPhone: customerPhone || '',
        customerAddress,
        items: orderItems,
        totalAmount: Number(total.toFixed(2)),
        status: 'pending',
        createdAt: new Date().toISOString()
      };

      // Perform direct Cloud Firestore stock reduction transaction
      await runTransaction(db, async (transaction) => {
        // Read products first as required by Firestore transactions
        const productRefsAndDocs = [];
        for (const item of cart) {
          const productRef = doc(db, 'products', item.product.id);
          const productDoc = await transaction.get(productRef);
          if (!productDoc.exists()) {
            throw new Error(`Product "${item.product.name}" does not exist in the store.`);
          }
          const currentStock = productDoc.data().stock;
          if (currentStock < item.quantity) {
            throw new Error(`Insufficient stock for product "${item.product.name}". Available: ${currentStock}`);
          }
          productRefsAndDocs.push({ ref: productRef, newStock: currentStock - item.quantity });
        }

        // Deduct stock for all products
        for (const pd of productRefsAndDocs) {
          transaction.update(pd.ref, { stock: pd.newStock });
        }

        // Save order document
        const orderRef = doc(db, 'orders', orderId);
        transaction.set(orderRef, {
          ...newOrder,
          buyerUid: userProfile?.uid || 'guest'
        });
      });

      // Success!
      setPlacedOrder(newOrder);
      onCheckoutSuccess(newOrder);
      onShowNotification('Order placed successfully!', 'success');
      
      // Clear fields if not logged in
      if (!userProfile) {
        setCustomerName('');
        setCustomerEmail('');
        setCustomerPhone('');
        setCustomerAddress('');
      }
    } catch (error: any) {
      onShowNotification(error.message || 'An error occurred during checkout.', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetCartState = () => {
    setPlacedOrder(null);
    onClose();
  };


  return (
    <div className="fixed inset-0 z-50 overflow-hidden" aria-labelledby="slide-over-title" role="dialog" aria-modal="true">
      <div className="absolute inset-0 overflow-hidden">
        {/* Backdrop overlay */}
        <div 
          className="absolute inset-0 bg-black/45 backdrop-blur-xs transition-opacity" 
          onClick={onClose}
        />

        <div className="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10">
          <div className="pointer-events-auto w-screen max-w-md">
            <div className="flex h-full flex-col bg-white shadow-2xl overflow-y-auto">
              
              {/* Cart Header */}
              <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between bg-gray-50">
                <div className="flex items-center space-x-2.5">
                  <ShoppingBag className="w-5 h-5 text-emerald-600" />
                  <h2 className="text-lg font-sans font-bold text-gray-900" id="slide-over-title">
                    {placedOrder ? 'Receipt' : 'Shopping Cart'}
                  </h2>
                </div>
                <button
                  type="button"
                  className="rounded-full p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all cursor-pointer"
                  onClick={onClose}
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Order Success Screen */}
              {placedOrder ? (
                <div className="flex-1 px-6 py-8 text-center flex flex-col justify-between">
                  <div className="my-auto">
                    <div className="inline-flex p-4 bg-emerald-50 text-emerald-600 rounded-full mb-5">
                      <CheckCircle className="w-12 h-12" />
                    </div>
                    <h3 className="text-2xl font-sans font-extrabold text-gray-900 mb-2">
                      Order Confirmed!
                    </h3>
                    <p className="text-gray-500 text-sm mb-6 max-w-xs mx-auto">
                      Thank you for your purchase, <strong>{placedOrder.customerName}</strong>! Your items are reserved and preparing for delivery.
                    </p>

                    {/* Receipt Details Box */}
                    <div className="bg-gray-50 rounded-2xl p-5 border border-gray-100 text-left mb-6 font-sans">
                      <div className="flex justify-between text-xs text-gray-400 font-mono uppercase tracking-wider mb-3.5 border-b border-gray-200/50 pb-2">
                        <span>Invoice</span>
                        <span>#{placedOrder.id}</span>
                      </div>
                      
                      {/* Products list */}
                      <div className="space-y-3 mb-4 max-h-40 overflow-y-auto pr-1">
                        {placedOrder.items.map(item => (
                          <div key={item.productId} className="flex justify-between text-sm">
                            <span className="text-gray-600 truncate max-w-[200px]">
                              {item.productName} <span className="text-gray-400 text-xs">x{item.quantity}</span>
                            </span>
                            <span className="text-gray-900 font-semibold font-mono">${(item.price * item.quantity).toFixed(2)}</span>
                          </div>
                        ))}
                      </div>

                      {/* Financial breakdown */}
                      <div className="border-t border-gray-200/50 pt-3 space-y-2 text-xs">
                        <div className="flex justify-between text-gray-500">
                          <span>Subtotal</span>
                          <span className="font-mono">${(placedOrder.totalAmount / 1.08).toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-gray-500">
                          <span>Est. Taxes (8%)</span>
                          <span className="font-mono">${(placedOrder.totalAmount - (placedOrder.totalAmount / 1.08)).toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-emerald-600 font-medium">
                          <span>Delivery</span>
                          <span className="font-mono">FREE</span>
                        </div>
                        <div className="flex justify-between text-base text-gray-900 font-bold pt-1.5 border-t border-gray-100">
                          <span>Grand Total</span>
                          <span className="font-mono">${placedOrder.totalAmount.toFixed(2)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="bg-emerald-50 rounded-xl p-4 flex items-start space-x-3 text-left">
                      <ShieldCheck className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
                      <div>
                        <h4 className="text-emerald-900 font-semibold text-xs">Secure Order Managed</h4>
                        <p className="text-emerald-700 text-[11px] leading-relaxed mt-0.5">
                          A confirmation email has been dispatched to {placedOrder.customerEmail}. Track delivery status in the Admin Panel.
                        </p>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={handleResetCartState}
                    className="w-full mt-6 bg-emerald-600 hover:bg-emerald-500 text-white py-3 rounded-xl text-sm font-semibold shadow-md shadow-emerald-600/10 transition-all"
                  >
                    Continue Shopping
                  </button>
                </div>
              ) : cart.length === 0 ? (
                /* Empty Cart Screen */
                <div className="flex-1 px-6 py-12 text-center flex flex-col justify-center">
                  <div className="inline-flex p-4 bg-gray-50 text-gray-400 rounded-full mx-auto mb-4">
                    <ShoppingBag className="w-10 h-10" />
                  </div>
                  <h3 className="font-sans font-bold text-gray-900 text-lg mb-1">
                    Your cart is empty
                  </h3>
                  <p className="text-gray-400 text-sm max-w-xs mx-auto leading-relaxed mb-6">
                    Add fresh meats, fish, sweets, or unique handicrafts from our catalog to begin your gourmet order.
                  </p>
                  <button
                    onClick={onClose}
                    className="inline-flex items-center justify-center space-x-1 px-5 py-2.5 bg-gray-900 hover:bg-gray-800 text-white rounded-lg text-sm font-semibold transition-all cursor-pointer"
                  >
                    <span>Browse Storefront</span>
                  </button>
                </div>
              ) : (
                /* Populated Cart & Checkout Panel */
                <div className="flex-1 flex flex-col justify-between overflow-y-auto">
                  {/* Selected Products List */}
                  <div className="px-6 py-4 divide-y divide-gray-100 max-h-[40vh] overflow-y-auto">
                    <p className="text-[11px] font-mono text-gray-400 uppercase tracking-widest mb-3">Selected Items</p>
                    {cart.map(item => (
                      <div key={item.product.id} className="flex py-4 first:pt-0 last:pb-0 items-center justify-between">
                        <div className="flex items-center space-x-3.5">
                          <img
                            src={item.product.imageUrl}
                            alt={item.product.name}
                            referrerPolicy="no-referrer"
                            className="w-12 h-12 rounded-lg object-cover bg-gray-50 flex-shrink-0"
                          />
                          <div className="max-w-[150px]">
                            <h4 className="font-sans font-semibold text-gray-900 text-sm truncate">
                              {item.product.name}
                            </h4>
                            <span className="text-[11px] text-gray-400">
                              ${item.product.price.toFixed(2)} / {item.product.unit}
                            </span>
                          </div>
                        </div>

                        {/* Quantity controls */}
                        <div className="flex items-center space-x-2 bg-gray-50 rounded-lg p-1 border border-gray-100">
                          <button
                            onClick={() => onUpdateQuantity(item.product.id, item.quantity - 1)}
                            className="p-1 text-gray-500 hover:text-gray-800 hover:bg-gray-200/50 rounded-sm"
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <span className="text-xs font-mono font-bold text-gray-800 w-5 text-center">
                            {item.quantity}
                          </span>
                          <button
                            onClick={() => {
                              if (item.quantity < item.product.stock) {
                                onUpdateQuantity(item.product.id, item.quantity + 1);
                              } else {
                                onShowNotification(`Sorry, only ${item.product.stock} items are in stock.`, 'warning');
                              }
                            }}
                            disabled={item.quantity >= item.product.stock}
                            className="p-1 text-gray-500 hover:text-gray-800 hover:bg-gray-200/50 rounded-sm disabled:opacity-30"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>

                        {/* Item total & deletion */}
                        <div className="text-right pl-3">
                          <span className="text-sm font-semibold font-mono text-gray-900 block">
                            ${(item.product.price * item.quantity).toFixed(2)}
                          </span>
                          <button
                            onClick={() => onRemoveItem(item.product.id)}
                            className="text-xs text-red-400 hover:text-red-600 transition-colors cursor-pointer inline-flex items-center space-x-0.5 mt-1"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Remove</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Pricing Subtotals & Checkout Form */}
                  <div className="border-t border-gray-100 bg-gray-50 px-6 py-6 space-y-6">
                    {/* Totals */}
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between text-gray-500">
                        <span>Subtotal</span>
                        <span className="font-mono font-medium">${subtotal.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-gray-500">
                        <span>Est. Taxes (8%)</span>
                        <span className="font-mono font-medium">${tax.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-emerald-600">
                        <span>Estimated Shipping</span>
                        <span className="font-mono font-bold">FREE</span>
                      </div>
                      <div className="flex justify-between text-base font-bold text-gray-900 pt-2 border-t border-gray-200/60">
                        <span>Estimated Total</span>
                        <span className="font-mono">${total.toFixed(2)}</span>
                      </div>
                    </div>

                    {/* Secure Checkout Form */}
                    <form onSubmit={handleCheckoutSubmit} className="space-y-4 pt-1">
                      <p className="text-[11px] font-mono text-gray-400 uppercase tracking-widest">Secure Checkout Info</p>
                      
                      {/* Name */}
                      <div className="relative">
                        <User className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          required
                          placeholder="Your Full Name *"
                          value={customerName}
                          onChange={(e) => setCustomerName(e.target.value)}
                          className="w-full bg-white text-sm border border-gray-200 rounded-lg py-2 pl-9 pr-4 text-gray-800 outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                        />
                      </div>

                      {/* Email */}
                      <div className="relative">
                        <Mail className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="email"
                          required
                          placeholder="Your Email Address *"
                          value={customerEmail}
                          onChange={(e) => setCustomerEmail(e.target.value)}
                          className="w-full bg-white text-sm border border-gray-200 rounded-lg py-2 pl-9 pr-4 text-gray-800 outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                        />
                      </div>

                      {/* Phone */}
                      <div className="relative">
                        <Phone className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="tel"
                          placeholder="Phone Number (Optional)"
                          value={customerPhone}
                          onChange={(e) => setCustomerPhone(e.target.value)}
                          className="w-full bg-white text-sm border border-gray-200 rounded-lg py-2 pl-9 pr-4 text-gray-800 outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                        />
                      </div>

                      {/* Address */}
                      <div className="relative">
                        <MapPin className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
                        <textarea
                          required
                          rows={2}
                          placeholder="Delivery Address *"
                          value={customerAddress}
                          onChange={(e) => setCustomerAddress(e.target.value)}
                          className="w-full bg-white text-sm border border-gray-200 rounded-lg py-2 pl-9 pr-4 text-gray-800 outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 resize-none"
                        />
                      </div>

                      {/* Checkout Button */}
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white py-3 rounded-xl text-sm font-semibold shadow-md shadow-emerald-600/10 transition-all flex items-center justify-center space-x-2 cursor-pointer disabled:opacity-50"
                      >
                        <CreditCard className="w-4 h-4" />
                        <span>{isSubmitting ? 'Processing Order...' : 'Place Free Secure Order'}</span>
                      </button>
                    </form>
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
