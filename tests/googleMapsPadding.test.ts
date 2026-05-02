// Regression test for the Google Maps fitBounds padding mapping.
//
// The bug: GoogleMapsEngine read FitBoundsOptions.paddingTopLeft as
// [top, left] (matching the type comment at the time) but the
// convention is actually [x, y] = [left, top] (Leaflet Point format,
// which the Leaflet adapter and all call sites follow). Result: on
// mobile, ~500 px of horizontal padding got applied to a 400 px-wide
// screen and the map zoomed all the way out instead of fitting the
// route.
//
// The fix moved the mapping into `paddingArrayToGoogle` so we can
// assert on it directly. This file pins down the contract.

import { describe, it, expect } from 'bun:test'
import { paddingArrayToGoogle } from '../src/services/mapEngine/GoogleMapsEngine'

describe('paddingArrayToGoogle (FitBoundsOptions → google.maps.Padding)', () => {
  it('treats paddingTopLeft as [left, top] (Leaflet Point convention)', () => {
    // Mobile call site: paddingTopLeft = [40, 100] = 40 px from left, 100 from top.
    const out = paddingArrayToGoogle([40, 100], [40, 380])
    expect(out.left).toBe(40)
    expect(out.top).toBe(100)
    expect(out.right).toBe(40)
    expect(out.bottom).toBe(380)
  })

  it('matches desktop fit values (sidebar on left, no chrome on right/bottom)', () => {
    // Desktop call site: paddingTopLeft = [360, 40], paddingBottomRight = [40, 40]
    // = 360 px left chrome (sidebar), 40 px breathing room everywhere else.
    const out = paddingArrayToGoogle([360, 40], [40, 40])
    expect(out.left).toBe(360)
    expect(out.top).toBe(40)
    expect(out.right).toBe(40)
    expect(out.bottom).toBe(40)
  })

  it('zero-fills when padding tuples are missing', () => {
    expect(paddingArrayToGoogle(undefined, undefined)).toEqual({
      top: 0, left: 0, right: 0, bottom: 0,
    })
  })

  it('regression: never confuses left and top (the original bug)', () => {
    // A unique-value sentinel for each axis catches any swap.
    const out = paddingArrayToGoogle([1, 2], [3, 4])
    expect(out.left).toBe(1)   // x of topLeft
    expect(out.top).toBe(2)    // y of topLeft
    expect(out.right).toBe(3)  // x of bottomRight
    expect(out.bottom).toBe(4) // y of bottomRight
  })
})
