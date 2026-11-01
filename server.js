const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const port = Number(process.env.PORT || 3000);
const publicDirectory = path.join(__dirname, "public");
const databasePath = process.env.CAFETERIA_DB_PATH || path.join(__dirname, "cafeteria.db");
const db = new DatabaseSync(databasePath);

db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    prep_minutes INTEGER NOT NULL DEFAULT 10 CHECK (prep_minutes > 0),
    available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    unit TEXT NOT NULL,
    reorder_level INTEGER NOT NULL DEFAULT 10 CHECK (reorder_level >= 0),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    order_number TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    table_number TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('Received', 'Preparing', 'Ready', 'Completed', 'Cancelled')),
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
  );
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY,
    message TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
`);

const menuCount = db.prepare("SELECT COUNT(*) AS count FROM menu_items").get().count;
if (menuCount === 0) {
  const menuSeeds = [
    ["Avocado Toast", "Breakfast", "Sourdough, smashed avocado, chili flakes", 1250, 8],
    ["Harvest Bowl", "Lunch", "Roasted vegetables, grains, herbed tahini", 1490, 12],
    ["Grilled Chicken Wrap", "Lunch", "Herb chicken, crisp greens, garlic yogurt", 1390, 10],
    ["Tomato Basil Soup", "Lunch", "Slow-roasted tomato and fresh basil", 850, 7],
    ["Iced Matcha Latte", "Drinks", "Ceremonial matcha, oat milk, light vanilla", 675, 4],
    ["Blueberry Oat Muffin", "Bakery", "Fresh blueberries and a brown sugar crumble", 425, 5],
    ["Roasted Veggie Panini", "Lunch", "Seasonal vegetables, mozzarella, pesto", 1290, 10],
    ["Cold Brew Coffee", "Drinks", "House-steeped single-origin cold brew", 525, 3],
  ];
  const addMenu = db.prepare(
    "INSERT INTO menu_items (name, category, description, price_cents, prep_minutes) VALUES (?, ?, ?, ?, ?)"
  );
  db.exec("BEGIN");
  try {
    for (const item of menuSeeds) addMenu.run(...item);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

if (db.prepare("SELECT COUNT(*) AS count FROM inventory").get().count === 0) {
  const inventorySeeds = [
    ["Avocados", "Produce", 8, "pcs", 12],
    ["Oat milk", "Dairy alternatives", 14, "cartons", 8],
    ["Sourdough bread", "Bakery", 5, "loaves", 8],
    ["Chicken breast", "Proteins", 18, "portions", 10],
    ["Ceremonial matcha", "Dry goods", 4, "tins", 6],
    ["Seasonal vegetables", "Produce", 22, "lbs", 12],
  ];
  const addInventory = db.prepare(
    "INSERT INTO inventory (name, category, quantity, unit, reorder_level) VALUES (?, ?, ?, ?, ?)"
  );
  db.exec("BEGIN");
  try {
    for (const item of inventorySeeds) addInventory.run(...item);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function localDate(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localTimestamp(date = new Date()) {
  const datePart = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const timePart = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
  return `${datePart}T${timePart}`;
}

if (db.prepare("SELECT COUNT(*) AS count FROM orders").get().count === 0) {
  const items = db.prepare("SELECT id, name, price_cents FROM menu_items").all();
  const findItem = (name) => items.find((item) => item.name === name);
  const orderSeeds = [
    { customer: "Emma Wilson", table: "04", status: "Preparing", minutesAgo: 7, items: [["Harvest Bowl", 1], ["Iced Matcha Latte", 1]] },
    { customer: "Oliver Chen", table: "12", status: "Ready", minutesAgo: 17, items: [["Grilled Chicken Wrap", 2], ["Cold Brew Coffee", 1]] },
    { customer: "Sophia Martinez", table: "07", status: "Received", minutesAgo: 26, items: [["Avocado Toast", 1], ["Blueberry Oat Muffin", 1]] },
    { customer: "Noah Patel", table: "02", status: "Completed", minutesAgo: 42, items: [["Roasted Veggie Panini", 1], ["Tomato Basil Soup", 1]] },
    { customer: "Ava Thompson", table: "09", status: "Completed", minutesAgo: 24 * 60 + 18, items: [["Harvest Bowl", 1], ["Cold Brew Coffee", 1]] },
  ];
  const addOrder = db.prepare(
    "INSERT INTO orders (order_number, customer_name, table_number, status, total_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const addOrderItem = db.prepare(
    "INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?)"
  );
  db.exec("BEGIN");
  try {
    for (const [index, order] of orderSeeds.entries()) {
      const orderItems = order.items.map(([name, quantity]) => ({ item: findItem(name), quantity }));
      const total = orderItems.reduce((sum, line) => sum + line.item.price_cents * line.quantity, 0);
      const createdAt = localTimestamp(new Date(Date.now() - order.minutesAgo * 60_000));
      const result = addOrder.run(`ORD-10${24 + index}`, order.customer, order.table, order.status, total, createdAt);
      for (const line of orderItems) {
        addOrderItem.run(result.lastInsertRowid, line.item.id, line.item.name, line.quantity, line.item.price_cents);
      }
    }
    const addActivity = db.prepare("INSERT INTO activity_log (message, kind, created_at) VALUES (?, ?, ?)");
    addActivity.run("Today's service is underway. Your team is ready.", "service", localTimestamp(new Date(Date.now() - 11 * 60_000)));
    addActivity.run("Stock levels reviewed for the morning shift.", "inventory", localTimestamp(new Date(Date.now() - 35 * 60_000)));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const orderSelect = `
  SELECT o.id, o.order_number, o.customer_name, o.table_number, o.status, o.total_cents, o.created_at,
         COALESCE(SUM(oi.quantity), 0) AS item_count,
         GROUP_CONCAT(oi.item_name || ' × ' || oi.quantity, ', ') AS items
  FROM orders o
  LEFT JOIN order_items oi ON oi.order_id = o.id
`;

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(Object.assign(new Error("Request body must be a JSON object"), { status: 400 }));
          return;
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON"), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function requireText(value, label, maxLength = 100) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw Object.assign(new Error(`${label} is required and must be ${maxLength} characters or fewer`), { status: 400 });
  }
  return value.trim();
}

function getDashboard() {
  const today = localDate();
  const stats = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status IN ('Ready', 'Completed') THEN total_cents ELSE 0 END), 0) AS revenue_cents,
      SUM(CASE WHEN status NOT IN ('Completed', 'Cancelled') THEN 1 ELSE 0 END) AS active_orders,
      COUNT(*) AS order_count,
      COALESCE(AVG(total_cents), 0) AS average_cents
    FROM orders WHERE substr(created_at, 1, 10) = ?
  `).get(today);
  const weeklySales = Array.from({ length: 7 }, (_, index) => {
    const date = localDate(index - 6);
    const result = db.prepare(`
      SELECT COALESCE(SUM(total_cents), 0) AS revenue_cents
      FROM orders WHERE substr(created_at, 1, 10) = ? AND status != 'Cancelled'
    `).get(date);
    return { date, revenueCents: result.revenue_cents };
  });
  const orders = db.prepare(`${orderSelect} GROUP BY o.id ORDER BY o.created_at DESC, o.id DESC LIMIT 6`).all();
  const popular = db.prepare(`
    SELECT m.id, m.name, m.category, m.price_cents, COALESCE(SUM(oi.quantity), 0) AS sold
    FROM menu_items m LEFT JOIN order_items oi ON oi.menu_item_id = m.id
    GROUP BY m.id ORDER BY sold DESC, m.name LIMIT 4
  `).all();
  const inventory = db.prepare("SELECT COUNT(*) AS count FROM inventory WHERE quantity <= reorder_level").get();
  const activities = db.prepare("SELECT id, message, kind, created_at FROM activity_log ORDER BY created_at DESC, id DESC LIMIT 5").all();
  return {
    stats: {
      revenueCents: stats.revenue_cents,
      activeOrders: stats.active_orders || 0,
      orderCount: stats.order_count,
      averageCents: Math.round(stats.average_cents),
      lowStockCount: inventory.count,
    },
    weeklySales,
    orders,
    popular,
    activities,
  };
}

function serveStatic(response, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = path.resolve(publicDirectory, `.${requestedPath}`);
  if (!filePath.startsWith(`${publicDirectory}${path.sep}`)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      if (error.code === "ENOENT") {
        sendJson(response, 404, { error: "Page not found" });
      } else {
        console.error("Static file read failed:", error);
        sendJson(response, 500, { error: "Unable to load page" });
      }
      return;
    }
    const extension = path.extname(filePath);
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
    response.writeHead(200, {
      "Content-Type": types[extension] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
    });
    response.end(contents);
  });
}

async function handleApi(request, response, url) {
  const route = url.pathname;
  if (request.method === "GET" && route === "/api/dashboard") {
    sendJson(response, 200, getDashboard());
    return;
  }
  if (request.method === "GET" && route === "/api/orders") {
    const search = (url.searchParams.get("q") || "").trim();
    const status = url.searchParams.get("status");
    const filters = [];
    const values = [];
    if (search) {
      filters.push("(o.order_number LIKE ? OR o.customer_name LIKE ? OR o.table_number LIKE ?)");
      values.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status && status !== "All") {
      if (!["Received", "Preparing", "Ready", "Completed", "Cancelled"].includes(status)) {
        sendJson(response, 400, { error: "Unknown order status" });
        return;
      }
      filters.push("o.status = ?");
      values.push(status);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    sendJson(response, 200, db.prepare(`${orderSelect} ${where} GROUP BY o.id ORDER BY o.created_at DESC, o.id DESC`).all(...values));
    return;
  }
  if (request.method === "POST" && route === "/api/orders") {
    const body = await readBody(request);
    const customer = requireText(body.customerName, "Customer name");
    const table = body.tableNumber === undefined || body.tableNumber === null || body.tableNumber === ""
      ? ""
      : requireText(String(body.tableNumber), "Table number", 20);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) {
      throw Object.assign(new Error("Choose between 1 and 30 menu items"), { status: 400 });
    }
    const orderItems = body.items.map((line) => {
      if (!line || typeof line !== "object" || Array.isArray(line) || !Number.isInteger(line.menuItemId) || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 50) {
        throw Object.assign(new Error("Each item needs a valid menu item and quantity between 1 and 50"), { status: 400 });
      }
      const item = db.prepare("SELECT id, name, price_cents FROM menu_items WHERE id = ? AND available = 1").get(line.menuItemId);
      if (!item) throw Object.assign(new Error("A selected menu item is unavailable"), { status: 400 });
      return { item, quantity: line.quantity };
    });
    const total = orderItems.reduce((sum, line) => sum + line.item.price_cents * line.quantity, 0);
    db.exec("BEGIN");
    try {
      const result = db.prepare(
        "INSERT INTO orders (order_number, customer_name, table_number, status, total_cents, created_at) VALUES (?, ?, ?, 'Received', ?, ?)"
      ).run(`PENDING-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, customer, table, total, localTimestamp());
      const orderId = Number(result.lastInsertRowid);
      const orderNumber = `ORD-${String(orderId).padStart(5, "0")}`;
      db.prepare("UPDATE orders SET order_number = ? WHERE id = ?").run(orderNumber, orderId);
      const addItem = db.prepare(
        "INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?)"
      );
      for (const line of orderItems) {
        addItem.run(orderId, line.item.id, line.item.name, line.quantity, line.item.price_cents);
      }
      db.prepare("INSERT INTO activity_log (message, kind, created_at) VALUES (?, 'order', ?)").run(`New order ${orderNumber} for ${customer}`, localTimestamp());
      db.exec("COMMIT");
      sendJson(response, 201, db.prepare(`${orderSelect} WHERE o.id = ? GROUP BY o.id`).get(orderId));
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return;
  }
  const statusMatch = route.match(/^\/api\/orders\/(\d+)\/status$/);
  if (request.method === "PATCH" && statusMatch) {
    const body = await readBody(request);
    const nextStatus = body.status;
    const allowed = {
      Received: ["Preparing", "Cancelled"],
      Preparing: ["Ready", "Cancelled"],
      Ready: ["Completed", "Cancelled"],
      Completed: [],
      Cancelled: [],
    };
    const order = db.prepare("SELECT id, order_number, status FROM orders WHERE id = ?").get(Number(statusMatch[1]));
    if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
    if (!allowed[order.status].includes(nextStatus)) {
      throw Object.assign(new Error(`Order cannot move from ${order.status} to ${nextStatus || "that status"}`), { status: 400 });
    }
    db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(nextStatus, order.id);
    db.prepare("INSERT INTO activity_log (message, kind, created_at) VALUES (?, 'order', ?)").run(`${order.order_number} moved to ${nextStatus}`, localTimestamp());
    sendJson(response, 200, { id: order.id, status: nextStatus });
    return;
  }
  if (request.method === "GET" && route === "/api/menu") {
    const items = db.prepare("SELECT id, name, category, description, price_cents, prep_minutes, available FROM menu_items ORDER BY category, name").all();
    sendJson(response, 200, items);
    return;
  }
  if (request.method === "POST" && route === "/api/menu") {
    const body = await readBody(request);
    const name = requireText(body.name, "Item name");
    const category = requireText(body.category, "Category", 50);
    const description = typeof body.description === "string" ? body.description.trim().slice(0, 250) : "";
    const priceCents = Math.round(Number(body.price) * 100);
    const prepMinutes = Number(body.prepMinutes);
    if (!Number.isFinite(priceCents) || priceCents < 1 || priceCents > 1_000_000 || !Number.isInteger(prepMinutes) || prepMinutes < 1 || prepMinutes > 240) {
      throw Object.assign(new Error("Enter a valid price and preparation time"), { status: 400 });
    }
    const result = db.prepare(
      "INSERT INTO menu_items (name, category, description, price_cents, prep_minutes) VALUES (?, ?, ?, ?, ?)"
    ).run(name, category, description, priceCents, prepMinutes);
    const item = db.prepare("SELECT id, name, category, description, price_cents, prep_minutes, available FROM menu_items WHERE id = ?").get(Number(result.lastInsertRowid));
    sendJson(response, 201, item);
    return;
  }
  if (request.method === "GET" && route === "/api/inventory") {
    sendJson(response, 200, db.prepare("SELECT id, name, category, quantity, unit, reorder_level, updated_at FROM inventory ORDER BY quantity <= reorder_level DESC, name").all());
    return;
  }
  const restockMatch = route.match(/^\/api\/inventory\/(\d+)\/restock$/);
  if (request.method === "POST" && restockMatch) {
    const body = await readBody(request);
    const quantity = body.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) {
      throw Object.assign(new Error("Restock quantity must be a whole number between 1 and 10,000"), { status: 400 });
    }
    const item = db.prepare("SELECT id, name, quantity, unit FROM inventory WHERE id = ?").get(Number(restockMatch[1]));
    if (!item) throw Object.assign(new Error("Inventory item not found"), { status: 404 });
    db.prepare("UPDATE inventory SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(quantity, item.id);
    db.prepare("INSERT INTO activity_log (message, kind, created_at) VALUES (?, 'inventory', ?)").run(`${item.name} restocked with ${quantity} ${item.unit}`, localTimestamp());
    sendJson(response, 200, db.prepare("SELECT id, name, category, quantity, unit, reorder_level, updated_at FROM inventory WHERE id = ?").get(item.id));
    return;
  }
  sendJson(response, 404, { error: "API route not found" });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(request, response, url);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error("API request failed:", error);
      if (!response.headersSent) sendJson(response, status, { error: status >= 500 ? "The request could not be completed" : error.message });
    }
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  serveStatic(response, url.pathname);
});

server.listen(port, () => {
  console.log(`Harbor Cafe is running at http://localhost:${port}`);
  console.log(`SQLite database: ${databasePath}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => {
    db.close();
    process.exit(0);
  }));
}
