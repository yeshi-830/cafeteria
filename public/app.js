const state = {
  menu: [],
  inventory: [],
  currentView: "dashboard",
  searchTimer: null,
  ordersPage: 1,
  ordersRequest: 0,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The server returned an unexpected response");
  }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = `toast${error ? " error" : ""}`;
  node.textContent = message;
  $("#toast-region").append(node);
  window.setTimeout(() => node.remove(), 3500);
}

function friendlyDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(date);
}

function compactTime(value) {
  if (!value) return "—";
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}

function statusClass(status) {
  return `status-${String(status).toLowerCase()}`;
}

function statusBadge(status) {
  return `<span class="status-pill ${statusClass(status)}">${escapeHtml(status)}</span>`;
}

function nextAction(status) {
  return {
    Received: { next: "Preparing", label: "Start" },
    Preparing: { next: "Ready", label: "Mark ready" },
    Ready: { next: "Completed", label: "Complete" },
  }[status] || null;
}

function orderRow(order, withAction = false) {
  const action = nextAction(order.status);
  const controls = withAction && action
    ? `<div class="order-actions"><button class="row-action" data-order-id="${order.id}" data-next-status="${action.next}">${action.label}</button><button class="row-action cancel-order" data-order-id="${order.id}" data-next-status="Cancelled" aria-label="Cancel ${escapeHtml(order.order_number)}">Cancel</button></div>`
    : "";
  return `<tr>
    <td><span class="order-number">${escapeHtml(order.order_number)}</span></td>
    <td class="customer-cell">${escapeHtml(order.customer_name)}${order.table_number ? `<span class="table-number"> · Table ${escapeHtml(order.table_number)}</span>` : ""}</td>
    <td class="items-cell" title="${escapeHtml(order.items || "")}">${escapeHtml(order.items || "No items")}</td>
    <td>${escapeHtml(compactTime(order.created_at))}</td>
    <td>${statusBadge(order.status)}</td>
    <td class="total-cell">${money(order.total_cents)}</td>
    ${withAction ? `<td>${controls || '<span class="finished-note">—</span>'}</td>` : ""}
  </tr>`;
}

function renderChart(sales) {
  const width = 600;
  const height = 155;
  const left = 44;
  const right = 588;
  const top = 12;
  const bottom = 117;
  const values = sales.map((item) => item.revenueCents);
  const maximum = Math.max(100, ...values);
  const chartMaximum = Math.ceil(maximum / 50000) * 50000 || 50000;
  const points = sales.map((item, index) => {
    const x = left + (sales.length <= 1 ? 0 : (right - left) * index / (sales.length - 1));
    const y = bottom - (item.revenueCents / chartMaximum) * (bottom - top);
    return { x, y, item };
  });
  const line = points.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const area = `${line} L ${right} ${bottom} L ${left} ${bottom} Z`;
  const grid = [0, 0.5, 1].map((fraction) => {
    const y = bottom - fraction * (bottom - top);
    const label = money(chartMaximum * fraction).replace(".00", "");
    return `<line class="chart-gridline" x1="${left}" y1="${y}" x2="${right}" y2="${y}"/><text class="chart-label" x="0" y="${y + 3}">${label}</text>`;
  }).join("");
  const dots = points.map((point) => `<circle class="chart-point" cx="${point.x}" cy="${point.y}" r="3.3"><title>${escapeHtml(point.item.date)}: ${money(point.item.revenueCents)}</title></circle>`).join("");
  const labels = points.map((point) => {
    const date = new Date(`${point.item.date}T12:00:00`);
    const day = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
    return `<text class="chart-label" x="${point.x}" y="143" text-anchor="middle">${day}</text>`;
  }).join("");
  $("#sales-chart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Sales over the last seven days">${grid}<defs><linearGradient id="sales-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#6eac88" stop-opacity=".2"/><stop offset="100%" stop-color="#6eac88" stop-opacity="0"/></linearGradient></defs><path class="chart-fill" d="${area}"/><path class="chart-line" d="${line}"/>${dots}${labels}</svg>`;
}

function foodEmoji(item) {
  const value = `${item.name} ${item.category}`.toLowerCase();
  if (value.includes("coffee") || value.includes("matcha") || value.includes("drink")) return "☕";
  if (value.includes("toast") || value.includes("breakfast")) return "🥑";
  if (value.includes("bowl")) return "🥗";
  if (value.includes("soup")) return "🍲";
  if (value.includes("muffin") || value.includes("bakery")) return "🫐";
  if (value.includes("chicken") || value.includes("wrap")) return "🌯";
  if (value.includes("panini") || value.includes("sandwich")) return "🥪";
  return "🍽️";
}

function renderPopular(items) {
  $("#popular-list").innerHTML = items.length
    ? items.map((item) => `<div class="popular-item"><span class="food-emoji">${foodEmoji(item)}</span><div class="popular-copy"><strong>${escapeHtml(item.name)}</strong><span>${Number(item.sold)} ordered · ${escapeHtml(item.category)}</span></div><span class="popular-price">${money(item.price_cents)}</span></div>`).join("")
    : '<div class="table-empty">Your customer favorites will show up here.</div>';
}

function renderActivities(items) {
  const marks = { order: "↗", inventory: "▤", service: "✦" };
  $("#activity-list").innerHTML = items.length
    ? items.map((item) => `<div class="activity-item"><span class="activity-mark ${escapeHtml(item.kind)}">${marks[item.kind] || "•"}</span><span class="activity-message">${escapeHtml(item.message)}</span><time>${escapeHtml(compactTime(item.created_at))}</time></div>`).join("")
    : '<div class="table-empty">Your team updates will show up here.</div>';
}

async function loadDashboard() {
  try {
    const data = await api("/api/dashboard");
    $("#stat-revenue").textContent = money(data.stats.revenueCents);
    $("#stat-active").textContent = data.stats.activeOrders;
    $("#stat-orders").textContent = data.stats.orderCount;
    $("#stat-average").textContent = `Average ticket ${money(data.stats.averageCents)}`;
    $("#stat-stock").textContent = data.stats.lowStockCount;
    $("#stock-dot").className = `stat-dot${data.stats.lowStockCount ? " red" : " green"}`;
    $("#stock-note").textContent = data.stats.lowStockCount
      ? `${data.stats.lowStockCount} ${data.stats.lowStockCount === 1 ? "item needs" : "items need"} a top-up`
      : "Everything is looking well stocked";
    $("#nav-order-count").textContent = data.stats.activeOrders;
    $("#nav-stock-dot").hidden = data.stats.lowStockCount === 0;
    $("#sales-total").textContent = money(data.weeklySales.reduce((sum, day) => sum + day.revenueCents, 0));
    renderChart(data.weeklySales);
    renderPopular(data.popular);
    renderActivities(data.activities);
    $("#recent-orders").innerHTML = data.orders.length
      ? data.orders.map((order) => orderRow(order)).join("")
      : '<tr><td class="table-empty" colspan="6">No orders just yet. Your next great service starts here.</td></tr>';
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadOrders() {
  const requestId = ++state.ordersRequest;
  try {
    const params = new URLSearchParams();
    const search = $("#order-search").value.trim();
    const status = $("#order-filter").value;
    if (search) params.set("q", search);
    if (status !== "All") params.set("status", status);
    params.set("page", state.ordersPage);
    params.set("pageSize", "25");
    const result = await api(`/api/orders?${params}`);
    if (requestId !== state.ordersRequest) return;
    $("#orders-table").innerHTML = result.items.map((order) => orderRow(order, true)).join("");
    $("#orders-empty").hidden = result.total > 0;
    const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
    $("#orders-pagination").innerHTML = `<span>Showing ${result.total ? (result.page - 1) * result.pageSize + 1 : 0}–${Math.min(result.page * result.pageSize, result.total)} of ${result.total}</span><span><button type="button" data-orders-page="${result.page - 1}" ${result.page <= 1 ? "disabled" : ""}>Previous</button> <button type="button" data-orders-page="${result.page + 1}" ${result.page >= pages ? "disabled" : ""}>Next</button></span>`;
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadMenu() {
  try {
    state.menu = await api("/api/menu");
    const categories = [...new Set(state.menu.map((item) => item.category))];
    $("#menu-summary").textContent = `${state.menu.length} ${state.menu.length === 1 ? "thoughtful dish" : "thoughtful dishes"} across ${categories.length} ${categories.length === 1 ? "category" : "categories"}.`;
    $("#menu-grid").innerHTML = state.menu.map((item) => `<article class="menu-card">
      <div class="menu-card-top"><span class="menu-category">${escapeHtml(item.category)}</span><span class="availability${item.available ? "" : " unavailable"}">${item.available ? "Available" : "Unavailable"}</span></div>
      <h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.description || "A little something delicious from our kitchen.")}</p>
      <div class="menu-card-footer"><strong>${money(item.price_cents)}</strong><span><svg class="mini-clock"><use href="#icon-clock"/></svg> ${Number(item.prep_minutes)} min prep</span></div>
      <div class="menu-card-actions"><button class="row-action" type="button" data-menu-edit="${item.id}">Edit</button><button class="row-action" type="button" data-menu-toggle="${item.id}" data-available="${item.available ? "true" : "false"}">${item.available ? "Mark unavailable" : "Mark available"}</button></div>
    </article>`).join("");
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadInventory() {
  try {
    state.inventory = await api("/api/inventory");
    const lowItems = state.inventory.filter((item) => item.quantity <= item.reorder_level);
    const totalUnits = state.inventory.reduce((sum, item) => sum + item.quantity, 0);
    $("#inventory-summary").innerHTML = `<div class="summary-chip"><span class="summary-chip-icon">▤</span><span class="summary-chip-copy"><strong>${state.inventory.length}</strong><span>Tracked ingredients</span></span></div><div class="summary-chip"><span class="summary-chip-icon">↗</span><span class="summary-chip-copy"><strong>${totalUnits}</strong><span>Total units on hand</span></span></div><div class="summary-chip"><span class="summary-chip-icon${lowItems.length ? " warn" : ""}">!</span><span class="summary-chip-copy"><strong>${lowItems.length}</strong><span>Items below reorder point</span></span></div>`;
    $("#inventory-count").textContent = `${state.inventory.length} items`;
    $("#inventory-table").innerHTML = state.inventory.map((item) => {
      const low = item.quantity <= item.reorder_level;
      return `<tr><td class="customer-cell">${escapeHtml(item.name)}</td><td>${escapeHtml(item.category)}</td><td><strong class="quantity-cell">${Number(item.quantity)} ${escapeHtml(item.unit)}</strong></td><td>${Number(item.reorder_level)} ${escapeHtml(item.unit)}</td><td><span class="inventory-status${low ? " low" : ""}">${low ? "● Low stock" : "● In stock"}</span></td><td class="align-right"><button class="row-action" data-restock-id="${item.id}">Restock</button></td></tr>`;
    }).join("");
    $("#nav-stock-dot").hidden = lowItems.length === 0;
  } catch (error) {
    toast(error.message, true);
  }
}

async function showView(name) {
  state.currentView = name;
  $$(".view-panel").forEach((panel) => {
    const visible = panel.id === `view-${name}`;
    panel.hidden = !visible;
    panel.classList.toggle("is-visible", visible);
  });
  $$(".nav-link").forEach((button) => button.classList.toggle("is-active", button.dataset.view === name));
  const label = { dashboard: "Overview", orders: "Orders", menu: "Menu", inventory: "Inventory" }[name];
  $("#breadcrumb-current").textContent = label;
  $("#sidebar").classList.remove("is-open");
  if (name === "dashboard") await loadDashboard();
  if (name === "orders") await loadOrders();
  if (name === "menu") await loadMenu();
  if (name === "inventory") await loadInventory();
}

function orderLine() {
  if (!state.menu.length) return '<div class="table-empty">Add an available menu item before starting an order.</div>';
  const options = state.menu.filter((item) => item.available).map((item) => `<option value="${item.id}" data-price="${item.price_cents}">${escapeHtml(item.name)} · ${money(item.price_cents)}</option>`).join("");
  return `<div class="order-line"><select aria-label="Menu item" required>${options || '<option value="">No available menu items</option>'}</select><input type="number" aria-label="Quantity" min="1" max="50" value="1" required><button class="remove-line" type="button" aria-label="Remove item">×</button></div>`;
}

function updateOrderTotal() {
  const total = $$(".order-line", $("#order-lines")).reduce((sum, line) => {
    const select = $("select", line);
    const option = select.selectedOptions[0];
    const price = Number(option?.dataset.price || 0);
    const quantity = Number($("input", line).value || 0);
    return sum + price * quantity;
  }, 0);
  $("#order-total").textContent = money(total);
}

async function openOrderDialog() {
  try {
    if (!state.menu.length) state.menu = await api("/api/menu");
    $("#order-form").reset();
    $("#order-error").textContent = "";
    $("#order-lines").innerHTML = orderLine();
    updateOrderTotal();
    $("#order-dialog").showModal();
  } catch (error) {
    toast(error.message, true);
  }
}

function openRestockDialog(itemId = "") {
  if (!state.inventory.length) {
    toast("Inventory is still loading. Please try again.", true);
    return;
  }
  $("#restock-form").reset();
  $("#restock-error").textContent = "";
  $("#restock-item").innerHTML = state.inventory.map((item) => `<option value="${item.id}">${escapeHtml(item.name)} · ${Number(item.quantity)} ${escapeHtml(item.unit)} on hand</option>`).join("");
  if (itemId) $("#restock-item").value = itemId;
  const selectedItem = state.inventory.find((item) => item.id === Number($("#restock-item").value));
  $("#restock-reorder-level").value = selectedItem?.reorder_level ?? "";
  $("#restock-dialog").showModal();
}

function showError(element, error) {
  element.textContent = error.message;
}

document.addEventListener("click", async (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    await showView(viewButton.dataset.view);
    return;
  }
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    if (actionButton.dataset.action === "new-order") await openOrderDialog();
    if (actionButton.dataset.action === "new-menu-item") {
      $("#menu-form").reset();
      delete $("#menu-form").dataset.editingId;
      $("#menu-error").textContent = "";
      $("#menu-dialog h2").textContent = "Add a menu item";
      $("#menu-dialog .dialog-heading p:not(.eyebrow)").textContent = "Make something delicious part of the lineup.";
      $('button[type="submit"]', $("#menu-form")).textContent = "Add to menu";
      $("#menu-dialog").showModal();
    }
    if (actionButton.dataset.action === "restock") openRestockDialog();
    return;
  }
  const pageButton = event.target.closest("[data-orders-page]");
  if (pageButton && !pageButton.disabled) {
    state.ordersPage = Number(pageButton.dataset.ordersPage);
    await loadOrders();
    return;
  }
  const editMenuButton = event.target.closest("[data-menu-edit]");
  if (editMenuButton) {
    const item = state.menu.find((entry) => entry.id === Number(editMenuButton.dataset.menuEdit));
    if (!item) return;
    const form = $("#menu-form");
    form.dataset.editingId = item.id;
    form.elements.name.value = item.name;
    form.elements.category.value = item.category;
    form.elements.price.value = (item.price_cents / 100).toFixed(2);
    form.elements.prepMinutes.value = item.prep_minutes;
    form.elements.description.value = item.description;
    $("#menu-error").textContent = "";
    $("#menu-dialog h2").textContent = "Edit menu item";
    $("#menu-dialog .dialog-heading p:not(.eyebrow)").textContent = "Update the details your team uses to serve it.";
    $('button[type="submit"]', form).textContent = "Save changes";
    $("#menu-dialog").showModal();
    return;
  }
  const toggleMenuButton = event.target.closest("[data-menu-toggle]");
  if (toggleMenuButton) {
    toggleMenuButton.disabled = true;
    try {
      await api(`/api/menu/${toggleMenuButton.dataset.menuToggle}`, {
        method: "PATCH", body: JSON.stringify({ available: toggleMenuButton.dataset.available !== "true" }),
      });
      await Promise.all([loadMenu(), loadDashboard()]);
      toast("Menu availability updated.");
    } catch (error) {
      toggleMenuButton.disabled = false;
      toast(error.message, true);
    }
    return;
  }
  const closeButton = event.target.closest("[data-close-dialog]");
  if (closeButton) {
    document.getElementById(closeButton.dataset.closeDialog).close();
    return;
  }
  const restockButton = event.target.closest("[data-restock-id]");
  if (restockButton) {
    openRestockDialog(restockButton.dataset.restockId);
    return;
  }
  const statusButton = event.target.closest("[data-next-status]");
  if (statusButton) {
    statusButton.disabled = true;
    try {
      await api(`/api/orders/${statusButton.dataset.orderId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: statusButton.dataset.nextStatus }),
      });
      toast(`Order updated to ${statusButton.dataset.nextStatus.toLowerCase()}.`);
      await Promise.all([loadOrders(), loadDashboard()]);
    } catch (error) {
      statusButton.disabled = false;
      toast(error.message, true);
    }
    return;
  }
  const removeButton = event.target.closest(".remove-line");
  if (removeButton) {
    const lines = $$(".order-line", $("#order-lines"));
    if (lines.length > 1) removeButton.closest(".order-line").remove();
    else removeButton.closest(".order-line").querySelector("input").value = 1;
    updateOrderTotal();
    return;
  }
  if (event.target === $("#mobile-menu") || event.target.closest("#mobile-menu")) {
    $("#sidebar").classList.toggle("is-open");
  } else if (!event.target.closest("#sidebar")) {
    $("#sidebar").classList.remove("is-open");
  }
});

document.addEventListener("change", (event) => {
  if (event.target.matches("#order-filter")) { state.ordersPage = 1; loadOrders(); }
  if (event.target.matches("#restock-item")) {
    const item = state.inventory.find((entry) => entry.id === Number(event.target.value));
    $("#restock-reorder-level").value = item?.reorder_level ?? "";
  }
  if (event.target.matches(".order-line select, .order-line input")) updateOrderTotal();
});

document.addEventListener("input", (event) => {
  if (event.target.matches("#order-search")) {
    state.ordersPage = 1;
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(loadOrders, 180);
  }
  if (event.target.matches(".order-line input")) updateOrderTotal();
});

$("#order-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const items = $$(".order-line", $("#order-lines")).map((line) => ({
    menuItemId: Number($("select", line).value),
    quantity: Number($("input", line).value),
  }));
  const submit = $('button[type="submit"]', event.currentTarget);
  submit.disabled = true;
  try {
    await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        customerName: form.get("customerName"),
        tableNumber: form.get("tableNumber"),
        items,
      }),
    });
    $("#order-dialog").close();
    toast("Your new order is in the queue.");
    await Promise.all([loadDashboard(), state.currentView === "orders" ? loadOrders() : Promise.resolve()]);
  } catch (error) {
    showError($("#order-error"), error);
  } finally {
    submit.disabled = false;
  }
});

$("#add-order-line").addEventListener("click", () => {
  if ($$(".order-line", $("#order-lines")).length >= 30) {
    $("#order-error").textContent = "An order can include up to 30 line items.";
    return;
  }
  $("#order-lines").insertAdjacentHTML("beforeend", orderLine());
  $("#order-error").textContent = "";
});

$("#menu-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const submit = $('button[type="submit"]', event.currentTarget);
  submit.disabled = true;
  try {
    const editingId = event.currentTarget.dataset.editingId;
    await api(editingId ? `/api/menu/${editingId}` : "/api/menu", { method: editingId ? "PATCH" : "POST", body: JSON.stringify(data) });
    $("#menu-dialog").close();
    delete event.currentTarget.dataset.editingId;
    toast(editingId ? "Menu item updated." : "Your new menu item is ready to go.");
    await Promise.all([loadMenu(), loadDashboard()]);
  } catch (error) {
    showError($("#menu-error"), error);
  } finally {
    submit.disabled = false;
  }
});

$("#restock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const quantity = Number(form.get("quantity"));
  const submit = $('button[type="submit"]', event.currentTarget);
  submit.disabled = true;
  try {
    await api(`/api/inventory/${form.get("inventoryId")}/restock`, {
      method: "POST",
      body: JSON.stringify({
        quantity,
        reorderLevel: form.get("reorderLevel") === "" ? null : Number(form.get("reorderLevel")),
      }),
    });
    $("#restock-dialog").close();
    toast(quantity ? "Inventory updated. Nice and stocked." : "Reorder point updated.");
    await Promise.all([loadInventory(), loadDashboard()]);
  } catch (error) {
    showError($("#restock-error"), error);
  } finally {
    submit.disabled = false;
  }
});

function init() {
  const now = new Date();
  const hour = now.getHours();
  $("#greeting").textContent = `GOOD ${hour < 12 ? "MORNING" : hour < 17 ? "AFTERNOON" : "EVENING"}, JORDAN`;
  $("#topbar-date").textContent = friendlyDate(now);
  $("#year").textContent = now.getFullYear();
  $$(".footer-year").forEach((element) => { element.textContent = now.getFullYear(); });
  loadDashboard();
  loadInventory();
}

init();
