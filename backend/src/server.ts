import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { db, databasePath } from "../../database/src/index.js";
import { handleApi, sendJson, serveStatic } from "./api.js";
import { authenticateRequest, handleAuthRoute, initializeAuth, isTrustedOrigin } from "./auth.js";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
initializeAuth(host);
const server = http.createServer(async (request: IncomingMessage, response: ServerResponse) => {
  let url: URL;
  try {
    url = new URL(request.url || "/", "http://localhost");
  } catch {
    sendJson(response, 400, { error: "Invalid request URL" });
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    const authRoute = url.pathname.startsWith("/api/auth/") || url.pathname === "/api/staff" || /^\/api\/staff\/\d+\/active$/.test(url.pathname);
    const supportedMethod = url.pathname === "/api/auth/login" || url.pathname === "/api/auth/logout"
      || url.pathname === "/api/auth/password" || url.pathname === "/api/staff"
      ? url.pathname === "/api/staff" ? ["GET", "POST"] : ["POST"]
      : url.pathname === "/api/auth/me" ? ["GET"]
        : /^\/api\/staff\/\d+\/active$/.test(url.pathname) ? ["PATCH"]
          : (url.pathname === "/api/dashboard" || url.pathname === "/api/orders" || url.pathname === "/api/menu" || url.pathname === "/api/inventory")
            ? ["GET", ...(url.pathname === "/api/orders" || url.pathname === "/api/menu" ? ["POST"] : [])]
            : /^\/api\/orders\/\d+\/status$/.test(url.pathname) ? ["PATCH"]
              : /^\/api\/menu\/\d+$/.test(url.pathname) ? ["PATCH"]
                : /^\/api\/inventory\/\d+\/restock$/.test(url.pathname) ? ["POST"] : null;
    if (supportedMethod && !supportedMethod.includes(request.method || "")) {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method || "") && !isTrustedOrigin(request)) {
      sendJson(response, 403, { error: "Request origin is not allowed." });
      return;
    }
    try {
      if (authRoute) {
        const isPublicRoute = url.pathname === "/api/auth/login" || url.pathname === "/api/auth/me";
        const principal = isPublicRoute ? null : authenticateRequest(request, response);
        if (!isPublicRoute && !principal) return;
        if (!isPublicRoute && url.pathname === "/api/staff" && request.method === "GET" && !["admin", "manager"].includes(principal!.role)) {
          sendJson(response, 403, { error: "Only managers and admins can view staff accounts." });
          return;
        }
        await handleAuthRoute(request, response, url, principal);
      } else if (supportedMethod) {
        const principal = authenticateRequest(request, response);
        if (!principal) return;
        if ((url.pathname === "/api/menu" && request.method === "POST")
          || (/^\/api\/menu\/\d+$/.test(url.pathname) && request.method === "PATCH")
          || (/^\/api\/inventory\/\d+\/restock$/.test(url.pathname) && request.method === "POST")) {
          if (!["admin", "manager"].includes(principal.role)) {
            sendJson(response, 403, { error: "Manager or admin access is required for this operation." });
            return;
          }
        }
        await handleApi(request, response, url);
      } else {
        await handleApi(request, response, url);
      }
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
