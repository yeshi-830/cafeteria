# Harbor Cafe

A lightweight cafeteria management dashboard built with Node.js, a local SQLite
database, and a responsive browser-based interface. It has no third-party
package dependencies.

## Requirements

- Node.js 22.13 or newer (the built-in `node:sqlite` module is used)

## Run locally

```powershell
node server.js
```

Open [http://localhost:3000](http://localhost:3000). The database is created as
`cafeteria.db` in the project directory on first run and seeded with sample
menu, inventory, and order data. Set `PORT` or `CAFETERIA_DB_PATH` to override
the default server port or database location.

## Included workflows

- Live dashboard metrics, seven-day sales, and latest orders
- Searchable and filterable order queue with status progression
- New order creation with server-side validation and persisted order items
- Menu listing and menu item creation
- Inventory monitoring and stock restocking
- Activity history for order and inventory changes

This is a local, single-operator starter and does not include user
authentication. Add authentication and HTTPS before exposing it beyond a
trusted local network.
