# Project: bike-route-finder

## Overview
Family-friendly bike route finder for Berlin. Accounts for specific safety preferences (quiet side streets, Fahrradstrasse, separated bike lanes, sidewalk width) that Google and Apple Maps don't handle well.

### Problem
- Google/Apple Maps don't understand family-specific bike safety needs
- No way to encode preferences like "quiet side streets OK at certain times" or "Fahrradstrasse are awesome"
- Route knowledge lives in people's heads and isn't shareable
- Komoot/Strava heatmaps lack granular enough filters

### Safety Preference Model
Routes are scored based on family-friendliness:
- **Great:** Fahrradstrasse, fully separated car-free trails (Mauerweg), nature paths
- **Good:** Separated bike lanes on sidewalk
- **OK:** Streets with wide sidewalk + nearby on-street bike lane, low car traffic
- **Acceptable:** Quiet side streets with minimal car traffic (time-of-day dependent)
- **Avoid:** Busy streets without protected infrastructure

## Architecture
TBD — initial prototype phase

## Key Files

| File | Purpose |
|------|---------|
| `src/` | Source code |
| `tests/` | Test files |

### Documentation
| File | Purpose |
|------|---------|
| `docs/product/decisions.md` | Architecture & product decisions log |
| `docs/product/plans/` | Sprint/feature plans |
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

@docs/process/learnings.md
