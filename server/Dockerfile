# Route server — the browser's clientRoute over HTTP (see route-server.ts).
#
# Build from the REPO ROOT (the server imports src/services/* directly —
# one implementation of routing, so the whole src tree ships with it):
#   docker build -f server/Dockerfile -t bike-map-route-server .
#
# Run against a mounted tiles directory (<row>_<col>.json files):
#   docker run --rm -p 8787:8787 -v /path/to/tiles:/tiles:ro \
#     -e VITE_MAPBOX_TOKEN=... bike-map-route-server
#
# VITE_MAPBOX_TOKEN is optional — without it elevation fails soft and
# routing runs with no ascent cost (identical to a browser without
# terrain data). NOT deployed anywhere yet; production target is a
# separate decision after latency data exists (enriched-tiles plan §3).

FROM oven/bun:1

WORKDIR /app

# Install deps first for layer caching. Dev deps included on purpose:
# pngjs (the bun terrain-RGB decoder) is a devDependency.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY server ./server

EXPOSE 8787

CMD ["bun", "server/route-server.ts", "--tiles", "/tiles", "--port", "8787"]
