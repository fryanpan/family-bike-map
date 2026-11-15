/**
 * Tracks which detail tiles have a fetch in flight, and lets the viewport
 * abandon the ones it has moved past.
 *
 * A wide-zoom pan over an un-baked region can enqueue MAX_FETCH_TILES fetches
 * behind the 2-wide Overpass concurrency gate. Zooming back in then selects
 * tiles that are already "in flight" — queued, in fact, behind dozens the
 * rider has left behind — and the loader skips anything already claimed, so
 * nothing re-prioritises them. Dropping the superseded claims lets the tile
 * the rider is actually looking at reach the front of the queue. Measured
 * 2026-11-15: reaching a z14 viewport via a z10 overview painted 45% of what
 * a cold load painted, and no re-render recovered it.
 *
 * A claim is the single record of "this tile is in flight". Tracking the keys
 * in a Set alongside the controllers is what made the first cut of this
 * wrong: an abandoned fetch's cleanup retracted a NEWER fetch's claim, and
 * the next viewport event issued a second fetch for a tile already
 * downloading — taking a gate slot, which is the starvation this exists to
 * remove.
 */
export class TileFetchClaims {
  private _claims = new Map<string, AbortController>()

  /** True while a fetch for `key` is in flight and has not been abandoned. */
  has(key: string): boolean {
    return this._claims.has(key)
  }

  get size(): number {
    return this._claims.size
  }

  /** Record a fetch for `key`, returning the controller that can abandon it. */
  claim(key: string): AbortController {
    const controller = new AbortController()
    this._claims.set(key, controller)
    return controller
  }

  /**
   * Abort every claim whose key is not in `desired`. Returns the aborted keys.
   *
   * The claim itself survives the abort, and only `releaseIfCurrent` ever
   * removes one. Aborting does not stop a fetch that already holds a gate
   * slot — the signal stops mattering once the slot is granted — so dropping
   * its claim here would let a rider who pans away and back start a SECOND
   * fetch for a tile already downloading, taking another scarce slot. A
   * queued waiter rejects immediately, so its claim clears a microtask later
   * and the tile is re-requestable at the next viewport event.
   */
  abandonSuperseded(desired: Iterable<string>): string[] {
    const keep = desired instanceof Set ? desired : new Set(desired)
    const aborted: string[] = []
    for (const [key, controller] of this._claims) {
      if (keep.has(key) || controller.signal.aborted) continue
      controller.abort()
      aborted.push(key)
    }
    return aborted
  }

  /** Abort every claim — the overlay is resetting. Claims clear as they settle. */
  abandonAll(): void {
    for (const controller of this._claims.values()) {
      if (!controller.signal.aborted) controller.abort()
    }
  }

  /**
   * Retract `controller`'s claim on `key`, if it is still the live one.
   *
   * A fetch that was abandoned and then re-requested leaves two settlements
   * for one key. Only the current claim may be retracted; retracting
   * unconditionally leaves the newer fetch unclaimed, and the next viewport
   * event fetches that tile a second time.
   */
  releaseIfCurrent(key: string, controller: AbortController): boolean {
    if (this._claims.get(key) !== controller) return false
    this._claims.delete(key)
    return true
  }
}
