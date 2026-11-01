const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { DatabaseSync } = require("node:sqlite");
const { after, before, test } = require("node:test");

const project = path.resolve(__dirname, "..");
let serverProcess;
let baseUrl;
let tempDirectory;
let sessionCookie;

async function availablePort() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function request(route, options) {
  const headers = { ...(sessionCookie ? { cookie: sessionCookie } : {}), ...options?.headers };
  const response = await fetch(`${baseUrl}${route}`, { ...options, headers });
  const body = await response.json();
  return { response, body };
}

function createLegacyDatabase(databasePath) {
  const legacyDb = new DatabaseSync(databasePath);
  legacyDb.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE menu_items (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      prep_minutes INTEGER NOT NULL DEFAULT 10 CHECK (prep_minutes > 0),
      available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE inventory (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0), unit TEXT NOT NULL,
      reorder_level INTEGER NOT NULL DEFAULT 10 CHECK (reorder_level >= 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY, order_number TEXT NOT NULL UNIQUE, customer_name TEXT NOT NULL,
      table_number TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('Received', 'Preparing', 'Ready', 'Completed', 'Cancelled')),
      total_cents INTEGER NOT NULL CHECK (total_cents >= 0), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL, item_name TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0), unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
    );
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY, message TEXT NOT NULL, kind TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO menu_items (id, name, category, price_cents) VALUES (41, 'Legacy Avocado Toast', 'Breakfast', 1250);
    INSERT INTO inventory (id, name, category, quantity, unit, reorder_level) VALUES (51, 'Legacy Avocados', 'Produce', 8, 'pcs', 12);
    INSERT INTO orders (id, order_number, customer_name, table_number, status, total_cents)
      VALUES (61, 'ORD-LEGACY', 'Existing Customer', '04', 'Completed', 2500);
    INSERT INTO order_items (id, order_id, menu_item_id, item_name, quantity, unit_price_cents)
      VALUES (71, 61, 41, 'Legacy Avocado Toast', 2, 1250);
    INSERT INTO activity_log (id, message, kind) VALUES (81, 'Legacy activity record', 'service');
  `);
  legacyDb.close();
}

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cafeteria-tests-"));
  const databasePath = path.join(tempDirectory, "test.db");
  createLegacyDatabase(databasePath);
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [path.join(project, "dist", "backend", "src", "server.js")], {
    cwd: project,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      CAFETERIA_DB_PATH: databasePath,
      CAFETERIA_ADMIN_USERNAME: "test-admin",
      CAFETERIA_ADMIN_PASSWORD: "test-admin-password-123",
    },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (serverProcess.exitCode !== null) throw new Error(`Server exited with ${serverProcess.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      if (response.status === 401) {
        const login = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "test-admin", password: "test-admin-password-123" }),
        });
        if (!login.ok) throw new Error(`Admin login failed with ${login.status}`);
        sessionCookie = login.headers.get("set-cookie")?.split(";")[0];
        if (!sessionCookie) throw new Error("Admin login did not set a session cookie");
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become ready");
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill();
    await once(serverProcess, "exit");
  }
  if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test("serves the dashboard with security headers and rejects malformed paths", async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  const malformed = await fetch(`${baseUrl}/%zz`);
  assert.equal(malformed.status, 400);
  const traversal = await fetch(`${baseUrl}/..%2fserver.js`);
  assert.equal(traversal.status, 403);
});

test("adds authentication tables without replacing existing cafe records", async () => {
  const [menu, inventory, orders, dashboard] = await Promise.all([
    request("/api/menu"),
    request("/api/inventory"),
    request("/api/orders"),
    request("/api/dashboard"),
  ]);
  assert.equal(menu.body.length, 1);
  assert.equal(menu.body[0].name, "Legacy Avocado Toast");
  assert.equal(inventory.body.length, 1);
  assert.equal(inventory.body[0].name, "Legacy Avocados");
  assert.equal(orders.body.length, 1);
  assert.equal(orders.body[0].order_number, "ORD-LEGACY");
  assert.equal(dashboard.body.activities[0].message, "Legacy activity record");
});

test("requires a session and restricts manager operations to their role", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(unauthenticated.status, 401);
  const originAttack = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://untrusted.example" },
    body: JSON.stringify({ username: "test-admin", password: "test-admin-password-123" }),
  });
  assert.equal(originAttack.status, 403);
  const allowedOriginLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(baseUrl).origin },
    body: JSON.stringify({ username: "test-admin", password: "test-admin-password-123" }),
  });
  assert.equal(allowedOriginLogin.status, 200);

  const created = await request("/api/staff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "shift-manager", displayName: "Shift Manager", password: "manager-password-123", role: "manager" }),
  });
  assert.equal(created.response.status, 201);
  const createdStaff = await request("/api/staff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "floor-staff", displayName: "Floor Staff", password: "staff-password-123", role: "staff" }),
  });
  assert.equal(createdStaff.response.status, 201);

  const managerLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "shift-manager", password: "manager-password-123" }),
  });
  assert.equal(managerLogin.status, 200);
  const managerCookie = managerLogin.headers.get("set-cookie")?.split(";")[0];
  assert.ok(managerCookie);
  assert.match(managerLogin.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Path=\//);
  const managerStaffList = await fetch(`${baseUrl}/api/staff`, { headers: { cookie: managerCookie } });
  assert.equal(managerStaffList.status, 200);
  const managerPrivilegeEscalation = await fetch(`${baseUrl}/api/staff`, {
    method: "POST",
    headers: { cookie: managerCookie, "content-type": "application/json" },
    body: JSON.stringify({ username: "other-manager", displayName: "Other Manager", password: "other-manager-password", role: "manager" }),
  });
  assert.equal(managerPrivilegeEscalation.status, 403);

  const staffLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "floor-staff", password: "staff-password-123" }),
  });
  assert.equal(staffLogin.status, 200);
  const staffCookie = staffLogin.headers.get("set-cookie")?.split(";")[0];
  assert.ok(staffCookie);

  const managerMenuWrite = await fetch(`${baseUrl}/api/menu`, {
    method: "POST",
    headers: { cookie: managerCookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Manager Special", category: "Test", price: "1.00", prepMinutes: "5" }),
  });
  assert.equal(managerMenuWrite.status, 201);
  const staffMenuWrite = await fetch(`${baseUrl}/api/menu`, {
    method: "POST",
    headers: { cookie: staffCookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Restricted", category: "Test", price: "1.00", prepMinutes: "5" }),
  });
  assert.equal(staffMenuWrite.status, 403);
  const managerOrders = await fetch(`${baseUrl}/api/orders`, { headers: { cookie: managerCookie } });
  assert.equal(managerOrders.status, 200);

  const deactivated = await request(`/api/staff/${created.body.id}/active`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ active: false }),
  });
  assert.equal(deactivated.response.status, 200);
  const revokedManagerSession = await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie: managerCookie } });
  assert.equal(revokedManagerSession.status, 401);
  const inactiveLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "shift-manager", password: "manager-password-123" }),
  });
  assert.equal(inactiveLogin.status, 401);
});

test("validates and persists menu items and orders, then progresses order status", async () => {
  const menus = await request("/api/menu");
  const menu = menus.body[0];
  const badOrder = await request("/api/orders", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ customerName: "No item", items: [] }),
  });
  assert.equal(badOrder.response.status, 400);

  const created = await request("/api/orders", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ customerName: "Test Guest", tableNumber: "08", items: [{ menuItemId: menu.id, quantity: 2 }] }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.total_cents, menu.price_cents * 2);
  assert.equal(created.body.status, "Received");
  const beforeReady = await request("/api/dashboard");
  const revenueBeforeReady = beforeReady.body.weeklySales.reduce((sum, day) => sum + day.revenueCents, 0);

  const preparing = await request(`/api/orders/${created.body.id}/status`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "Preparing" }),
  });
  assert.equal(preparing.response.status, 200);
  const ready = await request(`/api/orders/${created.body.id}/status`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "Ready" }),
  });
  assert.equal(ready.response.status, 200);
  const afterReady = await request("/api/dashboard");
  assert.equal(afterReady.body.weeklySales.reduce((sum, day) => sum + day.revenueCents, 0), revenueBeforeReady + created.body.total_cents);
  const invalidTransition = await request(`/api/orders/${created.body.id}/status`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "Preparing" }),
  });
  assert.equal(invalidTransition.response.status, 400);
});

test("supports menu creation, inventory restocking, and method errors", async () => {
  const invalidPrice = await request("/api/menu", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Bad price", category: "Test", price: "4.256", prepMinutes: "5" }),
  });
  assert.equal(invalidPrice.response.status, 400);

  const createdMenu = await request("/api/menu", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Test Special", category: "Test", price: "4.25", prepMinutes: "5", description: "Seasonal" }),
  });
  assert.equal(createdMenu.response.status, 201);
  assert.equal(createdMenu.body.price_cents, 425);

  const editedMenu = await request(`/api/menu/${createdMenu.body.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Test Special Updated", category: "Test", price: "4.50", prepMinutes: "6", description: "Updated" }),
  });
  assert.equal(editedMenu.response.status, 200);
  assert.equal(editedMenu.body.price_cents, 450);
  const unavailableMenu = await request(`/api/menu/${createdMenu.body.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ available: false }),
  });
  assert.equal(unavailableMenu.body.available, 0);

  const inventory = await request("/api/inventory");
  const item = inventory.body[0];
  const restocked = await request(`/api/inventory/${item.id}/restock`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quantity: 3, reorderLevel: 7 }),
  });
  assert.equal(restocked.response.status, 200);
  assert.equal(restocked.body.quantity, item.quantity + 3);
  assert.equal(restocked.body.reorder_level, 7);
  const thresholdOnly = await request(`/api/inventory/${item.id}/restock`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quantity: 0, reorderLevel: 9 }),
  });
  assert.equal(thresholdOnly.response.status, 200);
  assert.equal(thresholdOnly.body.quantity, item.quantity + 3);
  assert.equal(thresholdOnly.body.reorder_level, 9);
  const emptyUpdate = await request(`/api/inventory/${item.id}/restock`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quantity: 0 }),
  });
  assert.equal(emptyUpdate.response.status, 400);

  const wrongMethod = await request("/api/dashboard", { method: "POST" });
  assert.equal(wrongMethod.response.status, 405);
});

test("dashboard revenue and popular items include only ready or completed orders in the last week", async () => {
  const dashboard = await request("/api/dashboard");
  assert.equal(dashboard.body.weeklySales.length, 7);
  assert.ok(dashboard.body.weeklySales.every((day) => Number.isInteger(day.revenueCents)));
  assert.ok(dashboard.body.popular.every((item) => Number.isInteger(item.sold)));
});

test("orders endpoint returns bounded, searchable pagination metadata", async () => {
  const legacy = await request("/api/orders");
  assert.ok(Array.isArray(legacy.body));
  const firstPage = await request("/api/orders?page=1&pageSize=2");
  assert.equal(firstPage.response.status, 200);
  assert.equal(firstPage.body.page, 1);
  assert.equal(firstPage.body.pageSize, 2);
  assert.ok(firstPage.body.total >= firstPage.body.items.length);
  assert.ok(firstPage.body.items.length <= 2);
  const invalidPageSize = await request("/api/orders?pageSize=101");
  assert.equal(invalidPageSize.response.status, 400);
});

test("password changes rotate sessions and require the current password", async () => {
  const previousCookie = sessionCookie;
  const invalidCurrent = await request("/api/auth/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentPassword: "incorrect-password", newPassword: "new-admin-password-456" }),
  });
  assert.equal(invalidCurrent.response.status, 400);

  const changed = await request("/api/auth/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentPassword: "test-admin-password-123", newPassword: "new-admin-password-456" }),
  });
  assert.equal(changed.response.status, 200);
  sessionCookie = changed.response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(sessionCookie);
  const previousSession = await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie: previousCookie } });
  assert.equal(previousSession.status, 401);
  const oldPassword = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "test-admin", password: "test-admin-password-123" }),
  });
  assert.equal(oldPassword.status, 401);
});

test("sign-out revokes the existing session", async () => {
  const logout = await request("/api/auth/logout", { method: "POST" });
  assert.equal(logout.response.status, 200);
  const denied = await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie: sessionCookie } });
  assert.equal(denied.status, 401);
});
