import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { db, databasePath } from "../../database/src/index.js";
import { handleApi, sendJson, serveStatic } from "./api.js";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const server = http.createServer(async (request: IncomingMessage, response: ServerResponse) => {
  let url: URL;
  try {
    url = new URL(request.url || "/", "http://localhost");
  } catch {
    sendJson(response, 400, { error: "Invalid request URL" });
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    const supportedMethod = (url.pathname === "/api/dashboard" || url.pathname === "/api/orders" || url.pathname === "/api/menu" || url.pathname === "/api/inventory")
      ? ["GET", ...(url.pathname === "/api/orders" || url.pathname === "/api/menu" ? ["POST"] : [])]
      : /^\/api\/orders\/\d+\/status$/.test(url.pathname) ? ["PATCH"]
        : /^\/api\/menu\/\d+$/.test(url.pathname) ? ["PATCH"]
        : /^\/api\/inventory\/\d+\/restock$/.test(url.pathname) ? ["POST"] : null;
    if (supportedMethod && !supportedMethod.includes(request.method || "")) {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
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

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`mhru cafe is running at http://${host}:${actualPort}`);
  console.log(`SQLite database: ${databasePath}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => {
    db.close();
    process.exit(0);
  }));
}
