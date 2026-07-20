import React, { useEffect, useState } from 'react';
import * as Icons from 'lucide-react';
import { Product, Category, CartItem } from '../types';
import { fetchPublicBoosts, trackStoreEvent } from '../agent-api';

// Helper to resolve Lucide icons dynamically
const getCategoryIcon = (iconName: string) => {
  const IconComp = (Icons as any)[iconName];
  return IconComp ? <IconComp className="w-5 h-5" /> : <Icons.Sparkles className="w-5 h-5" />;
};

interface StoreFrontProps {
  products: Product[];
  categories: Category[];
  cart: CartItem[];
  onAddToCart: (product: Product, quantity: number) => void;
  onUpdateCartQuantity: (productId: string, quantity: number) => void;
}

export default function StoreFront({
  products,
  categories,
  cart,
  onAddToCart,
  onUpdateCartQuantity
}: StoreFrontProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortBy, setSortBy] = useState<string>('featured');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [boosts, setBoosts] = useState<Array<{ productId: string; score: number; reason: string }>>([]);

  useEffect(() => {
    void fetchPublicBoosts().then(setBoosts);
  }, []);

  const openProduct = (product: Product) => {
    setSelectedProduct(product);
    void trackStoreEvent({ type: 'product_view', productId: product.id, value: product.price });
  };

  const boostFor = (productId: string) => boosts.find((item) => item.productId === productId);

  // Filter products that are active
  const activeProducts = products.filter(p => p.status === 'active');

  // Filter by category and search query
  const filteredProducts = activeProducts.filter(product => {
    const matchesCategory = selectedCategory === 'all' || product.category.toLowerCase() === selectedCategory.toLowerCase();
    const matchesSearch = product.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          product.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          product.category.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  // Sort products
  const sortedProducts = [...filteredProducts].sort((a, b) => {
    if (sortBy === 'price-low') return a.price - b.price;
    if (sortBy === 'price-high') return b.price - a.price;
    if (sortBy === 'name-asc') return a.name.localeCompare(b.name);
    if (sortBy === 'featured') {
      return (boostFor(b.id)?.score ?? 0) - (boostFor(a.id)?.score ?? 0);
    }
    return 0;
  });

  // Helper to check if item is in cart and return its quantity
  const getCartQuantity = (productId: string) => {
    const item = cart.find(i => i.product.id === productId);
    return item ? item.quantity : 0;
  };

  return (
    <div className="py-8">
      {/* Hero Banner Section */}
      <div className="mb-10 rounded-2xl bg-gradient-to-r from-emerald-800 to-teal-900 text-white p-8 md:p-12 shadow-md relative overflow-hidden">
        <div className="absolute right-0 bottom-0 top-0 w-1/3 opacity-10 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-amber-200 via-emerald-400 to-teal-950 pointer-events-none" />
        <div className="max-w-2xl relative z-10">
          <span className="inline-block bg-emerald-500/20 text-emerald-300 font-mono text-xs uppercase tracking-widest px-3 py-1 rounded-full border border-emerald-500/30 mb-4">
            Proudly Cambodian
          </span>
          <h2 className="text-3xl md:text-4xl font-sans font-bold tracking-tight mb-4">
            Discover Products from Cambodia
          </h2>
          <p className="text-emerald-100 text-base md:text-lg mb-6 font-sans font-light leading-relaxed">
            Shop quality Cambodian food, seasonal fruit, traditional sweets, and handcrafted products from trusted local sellers and artisans.
          </p>
          <div className="flex flex-wrap gap-4">
            <span className="flex items-center space-x-1.5 text-xs font-mono text-emerald-200">
              <Icons.ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Quality-checked products</span>
            </span>
            <span className="flex items-center space-x-1.5 text-xs font-mono text-emerald-200">
              <Icons.Truck className="w-4 h-4 text-emerald-400" />
              <span>Delivery across Cambodia</span>
            </span>
          </div>
        </div>
      </div>

      {/* Categories Horizontal Selector */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-sans font-semibold text-lg text-gray-900 flex items-center space-x-2">
            <Icons.Tags className="w-5 h-5 text-emerald-600" />
            <span>Browse Categories</span>
          </h3>
          <span className="text-xs font-mono text-gray-500">
            {categories.length} core departments
          </span>
        </div>
        <div className="flex overflow-x-auto pb-3 gap-3 scrollbar-thin scrollbar-thumb-gray-200 scrollbar-track-transparent">
          {/* "All" Category Badge */}
          <button
            onClick={() => setSelectedCategory('all')}
            className={`flex items-center space-x-2 px-5 py-3 rounded-xl font-medium text-sm whitespace-nowrap transition-all cursor-pointer ${
              selectedCategory === 'all'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/15'
                : 'bg-white text-gray-600 border border-gray-100 hover:border-gray-200 hover:bg-gray-50'
            }`}
          >
            <Icons.Grid className="w-4 h-4" />
            <span>All Products</span>
          </button>

          {/* Core Categories */}
          {categories.map(cat => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.name)}
              className={`flex items-center space-x-2.5 px-5 py-3 rounded-xl font-medium text-sm whitespace-nowrap transition-all cursor-pointer ${
                selectedCategory.toLowerCase() === cat.name.toLowerCase()
                  ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/15'
                  : 'bg-white text-gray-600 border border-gray-100 hover:border-gray-200 hover:bg-gray-50'
              }`}
            >
              {getCategoryIcon(cat.icon)}
              <span>{cat.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Filter and Sorting Controls */}
      <div className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-4 rounded-xl border border-gray-100 shadow-2xs">
        {/* Search Bar */}
        <div className="relative flex-1 max-w-md">
          <Icons.Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
          <input
            type="text"
            placeholder="Search premium ribeye, organic strawberries, handmade mug..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-gray-50 hover:bg-gray-100/70 focus:bg-white text-sm border-0 rounded-lg outline-hidden focus:ring-2 focus:ring-emerald-500/20 text-gray-800 transition-all placeholder-gray-400"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-0.5 rounded-full"
            >
              <Icons.X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Sorting Dropdown */}
        <div className="flex items-center space-x-3 self-end md:self-auto">
          <label htmlFor="sort-by-select" className="text-xs font-mono text-gray-400 uppercase tracking-wider flex items-center space-x-1">
            <Icons.ArrowUpDown className="w-3.5 h-3.5" />
            <span>Sort By</span>
          </label>
          <select
            id="sort-by-select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="bg-white border border-gray-200 rounded-lg text-sm px-3 py-1.5 outline-hidden text-gray-700 font-sans cursor-pointer hover:border-gray-300 focus:ring-2 focus:ring-emerald-500/10"
          >
            <option value="featured">Featured</option>
            <option value="price-low">Price: Low to High</option>
            <option value="price-high">Price: High to Low</option>
            <option value="name-asc">A to Z</option>
          </select>
        </div>
      </div>

      {/* Products Grid */}
      {sortedProducts.length === 0 ? (
        <div className="bg-white rounded-xl border border-dashed border-gray-200 py-16 px-4 text-center">
          <div className="inline-flex p-4 bg-emerald-50 text-emerald-600 rounded-2xl mb-4">
            <Icons.Inbox className="w-8 h-8" />
          </div>
          <h4 className="font-sans font-semibold text-gray-900 text-lg mb-1">
            No products found
          </h4>
          <p className="text-gray-500 text-sm max-w-md mx-auto">
            We couldn't find any products matching your search or selected category. Try searching for something else or reset the category.
          </p>
          <button
            onClick={() => {
              setSelectedCategory('all');
              setSearchQuery('');
            }}
            className="mt-4 inline-flex items-center space-x-1.5 text-sm font-medium text-emerald-600 hover:text-emerald-700"
          >
            <span>Reset filters</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {sortedProducts.map(product => {
            const inCartQuantity = getCartQuantity(product.id);
            const isLowStock = product.stock > 0 && product.stock <= 5;
            const isOutOfStock = product.stock === 0;

            return (
              <div
                key={product.id}
                className="group bg-white rounded-2xl border border-gray-100 shadow-3xs overflow-hidden hover:shadow-xs transition-all flex flex-col h-full"
              >
                {/* Product Image Area */}
                <div 
                  className="relative aspect-video w-full bg-gray-50 overflow-hidden cursor-pointer"
                  onClick={() => openProduct(product)}
                >
                  <img
                    src={product.imageUrl}
                    alt={product.name}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                  
                  {/* Category Badge */}
                  <span className="absolute top-3 left-3 bg-white/90 backdrop-blur-xs text-gray-800 text-xs font-medium px-2.5 py-1 rounded-md shadow-3xs flex items-center space-x-1 border border-gray-100">
                    <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
                    <span>{product.category}</span>
                  </span>

                  {boostFor(product.id) && (
                    <span className="absolute bottom-3 left-3 inline-flex items-center gap-1 rounded-full bg-purple-600 px-2.5 py-1 text-[10px] font-bold uppercase text-white shadow-sm">
                      <Icons.Sparkles className="h-3 w-3" /> Smart Boost {boostFor(product.id)?.score}
                    </span>
                  )}

                  {/* Stock Status Badge */}
                  {isOutOfStock ? (
                    <span className="absolute top-3 right-3 bg-red-500 text-white text-[10px] font-bold font-mono uppercase px-2 py-1 rounded-sm shadow-2xs">
                      Sold Out
                    </span>
                  ) : isLowStock ? (
                    <span className="absolute top-3 right-3 bg-amber-500 text-white text-[10px] font-bold font-mono uppercase px-2 py-1 rounded-sm shadow-2xs animate-pulse">
                      Low Stock
                    </span>
                  ) : null}

                  {/* Detail Hover Action */}
                  <div className="absolute inset-0 bg-black/25 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <span className="bg-white text-gray-900 rounded-full px-4 py-2 text-xs font-semibold shadow-md flex items-center space-x-1.5">
                      <Icons.Eye className="w-4 h-4" />
                      <span>Quick View</span>
                    </span>
                  </div>
                </div>

                {/* Content */}
                <div className="p-5 flex-1 flex flex-col">
                  <div className="flex-1 mb-4">
                    <h4 
                      className="font-sans font-bold text-gray-900 text-base mb-1.5 group-hover:text-emerald-700 transition-colors cursor-pointer"
                      onClick={() => openProduct(product)}
                    >
                      {product.name}
                    </h4>
                    <p className="text-gray-500 text-sm line-clamp-2 leading-relaxed">
                      {product.description}
                    </p>
                  </div>

                  {/* Pricing and Stock Info */}
                  <div className="flex items-baseline justify-between mb-4 border-t border-gray-50 pt-3">
                    <div>
                      <span className="text-xl font-bold text-gray-900">${product.price.toFixed(2)}</span>
                      <span className="text-gray-400 text-xs font-light"> / {product.unit}</span>
                    </div>
                    
                    <div className="text-right">
                      {isOutOfStock ? (
                        <span className="text-xs font-mono text-red-500 font-medium">Temporarily Out of Stock</span>
                      ) : (
                        <span className="text-xs font-mono text-gray-400">
                          In stock: <strong className="text-gray-600 font-semibold">{product.stock}</strong> {product.unit}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Cart Action Buttons */}
                  <div className="mt-auto pt-1">
                    {isOutOfStock ? (
                      <button
                        disabled
                        className="w-full bg-gray-100 text-gray-400 py-2 px-4 rounded-xl text-sm font-medium cursor-not-allowed flex items-center justify-center space-x-1"
                      >
                        <Icons.MinusCircle className="w-4 h-4" />
                        <span>Unavailable</span>
                      </button>
                    ) : inCartQuantity > 0 ? (
                      <div className="flex items-center justify-between bg-emerald-50 rounded-xl border border-emerald-100 overflow-hidden">
                        <button
                          onClick={() => onUpdateCartQuantity(product.id, inCartQuantity - 1)}
                          className="px-3.5 py-2 text-emerald-700 hover:bg-emerald-100/50 active:bg-emerald-100 transition-colors cursor-pointer"
                        >
                          <Icons.Minus className="w-4 h-4" />
                        </button>
                        <span className="font-mono font-bold text-emerald-800 text-sm">
                          {inCartQuantity} {product.unit} in Cart
                        </span>
                        <button
                          onClick={() => {
                            if (inCartQuantity < product.stock) {
                              onUpdateCartQuantity(product.id, inCartQuantity + 1);
                            }
                          }}
                          disabled={inCartQuantity >= product.stock}
                          className="px-3.5 py-2 text-emerald-700 hover:bg-emerald-100/50 active:bg-emerald-100 transition-colors disabled:opacity-30 cursor-pointer"
                        >
                          <Icons.Plus className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => onAddToCart(product, 1)}
                        className="w-full bg-gray-900 hover:bg-gray-800 text-white py-2.5 px-4 rounded-xl text-sm font-semibold shadow-xs flex items-center justify-center space-x-2 transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer"
                      >
                        <Icons.ShoppingCart className="w-4 h-4" />
                        <span>Add to Cart</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Product Details Modal Overlay */}
      {selectedProduct && (
        <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="modal-title" role="dialog" aria-modal="true">
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            {/* Background backdrop */}
            <div 
              className="fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity" 
              onClick={() => setSelectedProduct(null)}
            />

            {/* Trick browser into centering modal */}
            <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

            {/* Modal Box */}
            <div className="relative inline-block align-bottom bg-white rounded-3xl text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-2xl sm:w-full p-6 md:p-8">
              {/* Close Button */}
              <button
                onClick={() => setSelectedProduct(null)}
                className="absolute top-4 right-4 bg-gray-100 hover:bg-gray-200 text-gray-500 hover:text-gray-800 p-2 rounded-full transition-colors z-10"
              >
                <Icons.X className="w-5 h-5" />
              </button>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Product Image */}
                <div className="relative aspect-square w-full rounded-2xl overflow-hidden bg-gray-50 border border-gray-100">
                  <img
                    src={selectedProduct.imageUrl}
                    alt={selectedProduct.name}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                  <span className="absolute top-3 left-3 bg-white/95 text-gray-800 text-xs font-semibold px-2.5 py-1 rounded-md shadow-2xs border border-gray-100 flex items-center space-x-1">
                    <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
                    <span>{selectedProduct.category}</span>
                  </span>
                </div>

                {/* Product Metadata */}
                <div className="flex flex-col h-full justify-between">
                  <div>
                    <span className="text-xs font-mono text-emerald-600 font-bold uppercase tracking-wider">
                      Core Collection
                    </span>
                    <h3 className="font-sans font-bold text-gray-900 text-2xl mt-1 mb-3">
                      {selectedProduct.name}
                    </h3>
                    <p className="text-gray-500 text-sm leading-relaxed mb-6">
                      {selectedProduct.description}
                    </p>

                    <div className="space-y-3.5 mb-6 bg-gray-50 p-4 rounded-2xl">
                      <div className="flex justify-between items-center text-sm border-b border-gray-200/50 pb-2.5">
                        <span className="text-gray-400 font-medium">Department</span>
                        <span className="text-gray-800 font-semibold">{selectedProduct.category}</span>
                      </div>
                      <div className="flex justify-between items-center text-sm border-b border-gray-200/50 pb-2.5">
                        <span className="text-gray-400 font-medium">Stock Status</span>
                        {selectedProduct.stock === 0 ? (
                          <span className="text-red-500 font-bold font-mono text-xs uppercase">Out of Stock</span>
                        ) : selectedProduct.stock <= 5 ? (
                          <span className="text-amber-500 font-bold font-mono text-xs uppercase">Low Stock ({selectedProduct.stock})</span>
                        ) : (
                          <span className="text-emerald-600 font-bold font-mono text-xs uppercase">Available ({selectedProduct.stock} {selectedProduct.unit})</span>
                        )}
                      </div>
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-gray-400 font-medium">Sale Unit</span>
                        <span className="text-gray-700 font-mono text-xs">{selectedProduct.unit}</span>
                      </div>
                    </div>
                  </div>

                  {/* Add and Checkout */}
                  <div>
                    <div className="flex items-baseline justify-between mb-4">
                      <span className="text-xs font-mono text-gray-400 uppercase tracking-wide">Price Details</span>
                      <div className="text-right">
                        <span className="text-3xl font-extrabold text-gray-900">${selectedProduct.price.toFixed(2)}</span>
                        <span className="text-gray-400 text-sm"> / {selectedProduct.unit}</span>
                      </div>
                    </div>

                    {selectedProduct.stock === 0 ? (
                      <button
                        disabled
                        className="w-full bg-gray-100 text-gray-400 py-3 rounded-xl text-sm font-semibold cursor-not-allowed flex items-center justify-center space-x-1"
                      >
                        <Icons.MinusCircle className="w-4 h-4" />
                        <span>Temporarily Unavailable</span>
                      </button>
                    ) : getCartQuantity(selectedProduct.id) > 0 ? (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between bg-emerald-50 rounded-xl border border-emerald-100 overflow-hidden">
                          <button
                            onClick={() => onUpdateCartQuantity(selectedProduct.id, getCartQuantity(selectedProduct.id) - 1)}
                            className="px-4 py-2.5 text-emerald-700 hover:bg-emerald-100/50 active:bg-emerald-100 transition-colors"
                          >
                            <Icons.Minus className="w-4 h-4" />
                          </button>
                          <span className="font-mono font-bold text-emerald-800 text-sm">
                            {getCartQuantity(selectedProduct.id)} {selectedProduct.unit} in Cart
                          </span>
                          <button
                            onClick={() => {
                              if (getCartQuantity(selectedProduct.id) < selectedProduct.stock) {
                                onUpdateCartQuantity(selectedProduct.id, getCartQuantity(selectedProduct.id) + 1);
                              }
                            }}
                            disabled={getCartQuantity(selectedProduct.id) >= selectedProduct.stock}
                            className="px-4 py-2.5 text-emerald-700 hover:bg-emerald-100/50 active:bg-emerald-100 transition-colors disabled:opacity-30"
                          >
                            <Icons.Plus className="w-4 h-4" />
                          </button>
                        </div>
                        <button
                          onClick={() => setSelectedProduct(null)}
                          className="w-full bg-gray-900 hover:bg-gray-800 text-white py-3 rounded-xl text-sm font-semibold transition-all text-center block"
                        >
                          Keep Shopping
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          onAddToCart(selectedProduct, 1);
                        }}
                        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white py-3 rounded-xl text-sm font-semibold shadow-md shadow-emerald-600/10 transition-all flex items-center justify-center space-x-2"
                      >
                        <Icons.ShoppingCart className="w-4.5 h-4.5" />
                        <span>Add {selectedProduct.name} to Cart</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
