import { describe, it, expect, afterEach, spyOn } from 'bun:test'
import * as Sentry from '@sentry/react'
import { GoogleMapsEngine } from '../src/services/mapEngine/GoogleMapsEngine'
import type { PathLayerFeature } from '../src/services/mapEngine/types'

// Sentry BIKE-MAP-1Z (2026-10-19): the deck.gl chunk failed to download and
// `addPathLayer`'s `void ...then()` had no `.catch`, so the rejection became an
// unhandled one — the overlay painted nothing and no report named the layer.
// These cover the rejected-import path.

const FEATURES: PathLayerFeature[] = [
  {
    id: 'way/1',
    coordinates: [[37.77, -122.42], [37.78, -122.41]],
    color: '#1a7f37',
    width: 4,
    opacity: 1,
  },
]

/** The real engine with the deck.gl import forced to reject. `ensureDeckOverlay`
 *  is `protected` for exactly this, so the failure travels the production path
 *  rather than a parallel one. */
class RejectingEngine extends GoogleMapsEngine {
  public rejectWith = new TypeError(
    'Failed to fetch dynamically imported module: https://bike-map.fryanpan.com/assets/dist-dQKir3ii.js',
  )
  protected override async ensureDeckOverlay(): Promise<never> {
    throw this.rejectWith
  }
}

function mountedEngine(): RejectingEngine {
  const e = new RejectingEngine()
  // requireMap() only needs a non-null map; nothing on the rejected path
  // touches the Google SDK.
  ;(e as unknown as { map: unknown }).map = {}
  return e
}

/** Let the rejected promise and its `.catch` run. */
const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  process.removeAllListeners('unhandledRejection')
})

describe('GoogleMapsEngine.addPathLayer when the deck.gl import rejects', () => {
  it('does not leave an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    process.on('unhandledRejection', (e) => unhandled.push(e))
    const spy = spyOn(Sentry, 'captureException').mockImplementation(() => '')

    const engine = mountedEngine()
    engine.addPathLayer(FEATURES)
    await flush()

    expect(unhandled).toEqual([])
    spy.mockRestore()
  })

  it('reports the failure with the stage and the layer it belonged to', async () => {
    const spy = spyOn(Sentry, 'captureException').mockImplementation(() => '')

    const engine = mountedEngine()
    const handle = engine.addPathLayer(FEATURES)
    await flush()

    expect(spy).toHaveBeenCalledTimes(1)
    const [err, ctx] = spy.mock.calls[0] as [unknown, { extra: Record<string, unknown> }]
    expect(err).toBe(engine.rejectWith)
    expect(ctx.extra).toEqual({
      stage: 'deck-overlay-load',
      layerId: handle.id,
      featureCount: FEATURES.length,
    })
    spy.mockRestore()
  })

  it('still returns a usable handle, so the caller is not left holding a broken one', async () => {
    const spy = spyOn(Sentry, 'captureException').mockImplementation(() => '')

    const engine = mountedEngine()
    const handle = engine.addPathLayer(FEATURES)
    await flush()

    expect(handle.__brand).toBe('pathLayer')
    // removePathLayer on a layer that never landed must not throw.
    expect(() => engine.removePathLayer(handle)).not.toThrow()
    spy.mockRestore()
  })

  it('does not leave a tombstone behind when the add it was waiting for fails', async () => {
    // removePathLayer records a tombstone when the async add has not landed,
    // expecting the pending `.then` to consume it. If the add REJECTS instead,
    // nothing ever consumes it and the set grows for the life of the session.
    const spy = spyOn(Sentry, 'captureException').mockImplementation(() => '')

    const engine = mountedEngine()
    const handle = engine.addPathLayer(FEATURES)
    engine.removePathLayer(handle) // races in before the rejection lands
    const tombstones = (engine as unknown as { removedPathLayerIds: Set<number> }).removedPathLayerIds
    expect(tombstones.has(handle.id)).toBe(true)

    await flush()

    expect(tombstones.has(handle.id)).toBe(false)
    spy.mockRestore()
  })
})
