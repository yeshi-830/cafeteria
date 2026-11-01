import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const databasePath = process.env.CAFETERIA_DB_PATH || path.resolve(process.cwd(), "cafeteria.db");
export const db = new DatabaseSync(databasePath);

db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    prep_minutes INTEGER NOT NULL DEFAULT 10 CHECK (prep_minutes > 0),
    available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0), unit TEXT NOT NULL,
    reorder_level INTEGER NOT NULL DEFAULT 10 CHECK (reorder_level >= 0),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY, order_number TEXT NOT NULL UNIQUE, customer_name TEXT NOT NULL,
    table_number TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('Received', 'Preparing', 'Ready', 'Completed', 'Cancelled')),
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL, item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0), unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
  );
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY, message TEXT NOT NULL, kind TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
`);

function localTimestamp(date = new Date()): string {
  const datePart = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const timePart = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
  return `${datePart}T${timePart}`;
}

function seedMenu(): void {
  if (db.prepare("SELECT COUNT(*) AS count FROM menu_items").get()!.count !== 0) return;
  const items = [
    ["Avocado Toast", "Breakfast", "Sourdough, smashed avocado, chili flakes", 1250, 8],
    ["Harvest Bowl", "Lunch", "Roasted vegetables, grains, herbed tahini", 1490, 12],
    ["Grilled Chicken Wrap", "Lunch", "Herb chicken, crisp greens, garlic yogurt", 1390, 10],
    ["Tomato Basil Soup", "Lunch", "Slow-roasted tomato and fresh basil", 850, 7],
    ["Iced Matcha Latte", "Drinks", "Ceremonial matcha, oat milk, light vanilla", 675, 4],
    ["Blueberry Oat Muffin", "Bakery", "Fresh blueberries and a brown sugar crumble", 425, 5],
    ["Roasted Veggie Panini", "Lunch", "Seasonal vegetables, mozzarella, pesto", 1290, 10],
    ["Cold Brew Coffee", "Drinks", "House-steeped single-origin cold brew", 525, 3],
  ];
  const insert = db.prepare("INSERT INTO menu_items (name, category, description, price_cents, prep_minutes) VALUES (?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    for (const item of items) insert.run(...item);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function seedInventory(): void {
  if (db.prepare("SELECT COUNT(*) AS count FROM inventory").get()!.count !== 0) return;
  const items = [
    ["Avocados", "Produce", 8, "pcs", 12], ["Oat milk", "Dairy alternatives", 14, "cartons", 8],
    ["Sourdough bread", "Bakery", 5, "loaves", 8], ["Chicken breast", "Proteins", 18, "portions", 10],
    ["Ceremonial matcha", "Dry goods", 4, "tins", 6], ["Seasonal vegetables", "Produce", 22, "lbs", 12],
  ];
  const insert = db.prepare("INSERT INTO inventory (name, category, quantity, unit, reorder_level) VALUES (?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    for (const item of items) insert.run(...item);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function seedOrders(): void {
  if (db.prepare("SELECT COUNT(*) AS count FROM orders").get()!.count !== 0) return;
  const menu = db.prepare("SELECT id, name, price_cents FROM menu_items").all() as Array<{ id: number; name: string; price_cents: number }>;
  const orderSeeds: Array<{ customer: string; table: string; status: string; minutesAgo: number; items: Array<[string, number]> }> = [
    { customer: "Emma Wilson", table: "04", status: "Preparing", minutesAgo: 7, items: [["Harvest Bowl", 1], ["Iced Matcha Latte", 1]] },
    { customer: "Oliver Chen", table: "12", status: "Ready", minutesAgo: 17, items: [["Grilled Chicken Wrap", 2], ["Cold Brew Coffee", 1]] },
    { customer: "Sophia Martinez", table: "07", status: "Received", minutesAgo: 26, items: [["Avocado Toast", 1], ["Blueberry Oat Muffin", 1]] },
    { customer: "Noah Patel", table: "02", status: "Completed", minutesAgo: 42, items: [["Roasted Veggie Panini", 1], ["Tomato Basil Soup", 1]] },
    { customer: "Ava Thompson", table: "09", status: "Completed", minutesAgo: 24 * 60 + 18, items: [["Harvest Bowl", 1], ["Cold Brew Coffee", 1]] },
  ];
  const addOrder = db.prepare("INSERT INTO orders (order_number, customer_name, table_number, status, total_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const addItem = db.prepare("INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    orderSeeds.forEach((order, index) => {
      const lines = order.items.map(([name, quantity]) => {
        const item = menu.find((entry) => entry.name === name)!;
        return { item, quantity };
      });
      const total = lines.reduce((sum, line) => sum + line.item.price_cents * line.quantity, 0);
      const result = addOrder.run(`ORD-10${24 + index}`, order.customer, order.table, order.status, total, localTimestamp(new Date(Date.now() - order.minutesAgo * 60_000)));
      for (const line of lines) addItem.run(result.lastInsertRowid, line.item.id, line.item.name, line.quantity, line.item.price_cents);
    });
    const activity = db.prepare("INSERT INTO activity_log (message, kind, created_at) VALUES (?, ?, ?)");
    activity.run("Today's service is underway. Your team is ready.", "service", localTimestamp(new Date(Date.now() - 11 * 60_000)));
    activity.run("Stock levels reviewed for the morning shift.", "inventory", localTimestamp(new Date(Date.now() - 35 * 60_000)));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

seedMenu();
seedInventory();
seedOrders();
