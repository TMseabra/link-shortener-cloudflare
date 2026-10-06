# link-shortener-cloudflare

A URL shortener with click analytics, running on Cloudflare Workers with a D1 (SQLite) database. You create a short link, share it, and the dashboard shows who clicked: when, from which country, on what device and where they came from.

<!-- TODO: add a screenshot of the dashboard and the live link after the first deploy -->

## What it does

- Creates short links with a random or a custom slug
- Redirects with a 302 at the edge
- Records every click: country, city, device, browser and referrer domain
- Stats per link by day, country, device and source
- Admin dashboard in plain HTML/JS: list of links with click counts, a form to create, a delete button and a bar chart of the last 30 days
- The API is protected with a bearer token

## Stack

- Cloudflare Workers (TypeScript)
- Cloudflare D1 (SQL)
- Plain HTML/JS dashboard, served as static assets
- Wrangler

## How it works

```
                 ┌───────────────────────────┐
  user  ───────▶ │   Cloudflare Worker (TS)  │ ───────▶  D1
                 │                           │           ├─ links
                 │   GET  /:slug  → 302      │           └─ clicks
                 │   *    /api/*  → JSON     │
                 │   GET  /admin  → dashboard│
                 └───────────────────────────┘
```

A few decisions I made:

- **302, not 301.** A 301 is cached by the browser, so later clicks would never reach the Worker and I'd stop counting them.
- **Clicks are saved with `ctx.waitUntil()`**, so writing to the database doesn't slow down the redirect.
- **Country and city** come for free from `request.cf`. The device and browser are taken from the `User-Agent` header, and from `Referer` I only keep the domain.
- **The admin token is a secret** (`wrangler secret put`), never written in the code.
- **Reserved slugs** (`api`, `admin`) and URLs pointing to my own domain are blocked, to avoid conflicts and redirect loops.

## Project structure

```
link-shortener-cloudflare/
├── src/index.ts        # the Worker (routes, redirect, click tracking)
├── public/admin.html   # dashboard (static file)
├── schema.sql          # database tables
├── wrangler.jsonc      # Cloudflare config
├── package.json
├── .gitignore          # node_modules, .wrangler, .dev.vars
└── README.md
```

## Database

Two tables:

- `links`: `slug` (primary key), `url`, `created_at`
- `clicks`: `id`, `slug`, `ts`, `country`, `city`, `device`, `browser`, `referrer`

## Running locally

```bash
npm install
npx wrangler login
npx wrangler d1 create encurtador-db      # paste the database_id into wrangler.jsonc
npm run db:local                          # creates the tables locally
echo "ADMIN_TOKEN=dev-token" > .dev.vars  # local secret, not committed
npx wrangler dev
```

The dashboard is then at `http://localhost:8787/admin`.

## Deploying

```bash
npm run db:remote                  # creates the tables in production
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

You get a `*.workers.dev` URL. To use your own domain, go to Workers → Settings → Domains.

## API

All `/api/*` routes need the header `Authorization: Bearer <ADMIN_TOKEN>`.

| Method | Route | What it does |
|--------|-------|--------------|
| `POST` | `/api/links` | Creates a link (`{ "url": "...", "slug": "optional" }`) |
| `GET` | `/api/links` | Lists links with their click counts |
| `DELETE` | `/api/links/:slug` | Deletes a link and its clicks |
| `GET` | `/api/links/:slug/stats` | Clicks by day, country, device and source |
| `GET` | `/:slug` | Redirects to the original URL (public) |

Create a link:

```bash
curl -X POST https://encurtador.<your-subdomain>.workers.dev/api/links \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/some/very/long/path", "slug": "example"}'
```

Get the stats:

```bash
curl https://encurtador.<your-subdomain>.workers.dev/api/links/example/stats \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Errors: `400` for an invalid URL or slug, `401` without a valid token, `409` if the slug already exists.

## Status

Work in progress, built in phases:

- [ ] Setup (Worker running locally with Wrangler)
- [ ] Database schema (D1)
- [ ] Create links and redirect
- [ ] Click analytics
- [ ] Token authentication
- [ ] Dashboard
- [ ] Deploy
- [ ] README with screenshot and live link

## Next steps

- KV as a cache for redirects
- QR code for each link
- Links with an expiry date or a click limit
- Rate limiting on link creation
- Tests with Vitest (`@cloudflare/vitest-pool-workers`)
- GitHub Actions to deploy on every push

## Author

Tomás Seabra
