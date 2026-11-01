import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "../../database/src/index.js";

const publicDirectory = path.resolve(process.cwd(), "frontend", "dist");
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

const orderSelect = `
  SELECT o.id, o.order_number, o.customer_name, o.table_number, o.status, o.total_cents, o.created_at,
         COALESCE(SUM(oi.quantity), 0) AS item_count,
         GROUP_CONCAT(oi.item_name || ' × ' || oi.quantity, ', ') AS items
  FROM orders o
  LEFT JOIN order_items oi ON oi.order_id = o.id
`;

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
  response.end(JSON.stringify(payload));
}

export function readBody(request: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let body = "";
    let byteLength = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      byteLength += chunk.length;
      if (byteLength > 1_000_000) tooLarge = true;
      else if (!tooLarge) body += chunk.toString("utf8");
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
        return;
      }
      try {
      const parsed: unknown = body ? JSON.parse(body) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(Object.assign(new Error("Request body must be a JSON object"), { status: 400 }));
          return;
        }
        resolve(parsed as Record<string, any>);
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON"), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function requireText(value: unknown, label: string, maxLength = 100): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw Object.assign(new Error(`${label} is required and must be ${maxLength} characters or fewer`), { status: 400 });
  }
  return value.trim();
}

function requirePriceCents(value: unknown): number {
  const price = typeof value === "number" ? String(value) : value;
  if (typeof price !== "string" || !/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(price)) {
    throw Object.assign(new Error("Enter a valid price with up to two decimal places"), { status: 400 });
  }
  const [whole = "0", fraction = ""] = price.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 1_000_000) {
    throw Object.assign(new Error("Price must be between $0.01 and $10,000.00"), { status: 400 });
  }
  return cents;
}

function getDashboard() {
  const today = localDate();
  const tomorrow = localDate(1);
  const stats = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status IN ('Ready', 'Completed') THEN total_cents ELSE 0 END), 0) AS revenue_cents,
      SUM(CASE WHEN status NOT IN ('Completed', 'Cancelled') THEN 1 ELSE 0 END) AS active_orders,
      COUNT(*) AS order_count,
      COALESCE(AVG(CASE WHEN status IN ('Ready', 'Completed') THEN total_cents END), 0) AS average_cents
    FROM orders WHERE created_at >= ? AND created_at < ?
  `).get(today, tomorrow)!;
  const firstSalesDate = localDate(-6);
  const dailySales = db.prepare(`
    SELECT substr(created_at, 1, 10) AS date, COALESCE(SUM(total_cents), 0) AS revenue_cents
    FROM orders WHERE created_at >= ? AND created_at < ? AND status IN ('Ready', 'Completed')
    GROUP BY substr(created_at, 1, 10)
  `).all(firstSalesDate, tomorrow);
  const salesByDate = new Map(dailySales.map((day) => [day.date, day.revenue_cents]));
  const weeklySales = Array.from({ length: 7 }, (_, index) => {
    const date = localDate(index - 6);
    return { date, revenueCents: salesByDate.get(date) || 0 };
  });
  const orders = db.prepare(`${orderSelect} GROUP BY o.id ORDER BY o.created_at DESC, o.id DESC LIMIT 6`).all();
  const popular = db.prepare(`
    SELECT m.id, m.name, m.category, m.price_cents, COALESCE(SUM(oi.quantity), 0) AS sold
    FROM menu_items m LEFT JOIN order_items oi ON oi.menu_item_id = m.id
      AND EXISTS (SELECT 1 FROM orders o WHERE o.id = oi.order_id AND o.created_at >= ? AND o.created_at < ? AND o.status IN ('Ready', 'Completed'))
    GROUP BY m.id ORDER BY sold DESC, m.name LIMIT 4
  `).all(firstSalesDate, tomorrow);
  const inventory = db.prepare("SELECT COUNT(*) AS count FROM inventory WHERE quantity <= reorder_level").get()!;
  const activities = db.prepare("SELECT id, message, kind, created_at FROM activity_log ORDER BY created_at DESC, id DESC LIMIT 5").all();
  return {
    stats: {
      revenueCents: stats.revenue_cents,
      activeOrders: stats.active_orders || 0,
      orderCount: stats.order_count,
      averageCents: Math.round(Number(stats.average_cents)),
      lowStockCount: inventory.count,
    },
    weeklySales,
    orders,
    popular,
    activities,
  };
}

export function serveStatic(response: ServerResponse, pathname: string): void {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: "Invalid URL path" });
    return;
  }
  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
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
    const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
    response.writeHead(200, {
      "Content-Type": types[extension] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-cache",
    });
    response.end(response.req?.method === "HEAD" ? undefined : contents);
  });
}

export async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
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
    const isPaginatedRequest = url.searchParams.has("page") || url.searchParams.has("pageSize");
    const selectOrders = `${orderSelect} ${where} GROUP BY o.id ORDER BY o.created_at DESC, o.id DESC`;
    if (!isPaginatedRequest) {
      sendJson(response, 200, db.prepare(selectOrders).all(...values));
      return;
    }
    const page = Number(url.searchParams.get("page") || 1);
    const pageSize = Number(url.searchParams.get("pageSize") || 25);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      sendJson(response, 400, { error: "Page must be positive and page size must be between 1 and 100" });
      return;
    }
    const total = db.prepare(`SELECT COUNT(*) AS count FROM orders o ${where}`).get(...values)!.count;
    const items = db.prepare(`${selectOrders} LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (page - 1) * pageSize);
    sendJson(response, 200, { items, total, page, pageSize });
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
    const total = orderItems.reduce((sum, line) => sum + Number(line.item.price_cents) * line.quantity, 0);
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
    const allowed: Record<string, string[]> = {
      Received: ["Preparing", "Cancelled"],
      Preparing: ["Ready", "Cancelled"],
      Ready: ["Completed", "Cancelled"],
      Completed: [],
      Cancelled: [],
    };
    const order = db.prepare("SELECT id, order_number, status FROM orders WHERE id = ?").get(Number(statusMatch[1]));
    if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
    const currentStatus = String(order.status);
    if (!allowed[currentStatus]?.includes(nextStatus)) {
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
    const priceCents = requirePriceCents(body.price);
    const prepMinutes = Number(body.prepMinutes);
    if (!Number.isInteger(prepMinutes) || prepMinutes < 1 || prepMinutes > 240) {
      throw Object.assign(new Error("Enter a valid price and preparation time"), { status: 400 });
    }
    const result = db.prepare(
      "INSERT INTO menu_items (name, category, description, price_cents, prep_minutes) VALUES (?, ?, ?, ?, ?)"
    ).run(name, category, description, priceCents, prepMinutes);
    const item = db.prepare("SELECT id, name, category, description, price_cents, prep_minutes, available FROM menu_items WHERE id = ?").get(Number(result.lastInsertRowid));
    sendJson(response, 201, item);
    return;
  }
  const menuMatch = route.match(/^\/api\/menu\/(\d+)$/);
  if (request.method === "PATCH" && menuMatch) {
    const body = await readBody(request);
    const id = Number(menuMatch[1]);
    const current = db.prepare("SELECT id, name, category, description, price_cents, prep_minutes, available FROM menu_items WHERE id = ?").get(id);
    if (!current) throw Object.assign(new Error("Menu item not found"), { status: 404 });
    if (Object.hasOwn(body, "available")) {
      if (typeof body.available !== "boolean") throw Object.assign(new Error("Availability must be true or false"), { status: 400 });
      db.prepare("UPDATE menu_items SET available = ? WHERE id = ?").run(Number(body.available), id);
    } else {
      const name = requireText(body.name, "Item name");
      const category = requireText(body.category, "Category", 50);
      const description = typeof body.description === "string" ? body.description.trim().slice(0, 250) : "";
      const priceCents = requirePriceCents(body.price);
      const prepMinutes = Number(body.prepMinutes);
      if (!Number.isInteger(prepMinutes) || prepMinutes < 1 || prepMinutes > 240) {
        throw Object.assign(new Error("Enter a valid price and preparation time"), { status: 400 });
      }
      db.prepare("UPDATE menu_items SET name = ?, category = ?, description = ?, price_cents = ?, prep_minutes = ? WHERE id = ?")
        .run(name, category, description, priceCents, prepMinutes, id);
    }
    const item = db.prepare("SELECT id, name, category, description, price_cents, prep_minutes, available FROM menu_items WHERE id = ?").get(id);
    sendJson(response, 200, item);
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
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 10_000) {
      throw Object.assign(new Error("Quantity must be a whole number between 0 and 10,000"), { status: 400 });
    }
    const reorderLevel = body.reorderLevel === undefined || body.reorderLevel === null || body.reorderLevel === ""
      ? null : body.reorderLevel;
    if (reorderLevel !== null && (!Number.isInteger(reorderLevel) || reorderLevel < 0 || reorderLevel > 1_000_000)) {
      throw Object.assign(new Error("Reorder level must be a whole number between 0 and 1,000,000"), { status: 400 });
    }
    if (quantity === 0 && reorderLevel === null) {
      throw Object.assign(new Error("Enter a restock quantity or a new reorder point"), { status: 400 });
    }
    const item = db.prepare("SELECT id, name, quantity, unit FROM inventory WHERE id = ?").get(Number(restockMatch[1]));
    if (!item) throw Object.assign(new Error("Inventory item not found"), { status: 404 });
    if (item.quantity + quantity > 1_000_000_000) throw Object.assign(new Error("The resulting quantity is too large"), { status: 400 });
    db.prepare("UPDATE inventory SET quantity = quantity + ?, reorder_level = COALESCE(?, reorder_level), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(quantity, reorderLevel, item.id);
    const note = reorderLevel === null ? "" : `; reorder point set to ${reorderLevel} ${item.unit}`;
    db.prepare("INSERT INTO activity_log (message, kind, created_at) VALUES (?, 'inventory', ?)").run(`${item.name} restocked with ${quantity} ${item.unit}${note}`, localTimestamp());
    sendJson(response, 200, db.prepare("SELECT id, name, category, quantity, unit, reorder_level, updated_at FROM inventory WHERE id = ?").get(item.id));
    return;
  }
  sendJson(response, 404, { error: "API route not found" });
}
