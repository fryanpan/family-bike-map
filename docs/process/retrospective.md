# Retrospective Log

## 2026-03-31 — BC-222 Initial Prototype

**What worked:**
- Valhalla `trace_attributes` for segment colouring is the right call — gives rich per-edge data without needing a custom routing graph; falls back gracefully to solid blue if the call fails
- Splitting the Cloudflare Worker into proxy + feedback in one worker keeps secrets co-located and avoids a second deploy target
- Mobile-first CSS with CSS transforms for the bottom sheet panel is clean and avoids any JS animation library dependency
- Precision-6 polyline decoder was a genuine gotcha worth a unit test — the encode/decode roundtrip is easy to verify but the constant (1e6 vs 1e5) is silent and wrong without a test

**What didn't:**
- No deployed test environment at PR time — secrets need to be set up out-of-band before CI deploy runs; should have flagged this earlier rather than at review
- Context window overflowed mid-session; required continuing from a conversation summary which is lossy

**Action:** Document the deploy bootstrap sequence (worker first → get URL → set VITE_WORKER_URL → merge PR) in the plan so it's clear to anyone picking this up cold.
