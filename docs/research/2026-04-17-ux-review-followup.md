# UX Review Follow-up — after fix pass

**Date:** 2026-04-17, a few hours after the initial review
**Reviewed:** bike-map.fryanpan.com, with new `?mobile=iphone` preview
**Mobile target:** iPhone 16 Pro Max (430×932, Bryan's device) + Pixel
10 Pro (412×914, Joanna's device). iPhone SE kept as fallback.

## Summary

All six `Should-fix` issues from the initial review are fixed and
verified on production. The mobile preview mode added this pass makes
it possible to iterate on mobile UX from a desktop browser for the
first time — previously blocked because macOS Chrome can't resize its
window below ~800px.

## Initial issues → outcomes

| # | Initial finding | Status | Verification |
|---|---|---|---|
| 1 | Save as Home/School is silent | ✅ Fixed | Button flashes green "✓ Saved as Home" for 1.8s, then shows persistent teal "🏠 Your Home" if current place matches saved |
| 2 | Mode picker relocation perceived as bug | ➖ Not a bug | Re-reading the code, the conditional (`uiState !== 'routing'`) makes placement context-aware and correct |
| 3 | Saved Home label opaque | ✅ Fixed | Quick option now shows "🏠 Home / Dresdener Straße 112" — address as sublabel |
| 4 | "Rough" marker unexplained | ✅ Fixed | Label changed to "Bumpy · slow" — more concrete |
| 5 | Legend ↓ arrow affordance | ✅ Fixed | Replaced with −/+ (unprefer / prefer). Plus button styled teal-green as positive affordance. Expanded tooltips |
| 6 | Leaflet controls leak through admin overlay | ✅ Fixed | `.audit-overlay` z-index 900 → 2000; Leaflet controls (z-index 1000) now covered |

## New capability: mobile-preview mode

A URL param `?mobile=iphone` / `?mobile=pixel` / `?mobile=se` /
`?mobile=WxH` wraps the app in a fixed phone-sized frame and forces
the mobile CSS path, even in a wide browser window. All desktop
`@media (min-width: 768px)` rules now gate on `body:not(.mobile-preview)`
so the mobile layout is faithful.

This unblocks mobile UX iteration without a physical device or
DevTools emulation.

## Mobile findings caught and fixed during this pass

Running the mobile preview at iPhone 16 Pro Max (430×932) surfaced
issues that couldn't be seen on desktop:

### Mode picker wrapped to 2 rows (fixed)
At 430px viewport, the 5 mode chips at the default `padding: 8px 16px`
+ `gap: 8px` ran out of horizontal space. The 5th chip ("Fast training")
wrapped to a second row, which then overlapped the legend below.

**Fix:** added `@media (max-width: 480px)` block that tightens
`.profile-chip` padding to `6px 8px`, gap to `4px`, and caps SVG
width at 44px (the kid-traffic-savvy icon has the widest viewBox).
All 5 chips now fit on one row at 412px+ widths.

### Mode picker in route summary card also wrapped (fixed)
The same rules initially only targeted `.map-travel-mode .profile-chip`,
so the in-panel picker during routing still wrapped. Broadened the
selector to `.profile-chip` everywhere at ≤480px.

## Remaining minor issues (non-blocking)

1. **Segment labels crowd near the destination at low zoom.** In the
   routing view, labels like "Local road", "Sidewalk path", "Bike lane",
   "Radweg" can overlap when many short classified segments cluster.
   The `coalesceForIcons` logic is already there but evidently doesn't
   dedupe tightly enough at certain zooms. Not a ship blocker.
2. **Leaflet attribution clips at the right edge inside the mobile
   preview frame.** Cosmetic; on a real device the viewport would be
   wider than the preview frame.
3. **Gear button (⚙️) sits behind the Chrome extension's "Claude is
   active" banner at the bottom-left.** Artifact of the automation
   harness, not a real user issue.
4. **Quick-option sublabel may truncate** on very narrow widths if the
   saved place has a long `shortLabel`. Currently uses
   `text-overflow: ellipsis`; acceptable.

## What was verified on production

On `bike-map.fryanpan.com/?mobile=iphone`:

- [x] First-time flow ("Tap to add Home" / "Tap to add School")
- [x] Search a place (Nominatim autocomplete quality)
- [x] Open place card → save as Home → see "🏠 Your Home" persistent state
- [x] Open search → see saved Home with address sublabel
- [x] Click Home quick option → route renders
- [x] "Bumpy · slow" label appears on rough-surface segments
- [x] Legend `+` / `−` buttons with updated tooltips
- [x] Open `?admin=samples` → no Leaflet zoom controls visible
- [x] Mode picker fits 1 row on iPhone 16 Pro Max
- [x] Mode picker fits 1 row inside the route summary card on mobile

## Recommended next passes

1. **Real-device test on iPhone 16 Pro Max + Pixel 10 Pro.** The
   `?mobile=iphone` preview is a good proxy but not a substitute —
   real safe-area insets (notch, home indicator, Dynamic Island),
   touch pressure, viewport quirks under on-screen keyboard.
2. **Error-path walkthrough:** geolocation denied, offline, geocoding
   failure, Overpass tile timeout. None covered in either pass.
3. **Accessibility pass:** keyboard-only navigation, screen reader
   labels on the mode picker icons, color contrast on the custom
   green/orange palette.
4. **Onboarding experiment:** consider a one-time overlay on first
   launch explaining the mode picker (a "pick your rider" hint) so
   users don't have to guess icon meanings.
