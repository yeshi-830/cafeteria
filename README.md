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

The server binds to loopback by default and has no authentication. Keep it on the local machine. Remote or multi-user use requires authentication, authorization, and HTTPS before binding to a network interface.

## Included workflows

- Dashboard metrics, seven-day sales, latest orders, popular items, and activity history
- Searchable and filterable paginated order queue with status progression
- Validated order creation with persisted order lines and server-calculated pricing
- Menu item creation, editing, and availability controls
- Inventory restocking and reorder point management

Run `npm test` for TypeScript checks and API workflow tests. Run `npm run build` to type-check both applications and create the production frontend and backend outputs.
