
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

function requirePositiveQuantity(value: unknown, label: string): number {
  const quantity = Number(value);

  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
    throw Object.assign(new Error(`${label} must be greater than 0 and no more than 1,000,000`), { status: 400 });
  }

  return quantity;
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
  let decodedPath: string;

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

    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
    };

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

export async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const route = url.pathname;

  // Dashboard
  if (request.method === "GET" && route === "/api/dashboard") {
    sendJson(response, 200, getDashboard());
    return;
  }

  // Orders: list, search, filter, and pagination
  if (request.method === "GET" && route === "/api/orders") {
    const search = (url.searchParams.get("q") || "").trim();
    const status = url.searchParams.get("status");

    const filters: string[] = [];
    const values: any[] = [];

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

  // Orders: create and automatically deduct recipe ingredients
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
      if (
        !line ||
        typeof line !== "object" ||
        Array.isArray(line) ||
        !Number.isInteger(line.menuItemId) ||
        !Number.isInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity > 50
      ) {
        throw Object.assign(new Error("Each item needs a valid menu item and quantity between 1 and 50"), { status: 400 });
      }

      const item = db.prepare(
        "SELECT id, name, price_cents FROM menu_items WHERE id = ? AND available = 1",
      ).get(line.menuItemId);

      if (!item) {
        throw Object.assign(new Error("A selected menu item is unavailable"), { status: 400 });
      }

      return { item, quantity: line.quantity };
    });

    const total = orderItems.reduce(
      (sum, line) => sum + Number(line.item.price_cents) * line.quantity,
      0,
    );

    db.exec("BEGIN");

    try {
      const result = db.prepare(
        "INSERT INTO orders (order_number, customer_name, table_number, status, total_cents, created_at) VALUES (?, ?, ?, 'Received', ?, ?)",
      ).run(
        `PENDING-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        customer,
        table,
        total,
        localTimestamp(),
      );

      const orderId = Number(result.lastInsertRowid);
      const orderNumber = `ORD-${String(orderId).padStart(5, "0")}`;

      db.prepare("UPDATE orders SET order_number = ? WHERE id = ?").run(orderNumber, orderId);

      const addItem = db.prepare(
        "INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?)",
      );

      for (const line of orderItems) {
        addItem.run(orderId, line.item.id, line.item.name, line.quantity, line.item.price_cents);
      }

      // Combine ingredient requirements across all ordered menu items.
      const requiredIngredients = new Map<number, number>();

      for (const line of orderItems) {
        const recipeRows = db.prepare(
          "SELECT inventory_id, quantity_required FROM recipe_ingredients WHERE menu_item_id = ?",
        ).all(line.item.id);

        for (const recipe of recipeRows) {
          const inventoryId = Number(recipe.inventory_id);
          const required = Number(recipe.quantity_required) * line.quantity;

          requiredIngredients.set(
            inventoryId,
            (requiredIngredients.get(inventoryId) || 0) + required,
          );
        }
      }

      // Check and deduct stock inside the same order transaction.
      for (const [inventoryId, requiredQuantity] of requiredIngredients) {
        const stock = db.prepare(
          "SELECT id, name, quantity, unit FROM inventory WHERE id = ?",
        ).get(inventoryId);

        if (!stock) {
          throw Object.assign(new Error("A recipe ingredient no longer exists in inventory"), { status: 400 });
        }

        if (Number(stock.quantity) < requiredQuantity) {
          throw Object.assign(
            new Error(
              `Insufficient stock for ${stock.name}. Required: ${requiredQuantity} ${stock.unit}; available: ${stock.quantity} ${stock.unit}.`,
            ),
            { status: 400 },
          );
        }

        const deduction = db.prepare(
          "UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND quantity >= ?",
        ).run(requiredQuantity, inventoryId, requiredQuantity);

        if (Number(deduction.changes) !== 1) {
          throw Object.assign(new Error(`Unable to reserve enough stock for ${stock.name}`), { status: 400 });
        }

        db.prepare(`
          INSERT INTO inventory_movements
            (inventory_id, order_id, movement_type, quantity_change, note)
          VALUES (?, ?, 'order_deduction', ?, ?)
        `).run(
          inventoryId,
          orderId,
          -requiredQuantity,
          `Ingredients used for ${orderNumber}`,
        );
      }

      db.prepare(
        "INSERT INTO activity_log (message, kind, created_at) VALUES (?, 'order', ?)",
      ).run(`New order ${orderNumber} for ${customer}`, localTimestamp());

      db.exec("COMMIT");

      sendJson(
        response,
        201,
        db.prepare(`${orderSelect} WHERE o.id = ? GROUP BY o.id`).get(orderId),
      );
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return;
  }

  // Orders: update status and restore ingredients when cancelled
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

    db.exec("BEGIN");

    try {
      const order = db.prepare(
        "SELECT id, order_number, status FROM orders WHERE id = ?",
      ).get(Number(statusMatch[1]));

      if (!order) {
        throw Object.assign(new Error("Order not found"), { status: 404 });
      }

      const currentStatus = String(order.status);

      if (!allowed[currentStatus]?.includes(nextStatus)) {
        throw Object.assign(
          new Error(`Order cannot move from ${order.status} to ${nextStatus || "that status"}`),
          { status: 400 },
        );
      }

      // Restore only stock deducted by this order.
      // Older orders have no movement records and are left unchanged.
      if (nextStatus === "Cancelled") {
        const deductions = db.prepare(`
          SELECT inventory_id, quantity_change
          FROM inventory_movements
          WHERE order_id = ? AND movement_type = 'order_deduction'
        `).all(order.id);

        for (const deduction of deductions) {
          const alreadyRestored = db.prepare(`
            SELECT id
            FROM inventory_movements
            WHERE order_id = ?
              AND inventory_id = ?
              AND movement_type = 'order_restoration'
          `).get(order.id, deduction.inventory_id);

          if (alreadyRestored) continue;

          const restoredQuantity = Math.abs(Number(deduction.quantity_change));

          db.prepare(`
            UPDATE inventory
            SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(restoredQuantity, deduction.inventory_id);

          db.prepare(`
            INSERT INTO inventory_movements
              (inventory_id, order_id, movement_type, quantity_change, note)
            VALUES (?, ?, 'order_restoration', ?, ?)
          `).run(
            deduction.inventory_id,
            order.id,
            restoredQuantity,
            `Stock restored after cancelling ${order.order_number}`,
          );
        }
      }

      db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(nextStatus, order.id);

      db.prepare(
        "INSERT INTO activity_log (message, kind, created_at) VALUES (?, 'order', ?)",
      ).run(`${order.order_number} moved to ${nextStatus}`, localTimestamp());

      db.exec("COMMIT");

      sendJson(response, 200, { id: order.id, status: nextStatus });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return;
  }

  // Menu: list
  if (request.method === "GET" && route === "/api/menu") {
    const items = db.prepare(
      "SELECT id, name, category, description, price_cents, prep_minutes, available FROM menu_items ORDER BY category, name",
    ).all();

    sendJson(response, 200, items);
    return;
  }

  // Menu: create
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
      "INSERT INTO menu_items (name, category, description, price_cents, prep_minutes) VALUES (?, ?, ?, ?, ?)",
    ).run(name, category, description, priceCents, prepMinutes);

    const item = db.prepare(
      "SELECT id, name, category, description, price_cents, prep_minutes, available FROM menu_items WHERE id = ?",
    ).get(Number(result.lastInsertRowid));

    sendJson(response, 201, item);
    return;
  }

  // Menu: get recipe and its current inventory information
  const recipeMatch = route.match(/^\/api\/menu\/(\d+)\/recipe$/);

  if (request.method === "GET" && recipeMatch) {
    const menuItemId = Number(recipeMatch[1]);

    const menuItem = db.prepare(
      "SELECT id, name FROM menu_items WHERE id = ?",
    ).get(menuItemId);

    if (!menuItem) {
      throw Object.assign(new Error("Menu item not found"), { status: 404 });
    }

    const ingredients = db.prepare(`
      SELECT
        ri.inventory_id AS inventoryId,
        i.name AS inventoryName,
        i.category,
        ri.quantity_required AS quantityRequired,
        i.unit,
        i.quantity AS currentQuantity,
        i.reorder_level AS reorderLevel
      FROM recipe_ingredients ri
      JOIN inventory i ON i.id = ri.inventory_id
      WHERE ri.menu_item_id = ?
      ORDER BY i.name
    `).all(menuItemId);

    sendJson(response, 200, { menuItem, ingredients });
    return;
  }

  // Menu: replace recipe ingredients
  if (request.method === "PUT" && recipeMatch) {
    const menuItemId = Number(recipeMatch[1]);
    const body = await readBody(request);

    if (!Array.isArray(body.ingredients) || body.ingredients.length > 30) {
      throw Object.assign(
        new Error("Ingredients must be an array containing no more than 30 items"),
        { status: 400 },
      );
    }

    const menuItem = db.prepare(
      "SELECT id, name FROM menu_items WHERE id = ?",
    ).get(menuItemId);

    if (!menuItem) {
      throw Object.assign(new Error("Menu item not found"), { status: 404 });
    }

    const ingredients = body.ingredients.map((ingredient: any) => {
      if (
        !ingredient ||
        typeof ingredient !== "object" ||
        Array.isArray(ingredient) ||
        !Number.isInteger(ingredient.inventoryId)
      ) {
        throw Object.assign(new Error("Each ingredient needs a valid inventory item"), { status: 400 });
      }

      return {
        inventoryId: ingredient.inventoryId,
        quantityRequired: requirePositiveQuantity(
          ingredient.quantityRequired,
          "Ingredient quantity",
        ),
      };
    });

    const ingredientIds = ingredients.map((ingredient: any) => ingredient.inventoryId);

    if (new Set(ingredientIds).size !== ingredientIds.length) {
      throw Object.assign(new Error("An inventory item can only appear once in a recipe"), { status: 400 });
    }

    db.exec("BEGIN");

    try {
      const insertIngredient = db.prepare(`
        INSERT INTO recipe_ingredients
          (menu_item_id, inventory_id, quantity_required)
        VALUES (?, ?, ?)
      `);

      db.prepare(
        "DELETE FROM recipe_ingredients WHERE menu_item_id = ?",
      ).run(menuItemId);

      for (const ingredient of ingredients) {
        const inventoryItem = db.prepare(
          "SELECT id FROM inventory WHERE id = ?",
        ).get(ingredient.inventoryId);

        if (!inventoryItem) {
          throw Object.assign(
            new Error(`Inventory item ${ingredient.inventoryId} was not found`),
            { status: 400 },
          );
        }

        insertIngredient.run(
          menuItemId,
          ingredient.inventoryId,
          ingredient.quantityRequired,
        );
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const savedIngredients = db.prepare(`
      SELECT
        ri.inventory_id AS inventoryId,
        i.name AS inventoryName,
        i.category,
        ri.quantity_required AS quantityRequired,
        i.unit,
        i.quantity AS currentQuantity,
        i.reorder_level AS reorderLevel
      FROM recipe_ingredients ri
      JOIN inventory i ON i.id = ri.inventory_id
      WHERE ri.menu_item_id = ?
      ORDER BY i.name
    `).all(menuItemId);

    sendJson(response, 200, { menuItem, ingredients: savedIngredients });
    return;
  }

  // Menu: update availability or item details
  const menuMatch = route.match(/^\/api\/menu\/(\d+)$/);

  if (request.method === "PATCH" && menuMatch) {
    const body = await readBody(request);
    const id = Number(menuMatch[1]);

    const current = db.prepare(
      "SELECT id, name, category, description, price_cents, prep_minutes, available FROM menu_items WHERE id = ?",
    ).get(id);

    if (!current) {
      throw Object.assign(new Error("Menu item not found"), { status: 404 });
    }

    if (Object.hasOwn(body, "available")) {
      if (typeof body.available !== "boolean") {
        throw Object.assign(new Error("Availability must be true or false"), { status: 400 });
      }

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

      db.prepare(
        "UPDATE menu_items SET name = ?, category = ?, description = ?, price_cents = ?, prep_minutes = ? WHERE id = ?",
      ).run(name, category, description, priceCents, prepMinutes, id);
    }

    const item = db.prepare(
      "SELECT id, name, category, description, price_cents, prep_minutes, available FROM menu_items WHERE id = ?",
    ).get(id);

    sendJson(response, 200, item);
    return;
  }

  // Inventory: list
  if (request.method === "GET" && route === "/api/inventory") {
    sendJson(
      response,
      200,
      db.prepare(
        "SELECT id, name, category, quantity, unit, reorder_level, updated_at FROM inventory ORDER BY quantity <= reorder_level DESC, name",
      ).all(),
    );
    return;
  }

  // Inventory: restock and record the movement
  const restockMatch = route.match(/^\/api\/inventory\/(\d+)\/restock$/);

  if (request.method === "POST" && restockMatch) {
    const body = await readBody(request);
    const quantity = body.quantity;

    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 10_000) {
      throw Object.assign(new Error("Quantity must be a whole number between 0 and 10,000"), { status: 400 });
    }

    const reorderLevel =
      body.reorderLevel === undefined || body.reorderLevel === null || body.reorderLevel === ""
        ? null
        : body.reorderLevel;

    if (
      reorderLevel !== null &&
      (!Number.isInteger(reorderLevel) || reorderLevel < 0 || reorderLevel > 1_000_000)
    ) {
      throw Object.assign(new Error("Reorder level must be a whole number between 0 and 1,000,000"), { status: 400 });
    }

    if (quantity === 0 && reorderLevel === null) {
      throw Object.assign(new Error("Enter a restock quantity or a new reorder point"), { status: 400 });
    }

    const item = db.prepare(
      "SELECT id, name, quantity, unit FROM inventory WHERE id = ?",
    ).get(Number(restockMatch[1]));

    if (!item) {
      throw Object.assign(new Error("Inventory item not found"), { status: 404 });
    }

    if (Number(item.quantity) + quantity > 1_000_000_000) {
      throw Object.assign(new Error("The resulting quantity is too large"), { status: 400 });
    }

    db.exec("BEGIN");

    try {
      db.prepare(`
        UPDATE inventory
        SET quantity = quantity + ?,
            reorder_level = COALESCE(?, reorder_level),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(quantity, reorderLevel, item.id);

      if (quantity > 0) {
        db.prepare(`
          INSERT INTO inventory_movements
            (inventory_id, movement_type, quantity_change, note)
          VALUES (?, 'restock', ?, ?)
        `).run(
          item.id,
          quantity,
          `Restocked ${quantity} ${item.unit}`,
        );
      }

      const note = reorderLevel === null
        ? ""
        : `; reorder point set to ${reorderLevel} ${item.unit}`;

      db.prepare(
        "INSERT INTO activity_log (message, kind, created_at) VALUES (?, 'inventory', ?)",
      ).run(
        `${item.name} restocked with ${quantity} ${item.unit}${note}`,
        localTimestamp(),
      );

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    sendJson(
      response,
      200,
      db.prepare(
        "SELECT id, name, category, quantity, unit, reorder_level, updated_at FROM inventory WHERE id = ?",
      ).get(item.id),
    );
    return;
  }

  sendJson(response, 404, { error: "API route not found" });
}
