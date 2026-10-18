# Project: family-bike-map

## Overview
Family-friendly bike route finder. Accounts for specific safety preferences (quiet side streets, Fahrradstrasse, separated bike lanes, sidewalk width) that Google and Apple Maps don't handle well.

**Initial focus**: Berlin
**Long-term vision**: Any city worldwide, crowdsourced kid-friendly bike infrastructure map

See `docs/product/vision.md` for full product vision and requirements.

### Problem
- Google/Apple Maps don't understand family-specific bike safety needs
- No way to encode preferences like "quiet side streets OK at certain times" or "Fahrradstrasse are awesome"
- Route knowledge lives in people's heads and isn't shareable
- Existing bike tools (BBBike, InfraVelo, CyclOSM) have either no routing or unusable UX
- No tool works across cities with consistent quality

### Safety Preference Model
Routes are scored based on family-friendliness:
- **Great:** Fahrradstrasse, fully separated car-free trails (Mauerweg), nature paths
- **Good:** Separated bike lanes on sidewalk
- **OK:** Streets with wide sidewalk + nearby on-street bike lane, low car traffic
- **Acceptable:** Quiet side streets with minimal car traffic (time-of-day dependent)
- **Avoid:** Busy streets without protected infrastructure

## Architecture
See `docs/product/architecture.md` for full technical architecture.

**Core Stack:**
- **Routing Engine**: Valhalla (OSM-based, dynamic bike-specific costing, multi-city support)
- **API**: Go (or Node.js/Python TBD)
- **Database**: Postgres + PostGIS
- **Frontend**: React + MapLibre
- **Data Source**: OpenStreetMap (any region)

## Key Files

| File | Purpose |
|------|---------|
| `src/` | Source code |
| `tests/` | Test files |

### Documentation
| File | Purpose |
|------|---------|
| `docs/product/vision.md` | Product vision, requirements, success metrics |
| `docs/product/architecture.md` | Technical architecture and stack decisions |
| `docs/product/decisions.md` | Architecture & product decisions log |
| `docs/product/plans/` | Sprint/feature plans |
| `docs/research/existing-tools.md` | Analysis of existing Berlin bike tools |
| `docs/research/osm-routing-engines.md` | OSM routing engine comparison |
| `docs/process/learnings.md` | Technical gotchas |
| `docs/process/retrospective.md` | Session retro logs |

## Conventions

### Before Making Changes
- Read the relevant file(s) first
- Check `docs/product/decisions.md` for prior decisions on the topic
- Check `docs/process/learnings.md` when writing code that touches external services

### After Making Changes
- If the change involved a non-obvious decision, log it in `docs/product/decisions.md`
- If we learned something useful, add it to `docs/process/learnings.md`

### Code Style
- Prefer explicit over clever
- No unnecessary abstractions for one-time operations
- Clean up dead code created by your changes

### Dependencies
- **bun is the package manager.** `bun.lock` is the lockfile; CI and deploy both run
  `bun install --frozen-lockfile`. `package-lock.json` is NOT an install input — it is
  kept only because all 34 Dependabot alerts are attributed to it, and 10 of the 11
  alerted packages are transitive. Don't delete it to tidy up without first confirming
  that bun.lock-derived alerts actually cover the transitive tree.
- Dependabot version updates are pinned to the `bun` ecosystem in
  `.github/dependabot.yml`. A *version-update* PR that edits `package-lock.json` is
  aimed at a file nothing installs from; close it rather than merging it.
- Dependency PRs with fresh green CI may be merged without asking. Check two things
  first: the check's *date* (a green from before the last few dozen commits to main
  proves nothing) and the *file list* (a lockfile-only diff upgrades nothing).

@docs/process/learnings.md
@.claude/rules/routing-changes.md
@.claude/rules/rendering-changes.md
