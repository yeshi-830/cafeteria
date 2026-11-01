# mhru cafe

A lightweight cafeteria management dashboard built with Node.js, a local SQLite
database, and a responsive browser-based interface. It has no third-party
package dependencies.

## Requirements

- Node.js 22.13 or newer (the built-in `node:sqlite` module is used)

## Run locally

```powershell
node server.js
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The app binds to loopback
by default and is intended for one trusted operator on the same machine. It has
no authentication. Do not expose it to a network; remote or multi-user use
requires authentication, authorization, and HTTPS. Set `HOST` only when you
have configured those protections. The database is created as
`cafeteria.db` in the project directory on first run and seeded with sample
menu, inventory, and order data. Set `PORT` or `CAFETERIA_DB_PATH` to override
the default server port or database location. `HOST` can override the default
`127.0.0.1` bind address.

## Included workflows

- Live dashboard metrics, seven-day sales, and latest orders
- Searchable and filterable, paginated order queue with status progression
- New order creation with server-side validation and persisted order items
- Menu listing, creation, editing, and availability controls
- Inventory monitoring, stock restocking, and reorder point updates
- Activity history for order and inventory changes

## Tests

Run the API workflow tests with `npm test`. They use a temporary SQLite
database and do not modify the project's local database.

This is a local, single-operator starter and does not include user
authentication. Keep it loopback-only unless you add authentication,
authorization, and HTTPS.
