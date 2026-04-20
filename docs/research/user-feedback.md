# User Feedback Log

Freeform route- and product-level feedback from real rides. The in-app
`?admin=feedback` queue captures per-segment flags; this doc captures
feedback that doesn't fit a single segment — routing choices, turn
density, overall UX reactions.

## 2026-04-20 · Joanna — Gleisdreieck → Mehringdamm LPG

**Route-quality mismatch.** Route suggested from bottom of
Gleisdreieck to the Mehringdamm LPG didn't match Joanna's known-best
route. She used her own route instead. No specifics recorded on which
segments differed — follow up next ride to capture the divergence with
a flag-this-segment tap so we have something routable to fix.

**Too many turns.** Family-mode routes tend to prefer short hops
through quiet residential streets to maximize preferred-infra %, but
the result is navigation that's hard to follow without voice — and we
don't have voice yet. Likely mechanism: the A* cost function rewards
preferred-infra weight with no penalty for turn count, so a 10-turn
green-heavy route beats a 3-turn mostly-green route on the cost
function even though the mostly-green route is more usable.

Action items (not launch-blocking, but queue for post-launch):
- Add a **turn penalty** to the A* cost: each turn adds X seconds of
  "cognitive cost". Tune X against Joanna's known-good routes.
- Alternative: route quality summary card could show turn count, so
  users can compare alternates by turn-density as well as %.
- Route-quality feedback mechanism: extend the feedback queue to
  capture "this whole route is wrong" not just per-segment. Joanna
  would have wanted to flag the route as "too many turns" rather than
  one specific segment.
