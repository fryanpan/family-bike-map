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
 * A claim is the single record of "this tile is in flight". Two earlier cuts
 * of this got it wrong in opposite directions, and both failures looked like
 * the bug it fixes:
 *
 *   - Tracking the keys in a Set alongside the controllers let an abandoned
 *     fetch's cleanup retract a NEWER fetch's claim, so the next viewport
 *     event fetched a tile that was already downloading.
 *   - Keeping every claim alive through its abort stopped a dead queued
 *     waiter from ever being re-requested; the return leg painted 35.6% of
 *     a cold load.
 *
 * Hence `started`: a queued waiter is dead the moment it is aborted and must
 * be re-requestable at once, while a fetch holding a slot is still
 * downloading and must not be duplicated.
 */
interface Claim {
  controller: AbortController
  /** True once the fetch holds a concurrency slot and is really downloading. */
  started: boolean
}

export class TileFetchClaims {
  private _claims = new Map<string, Claim>()

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
    this._claims.set(key, { controller, started: false })
    return controller
  }

  /**
   * Mark `key`'s fetch as holding a concurrency slot.
   *
   * This is the line between the two states abandonment has to tell apart,
   * and the caller is the only one who knows when it is crossed.
   */
  markStarted(key: string): void {
    const claim = this._claims.get(key)
    if (claim) claim.started = true
  }

  /**
   * Abandon every QUEUED claim whose key is not in `desired`, freeing the
   * gate for the tiles the rider is actually looking at. Returns those keys.
   *
   * Started fetches are left alone — see `_abandon`.
   */
  abandonSuperseded(desired: Iterable<string>): string[] {
    const keep = desired instanceof Set ? desired : new Set(desired)
    const aborted: string[] = []
    for (const [key, claim] of this._claims) {
      if (keep.has(key) || !this._abandon(key, claim)) continue
      aborted.push(key)
    }
    return aborted
  }

  /**
   * Drop every claim — the overlay is resetting to a new generation.
   *
   * Started fetches are dropped here too, unlike in `abandonSuperseded`. The
   * generation guard discards their results either way, so holding their
   * claims protects nothing and only stops the new generation from
   * requesting those tiles at all.
   */
  abandonAll(): void {
    for (const claim of this._claims.values()) {
      if (!claim.started) claim.controller.abort()
    }
    this._claims.clear()
  }

  /** Returns true when the claim was a queued waiter this call killed. */
  private _abandon(key: string, claim: Claim): boolean {
    // A started fetch is left strictly alone. Aborting it would not stop it —
    // the gate ignores the signal once the slot is granted — and dropping its
    // claim would let the next selection fetch the same tile a second time,
    // taking another of the two slots.
    if (claim.started) return false
    claim.controller.abort()
    this._claims.delete(key)
    return true
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
    if (this._claims.get(key)?.controller !== controller) return false
    this._claims.delete(key)
    return true
  }
}
