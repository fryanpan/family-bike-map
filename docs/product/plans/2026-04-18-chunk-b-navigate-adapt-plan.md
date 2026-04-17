# Chunk B · UC5 · Navigate & adapt hardening

## Goal

Make the in-ride experience usable. Today the app can compute a great
route but a parent actually riding with a kid has almost no in-saddle
affordances: "reroute around this scary block", "tell the app this
segment was mis-classified", "I'm off route, reroute me from here"
all either don't exist or require going back to the search flow.

## Non-goals

- No turn-by-turn voice synthesis beyond what's already shipped.
- No backend for feedback; writes go into region-rule proposals stored
  locally (admin can review later and promote to real rules).

## Current state

- Live GPS navigation exists (commit `71dfdec` "live GPS navigation
  with auto-advance and segment indicators")
- Distance-to-step counter is in the maneuvers panel
- Segment tooltips work on tap
- No off-route detection; no "avoid this segment"; no feedback loop

## Design

### 1 · Avoid-this-segment action
Tap any route segment in routing state → popup with:
- Current classification (e.g. "Painted bike lane / LTS 2")
- **"Reroute around this"** button (primary)
- **"Flag as wrong"** button (secondary, opens feedback)

"Reroute around this" adds the edge IDs of the tapped OsmWay to a
session-scoped `avoidedWayIds` set, passed into the graph builder as
an edge-rejection filter. Reroute triggers a new `clientRoute` call
with same start/end/waypoints. New route computed in ~2s, user sees
the detour.

### 2 · Off-route detection
During navigation state, compute nearest-point on the current route
polyline for each GPS update. If the user drifts > 30 m for > 10 s,
show a non-blocking banner:
- "Off route — recalculate?"
- **"Reroute"** / **Dismiss**

Reroute uses current GPS position as new start, keeps original end.

### 3 · Flag segment feedback
Tap "Flag as wrong" on a segment → modal:
- Shows OSM tags + current classification
- Radio: "Actually preferred" / "Actually should be avoided" / "Rough"
- Free-text note (optional)
- Save → appends to `localStorage.bike-route-feedback-queue`
- Admin tab in `?admin=feedback` (new) reviews the queue + one-click
  promote to a real region rule

## Work items

1. **Tap-to-avoid infrastructure.** Add `avoidedWayIds: Set<number>`
   to App state, thread through `clientRoute` → `buildRoutingGraph`.
   Reject matching ways at graph-build time.
2. **Segment-tap popup** with Reroute + Flag buttons. The tooltip
   component already exists — extend it to show actions when the app
   is in routing state.
3. **Off-route detector.** In the navigation state (GPS tracking on),
   check distance-from-route every position update. Threshold:
   30m for 10s.
4. **Off-route banner** with Reroute CTA.
5. **Feedback queue.** Local-only (no backend). Simple serialized
   list in localStorage.
6. **`?admin=feedback` tab.** List queue items, each with Promote /
   Dismiss / Edit buttons. Promote writes a new
   `ClassificationRule` and prepends to the active region rules.
7. **Tests.** Avoid-list integration test (route excludes specified
   ways); off-route distance computation unit test.

## Risks

- **GPS jitter causing false off-route detections.** Start with a
  conservative 30m/10s threshold; users can tune later.
- **Feedback queue bloat.** Cap at 100 items per region; oldest
  dropped. Admin UI should make it obvious when queue is full.
- **Reroute with current start = user's GPS position.** If the user
  is moving, the new route could start 20m ahead of them. Acceptable
  for now; treat GPS position as "start point" verbatim.

## Exit criteria

- [ ] Tap any route segment → popup with Reroute-around / Flag
- [ ] Reroute around adds way to avoid list, re-routes cleanly
- [ ] Off-route banner appears after 30m/10s drift, Reroute recovers
- [ ] Flag opens a modal, saves to localStorage, `?admin=feedback`
      displays the queue
- [ ] Admin can promote a flag → region rule in one click
