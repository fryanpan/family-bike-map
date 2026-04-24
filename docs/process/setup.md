# Setup & Deployment Guide

## Architecture

The app runs as a single **Cloudflare Worker with [assets]** binding. One deployment serves both the static frontend (Vite-built React app from `./dist`) and the API routes (Valhalla proxy, Nominatim proxy, Linear feedback). No separate hosting (Surge, etc.) is needed.

- `src/worker.ts` handles `/api/*` routes
- The `[assets]` binding serves everything else from `./dist` with SPA fallback
- Custom domain: **bike.fryanpan.com** (configured in `wrangler.toml`)

---

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Bun](https://bun.sh/) (runtime and package manager)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-setup/) (`bun add -g wrangler` or installed as a dev dependency)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine)
- Linear API access (for the feedback widget)

---

## Local Development

```bash
bun install
bun run dev
```

`bun run dev` runs `wrangler dev`, which serves both the frontend and the API locally. The Worker handles `/api/*` routes (Valhalla, Nominatim, feedback) and the `[assets]` binding serves the Vite-built frontend with SPA fallback.

Open **http://localhost:8787**.

Run tests:

```bash
bun test
```

---

## Build

```bash
bun run build
```

Runs `vite build`, outputting the production frontend to `./dist`. The Worker serves these files via the `[assets]` binding.

---

## Deploy

### Manual deploy

```bash
npx wrangler login       # one-time: authenticate with Cloudflare
bun run deploy           # vite build && wrangler deploy
```

This builds the frontend and deploys both the Worker and static assets in a single step.

### Worker secrets

Set these once (or when rotating) via `wrangler secret put`:

```bash
npx wrangler secret put MAPILLARY_TOKEN      # Mapillary API token (proxied server-side)
npx wrangler secret put GOOGLE_MAPS_API_KEY  # Google Maps API key — Street View Static + Directions (proxied server-side)
```

### GitHub Actions (automated CI/CD)

Merging to `main` triggers the deploy workflow (`.github/workflows/deploy.yml`), which builds and deploys to Cloudflare automatically.

Add these secrets in **GitHub repo > Settings > Secrets and variables > Actions**:

| Secret | How to get it |
|--------|---------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard > My Profile > API Tokens > Create Token > "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard > Workers & Pages > Account ID (right sidebar) |

No other secrets are needed in GitHub Actions. Worker secrets are set directly on Cloudflare via `wrangler secret put` and persist across deploys.

### Custom domain

The custom domain **bike.fryanpan.com** is configured in `wrangler.toml`:

```toml
[[routes]]
pattern = "bike.fryanpan.com"
custom_domain = true
```

Cloudflare manages the DNS automatically when `custom_domain = true`. No separate DNS configuration is required as long as the domain's DNS is on Cloudflare.

---

## Troubleshooting

**Routes don't load**
- Check the browser network tab for `/api/valhalla/route`. A 502/503 means the upstream Valhalla public instance may be temporarily down.
- Verify the Worker is deployed: `npx wrangler deployments list`.

**Feedback doesn't create a Linear ticket**
- Confirm secrets are set: `npx wrangler secret list`
- Check Worker logs: `npx wrangler tail`

**Static assets return 404**
- Make sure `bun run build` completed successfully and `./dist` contains the built files.
- Check that `wrangler.toml` has `[assets] directory = "./dist"`.

**`wrangler dev` fails to start**
- Ensure `wrangler` is installed: `npx wrangler --version`
- Check that `compatibility_date` in `wrangler.toml` is not in the future.

**Bike overlay shows "zoom in to see bike paths"**
- The viewport is too large. Zoom in until you can see individual streets.
