# Learnings

Technical discoveries that should persist across sessions.

## Scoring architecture

- **One classifier drives both display and routing.** The same function that colors map tiles green or orange is the function that builds the routing cost function. Two parallel classifiers drift silently; a single source of truth does not. In this repo the canonical function is `classifyOsmTagsToItem` (for display) + `classifyEdge` (for routing), and the PR review should confirm neither grows mode-specific logic that diverges from the other.
- **Speed-based costs beat arbitrary penalty multipliers.** The router computes edge cost as `distance / speed`, where speed depends on infrastructure and mode. This naturally makes walking bridges (3 km/h on a sidewalk) cheaper than a 200 m detour through traffic without any special-case logic. Penalty-multiplier schemes like "painted lane is 3× worse than Fahrradstraße" are harder to tune and don't compose cleanly with multimodal bridges.
- **`highway=track` (forest/farm track) is LTS 1 + car-free for routing purposes** in `classifyEdge`, matching pre-refactor behaviour. Motor traffic exists but is rare and agricultural — different enough from a residential street that treating it as car-free is the least-surprising default. If this becomes wrong in a specific city, demote in the Layer 2 region overlay rather than changing the global rule.
- **The `carFree` vs `bikePriority` distinction on `LtsClassification` is load-bearing.** `carFree` means the bike does not share a traffic surface with motor vehicles (cycleway, path, curb-separated cycle track). `bikePriority` means the bike shares the surface but the street is engineered to give bikes priority (Fahrradstraße, SF Slow Street, living street). Kid-starting-out accepts either; kid-confident additionally accepts ordinary quiet residential. Don't collapse the two flags into one — they express different real-world guarantees.
- **SF Slow Streets appear in OSM as `highway=residential` + `motor_vehicle=destination`**, not as a dedicated tag. This is the OSM convention for "local-access only, through-traffic diverted" and is how `classifyEdge` detects them.

## Mode rules

- **Stamina is orthogonal to safety.** Earlier drafts of `ModeRule` carried a `maxContinuousKm` cap that rejected routes longer than a distance threshold. This conflates two axes: "this infrastructure is safe" and "my kid can ride this far before getting tired." Families judge distance themselves. The router optimises safety + time; distance is a user choice.
- **Fahrradstraßen ride at `slowSpeedKmh`, not `ridingSpeedKmh`**, even though they're accepted by kid-starting-out. The rider is still cautious around the occasional car. `applyModeRule` branches on `lts === 1 && !carFree` to select the slower speed.

## Router cleanup

- **Valhalla and BRouter are benchmark-only.** They live in `src/services/benchmark/` with explicit "BENCHMARK ONLY" comments and are imported only by `routerBenchmark.ts` and `AuditEvalTab.tsx`. The main app path goes through `src/services/clientRouter.ts` exclusively. If you need to add a feature that seems to require Valhalla (e.g. multi-waypoint routing), chain `clientRoute` calls inline instead.
- **Waypoint routing works by inline-chaining `clientRoute` calls** in `App.tsx` and concatenating the results, rather than delegating to a waypoint-capable router. Each leg is independent; leg boundaries just drop the duplicate joint coord.
- **`useRoads` is dead.** It was a Valhalla-specific costing knob that lived on `LegendItem` and was computed from the user's preferred items via `getCostingFromPreferences`. When Valhalla left the main path, both disappeared. If you see a reference to `useRoads` outside `benchmark/`, it's a stale comment.

## Stacked PRs

- **Squash-merging the base branch makes a stacked PR DIRTY**, not CLEAN. GitHub sees the squash commit on main as a brand-new SHA that doesn't match the original commits in the stacked branch, and reports conflicts for every file both touch. The fix is to merge `origin/main` into the feature branch, resolve conflicts by `git checkout --ours` (the stacked branch's content supersedes the squashed base by definition), commit the merge, and push. This was how PR #111 was cleanly merged after PR #110 squashed.

## Research documentation

- **Every city-profile claim cites a source URL**, non-negotiable. When research agents return findings without URLs, treat the finding as "unverified" and either ask for sources or drop the claim. The `docs/research/family-safety/city-profiles/` tree is structured so every bullet can be traced back to a named source: advocacy org, government plan, academic paper, or named blog/journalist. This is the defence against "AI slop" in a research-heavy product.
- **LTS framework is anchored to [Peter Furth's canonical criteria page](https://peterfurth.sites.northeastern.edu/level-of-traffic-stress/)**. When in doubt about how to classify an edge, consult that page before changing `classifyEdge` or any `ModeRule` threshold.
