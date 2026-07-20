import express from 'express';
import path from 'path';
import fs from 'fs';
import { INITIAL_PRODUCTS, INITIAL_CATEGORIES } from './src/data.js';
import { Product, Order, Category, OrderItem, SalesStats } from './src/types.js';
import { agentRouter } from './server/routes.js';
import { configureHeartbeat } from './server/heartbeat.js';

const app = express();
// Heroku (and most PaaS hosts) inject the port to bind via process.env.PORT.
// Falling back to 3000 keeps local development unchanged.
const PORT = Number(process.env.PORT) || 3000;

// Enable JSON parsing
app.use(express.json());

// Enable CORS for ease of access if accessed from external services
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Admin-Key, X-Admin-User, X-Admin-Role');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Paths for persistent JSON database store
// Using process.cwd() ensures compatibility when running either locally or in a container/Heroku
const DATA_DIR = path.join(process.cwd(), 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

// Helper to ensure data directory and default files exist
function initializeDatabase() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Seed Categories if not exists
  if (!fs.existsSync(CATEGORIES_FILE)) {
    fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(INITIAL_CATEGORIES, null, 2));
    console.log('Categories seeded successfully.');
  }

  // Seed Products if not exists
  if (!fs.existsSync(PRODUCTS_FILE)) {
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(INITIAL_PRODUCTS, null, 2));
    console.log('Products seeded successfully.');
  }

  // Initialize Orders if not exists
  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify([], null, 2));
    console.log('Orders database initialized.');
  }
}

// Read database files
function readProducts(): Product[] {
  try {
    return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf-8'));
  } catch (error) {
    return INITIAL_PRODUCTS;
  }
}

function writeProducts(products: Product[]) {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
}

function readCategories(): Category[] {
  try {
    return JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf-8'));
  } catch (error) {
    return INITIAL_CATEGORIES;
  }
}

function writeCategories(categories: Category[]) {
  fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(categories, null, 2));
}

function readOrders(): Order[] {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));
  } catch (error) {
    return [];
  }
}

function writeOrders(orders: Order[]) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// Run DB Initialization
initializeDatabase();

// Main Business Agent, skill store, workflows, approvals, Telegram, and Phase 2 APIs.
app.use('/api/agent', agentRouter);
configureHeartbeat();

// ==========================================
// HEROKU & PRODUCTION DEPLOYMENT GUIDE (API)
// ==========================================
app.get('/api', (req, res) => {
  res.json({
    message: "Welcome to the Shopping Cambodia Store & Admin API!",
    environment: process.env.NODE_ENV || "development",
    heroku_deployment_info: {
      step_1: "Create a Heroku App: heroku create your-app-name",
      step_2: "Add a database add-on: heroku addons:create heroku-postgresql:essential-tier (for SQL) or MongoDB Atlas",
      step_3: "Configure Config Vars on Heroku dashboard (e.g. DATABASE_URL)",
      step_4: "Deploy: git push heroku main",
      note: "For production, edit this server.ts to fetch and store data from your live database instead of local JSON files."
    },
    endpoints: {
      products: {
        "GET /api/products": "List all products (supports category and status filters)",
        "POST /api/products": "Create a new product (Admin Only)",
        "PUT /api/products/:id": "Update a product (Admin Only)",
        "DELETE /api/products/:id": "Delete a product (Admin Only)"
      },
      categories: {
        "GET /api/categories": "List all product categories",
        "POST /api/categories": "Add or edit a category"
      },
      orders: {
        "GET /api/orders": "List all customer orders",
        "POST /api/orders": "Create a new order & deduct stock",
        "PUT /api/orders/:id": "Update order status (pending, processing, shipped, etc.)"
      },
      stats: {
        "GET /api/stats": "Get aggregated sales metrics and chart data"
      },
      system: {
        "POST /api/reset": "Reset database back to initial seed state"
      }
    }
  });
});

// ==========================================
// PRODUCTS API
// ==========================================
app.get('/api/products', (req, res) => {
  const products = readProducts();
  const { category, status } = req.query;
  
  let filtered = products;
  if (category) {
    filtered = filtered.filter(p => p.category.toLowerCase() === (category as string).toLowerCase());
  }
  if (status) {
    filtered = filtered.filter(p => p.status === status);
  }
  
  res.json(filtered);
});

app.post('/api/products', (req, res) => {
  const { name, description, category, price, stock, imageUrl, unit, status } = req.body;
  
  if (!name || !category || price === undefined || stock === undefined) {
    return res.status(400).json({ error: "Missing required fields: name, category, price, stock are required." });
  }

  const products = readProducts();
  const newProduct: Product = {
    id: `prod_${Date.now()}`,
    name,
    description: description || '',
    category,
    price: Number(price),
    stock: Number(stock),
    imageUrl: imageUrl || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&auto=format&fit=crop&q=80',
    unit: unit || 'pcs',
    status: status || 'active'
  };

  products.push(newProduct);
  writeProducts(products);
  res.status(201).json(newProduct);
});

app.put('/api/products/:id', (req, res) => {
  const { id } = req.params;
  const { name, description, category, price, stock, imageUrl, unit, status } = req.body;
  
  const products = readProducts();
  const index = products.findIndex(p => p.id === id);
  
  if (index === -1) {
    return res.status(404).json({ error: "Product not found." });
  }

  const updatedProduct: Product = {
    ...products[index],
    name: name !== undefined ? name : products[index].name,
    description: description !== undefined ? description : products[index].description,
    category: category !== undefined ? category : products[index].category,
    price: price !== undefined ? Number(price) : products[index].price,
    stock: stock !== undefined ? Number(stock) : products[index].stock,
    imageUrl: imageUrl !== undefined ? imageUrl : products[index].imageUrl,
    unit: unit !== undefined ? unit : products[index].unit,
    status: status !== undefined ? status : products[index].status
  };

  products[index] = updatedProduct;
  writeProducts(products);
  res.json(updatedProduct);
});

app.delete('/api/products/:id', (req, res) => {
  const { id } = req.params;
  const products = readProducts();
  const initialLength = products.length;
  const filtered = products.filter(p => p.id !== id);
  
  if (filtered.length === initialLength) {
    return res.status(404).json({ error: "Product not found." });
  }

  writeProducts(filtered);
  res.json({ message: "Product deleted successfully.", id });
});

// ==========================================
// CATEGORIES API
// ==========================================
app.get('/api/categories', (req, res) => {
  res.json(readCategories());
});

app.post('/api/categories', (req, res) => {
  const { name, description, icon } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Category name is required." });
  }

  const categories = readCategories();
  
  // Clean name formatted nicely (e.g., Sweets, Meats)
  const formattedName = name.trim();
  const exists = categories.find(c => c.name.toLowerCase() === formattedName.toLowerCase());
  
  if (exists) {
    return res.status(400).json({ error: "Category already exists." });
  }

  const newCategory: Category = {
    id: `cat_${Date.now()}`,
    name: formattedName,
    description: description || '',
    icon: icon || 'Sparkles'
  };

  categories.push(newCategory);
  writeCategories(categories);
  res.status(201).json(newCategory);
});

// ==========================================
// ORDERS API
// ==========================================
app.get('/api/orders', (req, res) => {
  res.json(readOrders());
});

app.post('/api/orders', (req, res) => {
  const { customerName, customerEmail, customerPhone, customerAddress, items } = req.body;
  
  if (!customerName || !customerEmail || !customerAddress || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Missing required order fields: name, email, address, and checkout items." });
  }

  const products = readProducts();
  const orders = readOrders();
  const orderItems: OrderItem[] = [];
  let totalAmount = 0;

  // Validate stock and verify prices
  for (const item of items) {
    const product = products.find(p => p.id === item.productId);
    if (!product) {
      return res.status(400).json({ error: `Product with ID ${item.productId} does not exist.` });
    }

    if (product.stock < item.quantity) {
      return res.status(400).json({ error: `Insufficient stock for product "${product.name}". Available stock: ${product.stock}` });
    }

    // Deduct stock
    product.stock -= item.quantity;
    
    // Add to order items
    orderItems.push({
      productId: product.id,
      productName: product.name,
      quantity: item.quantity,
      price: product.price
    });

    totalAmount += product.price * item.quantity;
  }

  const newOrder: Order = {
    id: `ord_${Date.now()}`,
    customerName,
    customerEmail,
    customerPhone: customerPhone || '',
    customerAddress,
    items: orderItems,
    totalAmount: Number(totalAmount.toFixed(2)),
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  orders.push(newOrder);
  
  // Commit changes to disk
  writeProducts(products);
  writeOrders(orders);

  res.status(201).json(newOrder);
});

app.put('/api/orders/:id', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid order status. Must be one of: ${validStatuses.join(', ')}` });
  }

  const orders = readOrders();
  const index = orders.findIndex(o => o.id === id);

  if (index === -1) {
    return res.status(404).json({ error: "Order not found." });
  }

  // If status is being changed to cancelled, we should restock the products!
  if (status === 'cancelled' && orders[index].status !== 'cancelled') {
    const products = readProducts();
    for (const item of orders[index].items) {
      const product = products.find(p => p.id === item.productId);
      if (product) {
        product.stock += item.quantity;
      }
    }
    writeProducts(products);
  } 
  // If order is un-cancelled, we check and deduct stock
  else if (orders[index].status === 'cancelled' && status !== 'cancelled') {
    const products = readProducts();
    // Validate stock
    for (const item of orders[index].items) {
      const product = products.find(p => p.id === item.productId);
      if (product && product.stock < item.quantity) {
        return res.status(400).json({ error: `Cannot restore order. Insufficient stock for "${product.name}".` });
      }
    }
    // Deduct stock
    for (const item of orders[index].items) {
      const product = products.find(p => p.id === item.productId);
      if (product) {
        product.stock -= item.quantity;
      }
    }
    writeProducts(products);
  }

  orders[index].status = status;
  writeOrders(orders);
  res.json(orders[index]);
});

// ==========================================
// ANALYTICS & STATS API
// ==========================================
app.get('/api/stats', (req, res) => {
  const products = readProducts();
  const orders = readOrders();
  const activeOrders = orders.filter(o => o.status !== 'cancelled');

  // Total Revenue (excluding cancelled orders)
  const totalRevenue = activeOrders.reduce((sum, o) => sum + o.totalAmount, 0);

  // Total Orders & Products
  const totalOrders = orders.length;
  const totalProducts = products.length;

  // Revenue by Category
  const categoryRevenueMap: { [key: string]: number } = {};
  INITIAL_CATEGORIES.forEach(cat => {
    categoryRevenueMap[cat.name] = 0;
  });

  activeOrders.forEach(order => {
    order.items.forEach(item => {
      const product = products.find(p => p.id === item.productId);
      const category = product ? product.category : 'Handicrafts'; // Default fallback
      categoryRevenueMap[category] = (categoryRevenueMap[category] || 0) + (item.price * item.quantity);
    });
  });

  const revenueByCategory = Object.keys(categoryRevenueMap).map(cat => ({
    category: cat,
    amount: Number(categoryRevenueMap[cat].toFixed(2))
  }));

  // Orders and Revenue over time (Grouped by Date)
  const statsByDate: { [date: string]: { orders: number; revenue: number } } = {};
  
  // Fill in past 7 days by default to make chart look complete
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    statsByDate[dateStr] = { orders: 0, revenue: 0 };
  }

  orders.forEach(order => {
    const dateStr = order.createdAt.split('T')[0];
    if (statsByDate[dateStr]) {
      statsByDate[dateStr].orders += 1;
      if (order.status !== 'cancelled') {
        statsByDate[dateStr].revenue += order.totalAmount;
      }
    } else {
      // If order is older or newer, register it
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

  const stats: SalesStats = {
    totalRevenue: Number(totalRevenue.toFixed(2)),
    totalOrders,
    totalProducts,
    revenueByCategory,
    ordersOverTime,
    topProducts
  };

  res.json(stats);
});

// ==========================================
// SYSTEM RESET API
// ==========================================
app.post('/api/reset', (req, res) => {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(INITIAL_PRODUCTS, null, 2));
  fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(INITIAL_CATEGORIES, null, 2));
  fs.writeFileSync(ORDERS_FILE, JSON.stringify([], null, 2));
  console.log('Database reset to defaults.');
  res.json({ message: "Database reset to initial seeds successfully." });
});

// ==========================================
// VITE OR STATIC ASSETS SERVING MIDDLEWARE
// ==========================================
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    // Integrate Vite development server middleware. Vite is a devDependency and
    // is imported lazily so production hosts (Heroku) can prune it after build.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log('Vite development middleware integrated.');
  } else {
    // Serve production static assets from dist folder
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    console.log('Serving production static assets.');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Shopping Cambodia Full-Stack Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start full-stack server:', err);
});
