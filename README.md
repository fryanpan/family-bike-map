# Family Bike Map
Google Maps (and other apps) do a poor job helping families discover or plan rides with young children.  Other apps focus mainly on older riders who are comfortable with traffic rules and minimal separation from cars.

This is a prototype that caters instead to families -- how can we discover, plan and go on family rides with a toddler?  How can we take into account what's comfortable and safe as a toddler progresses.  

**Try it at [bike-map.fryanpan.com](https://bike-map.fryanpan.com)**

For example, this is the progression Bea's been moving along (she's at around stage 3) 
| Stage | Needs |
| 1. Learning to ride | Fully car free, flat, smooth, enough space to learn to manouver (e.g. wide path or open area) |
| 2. Can ride with some bike control | Needs full separation from cars or slow sidewalk riding |
| 3. Has good bike control, but no traffic sense | Ideally has full separation from cars or sidewalk riding, but can sometimes bike on quiet streets |
| 4. Has good bike control, can observe other vehicles and apply traffic rules | Can start using bike paths with partial separation (e.g. painted bike lanes) |

At each stage we needed a different map.  At first (about a year ago when Bea was at Stage 1), I started compiling [this map](https://felt.com/map/SF-Bay-Area-Toddler-Friendly-Bike-Paths-KeytayiJQr2w1aiFU9CNrkB?share=1&loc=37.731,-122.3192,10.01z) of great car-free bike paths around the SF Bay Area by hand.  But it's so labor intensive and hard to adapt as Bea's abilities improve.

Most of the data exists (e.g. see [Cyclosm](https://www.cyclosm.org/) which shows the bike route data available in OpenStreetMaps).  But all the existing apps and maps I've found start with the assumption that any bicycle infrastructure is useful.  For toddlers though (and even adults), this is rarely ever true.

So that's why I took a couple days to build this prototype, on top of OpenStreetMap data via Overpass API.  And with a custom, browser-side routing engine that can handle toddler rides that go partly on bikeways and partly on sidewalks (when needed).

## What you can do

### Browse the map for safe paths

Open the map and see all bike infrastructure colored by safety:

- **Green paths** are safe for a child on their own bike — car-free bike paths, bike-priority streets (called *Fahrradstrasse* in Germany, where cars are guests and cyclists have priority), park trails, and protected elevated paths separated from traffic
- **Orange paths** are roads where cars are present — painted bike lanes, residential streets, bus lanes

Zoom in anywhere and instantly see which streets are safe for your family. Find your own routes to parks, cafes, schools, museums — anywhere you want to go.

### Route with a toddler travel mode

Search for a destination and get a route optimized for riding with a young child:

- Your child bikes on safe paths at their own pace (~10 km/h)
- On short stretches without safe infrastructure, the route switches to walking on the sidewalk (~3 km/h) rather than riding in traffic
- The router automatically finds bike-priority streets and car-free paths that other routing engines miss
- You see exactly which parts of the route are safe to ride and which are walking segments

This multimodal approach means the router will walk your family past a scary intersection rather than route you through it — even if it takes a bit longer.

### Other ride modes

There are five ride modes total. Four match Bea's progression above (starting out, confident, traffic-savvy) and one adds the parent-piloted case:

- **Kid starting out / confident / traffic-savvy** — the three stages above, each with a different acceptable-infrastructure set. Switching up as your kid grows is a one-tap change.
- **Carrying kid** — adult pilots a child seat, trailer, or cargo bike at 20-25 km/h. Surface-strict; willing to mix with traffic since the adult has full judgment.
- **Training** — solo rides at 25-35 km/h on a road bike. Prefers smooth asphalt, okay with traffic on quiet roads. Avoids tram tracks and bumpy surfaces.

## Why this exists

Every bike routing app (Google Maps, Apple Maps, Komoot) treats all bike infrastructure the same. A painted line on a busy 4-lane road counts as "bike-friendly" — identical to a car-free path through a park. For a parent riding with a 4-year-old, these are completely different.

This app routes on what you can actually see on the map. The same classification that colors paths green or orange also drives the routing cost function. If a path looks safe on the map, the router will use it.

## How it works

**Client-side routing.** Routes are computed in your browser using cached OpenStreetMap data — no server needed, no rate limits, works offline once an area is downloaded. A typical city graph (30,000-60,000 intersections) routes in 10-30 milliseconds.

**Speed-based costs.** Instead of arbitrary penalties, the router uses realistic travel speeds. A child bikes at 10 km/h on a bike-priority street but walks at 3 km/h past a busy road. The router naturally minimizes total time by maximizing time on safe, fast infrastructure.

**Single classification.** Every road segment is classified from OpenStreetMap tags (road type, bike lane type, surface quality, speed limit, physical separation from cars). The same classifier drives the map overlay, the routing engine, and the quality metrics. What you see is what you route on.

### Benchmark

22 test routes in Berlin, kid-starting-out mode:

| Engine | Avg safe infrastructure |
|--------|:---:|
| **Family Bike Map** | **57%** |
| BRouter (safety profile) | 40% |
| Valhalla (max bike preference) | 35% |

Wins 13 out of 16 head-to-head comparisons against Valhalla, finding bike-priority streets and car-free paths that Valhalla routes through painted bike lanes instead.

A parallel 22-route benchmark in San Francisco lands **20-22/22 routed** on every mode, with 94-99% preferred-infrastructure on adult modes (carrying-kid, training, kid-traffic-savvy). Tradeoffs and per-mode numbers: [docs/research/2026-04-20-sf-benchmark.md](docs/research/2026-04-20-sf-benchmark.md).

## Features

- **Browse** bike infrastructure on a map — see what's safe at a glance
- **Route** with five ride modes (kid starting out / confident / traffic-savvy, carrying kid, training)
- **Navigate** with live GPS tracking, auto-advancing turn-by-turn, and voice announcements
- **Download areas** for offline routing — Google Maps-style viewport selection
- **Classify** infrastructure with an admin audit tool and Mapillary street imagery
- **Score** routes by % on safe infrastructure with intersection gap healing

## Getting started

Visit [bike-map.fryanpan.com](https://bike-map.fryanpan.com). The app works in any browser, mobile or desktop.

Tested most thoroughly in **Berlin** and the **San Francisco Bay Area**, but works anywhere OpenStreetMap has cycling infrastructure tagged. Download an area and try it in your city.

## Development

```bash
bun install
bun run dev     # local dev server
bun test        # run tests (245)
bun run build   # production build
```

### Tech stack

- React + Leaflet (frontend)
- ngraph.path (client-side A* routing)
- Cloudflare Workers + KV + D1 (API proxy, classification rules, route logs)
- OpenStreetMap / Overpass API (infrastructure data)
- Valhalla + BRouter (benchmark-only, not in the main routing path)

See [docs/product/architecture.md](docs/product/architecture.md) for the full architecture with diagrams.

## Contributing

This project is in active development. Issues and pull requests welcome. See [docs/product/routing-use-cases.md](docs/product/routing-use-cases.md) for the use cases driving development.

## License

MIT
