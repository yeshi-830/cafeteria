# mhru cafe

A cafe operations dashboard built with a TypeScript frontend, Tailwind CSS, a TypeScript Node API, and SQLite. The project is split into independently maintained frontend, backend, and database source areas while retaining the existing dashboard and its workflows.

## Project layout

```text
frontend/      Vite UI, TypeScript browser logic, Tailwind and dashboard styles
backend/       Node HTTP server and API routes
database/      SQLite connection, schema, indexes, and initial seed data
tests/         API workflow tests using an isolated temporary SQLite database
```

## Requirements

- Node.js 22.13 or newer (SQLite uses the built-in `node:sqlite` module)

## Install and run

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. The development command starts Vite and the API together; Vite proxies `/api` calls to port 3000. To run each process in its own terminal, use `npm run dev:frontend` and `npm run dev:backend`.

For a production build and run:

```sh
npm run build
npm start
```

The production app is served from <http://127.0.0.1:3000>.

## Database and configuration

SQLite uses `cafeteria.db` in the project root by default. Existing data is preserved. Sample menu, inventory, and order rows are only seeded when their respective tables are empty. Set `CAFETERIA_DB_PATH` to use another SQLite file, `PORT` to change the API port, or `HOST` to change the bind address.

The server binds to loopback by default. On the first run, configure the initial administrator account in the same shell before starting the server:

```powershell
$env:CAFETERIA_ADMIN_USERNAME = "cafe-admin"
$env:CAFETERIA_ADMIN_PASSWORD = "use-a-unique-password-of-at-least-12-characters"
npm run dev
```

The initial credentials are required only when the database has no users. Passwords are stored as salted scrypt hashes. Sign-in issues an eight-hour, database-backed session in an HTTP-only, SameSite=Strict cookie. Failed sign-ins are rate limited. Admins can create accounts and assign roles; managers can create staff accounts. Staff can process orders, while menu and inventory changes require a manager or admin.

The first authenticated startup applies an additive, transactional schema migration for users and sessions. Existing menu, inventory, order, and activity records are not altered. Back up `cafeteria.db` before deployments as a general operational precaution.

If sign-in reports that the API route was not found or the backend is out of date, the browser may be connected to an older server already using port 3000. Stop only the old cafeteria server process, then restart `npm run dev` from the project root. The Vite development server now fails clearly if port 5173 is occupied instead of silently switching to a different port, and its API proxy follows `PORT` or `CAFETERIA_API_URL`.

Keep the server on loopback unless remote access is intentionally configured. Network binding requires `COOKIE_SECURE=true` and an explicit comma-separated `TRUSTED_ORIGINS` allowlist, for example `https://cafe.example.com`. Terminate HTTPS at a trusted reverse proxy; the built-in server does not provide TLS. Do not expose the app publicly until the reverse proxy, firewall, backups, and credential handling are configured.

## Included workflows

- Dashboard metrics, seven-day sales, latest orders, popular items, and activity history
- Searchable and filterable paginated order queue with status progression
- Validated order creation with persisted order lines and server-calculated pricing
- Menu item creation, editing, and availability controls
- Inventory restocking and reorder point management
- Authenticated staff accounts with admin, manager, and staff roles
- Session sign-in/sign-out and server-enforced permissions

Run `npm test` for TypeScript checks and API workflow tests. Run `npm run build` to type-check both applications and create the production frontend and backend outputs.
