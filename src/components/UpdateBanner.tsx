/**
 * Small non-intrusive "Update available" toast. Surfaces whenever
 * src/services/swUpdate.ts detects a new deploy — either a new SW sitting
 * in `waiting`, or a `/version` mismatch found on foreground. This is the
 * primary way a pinned iOS home-screen app (which can sit suspended for
 * days without a real page navigation) learns it's running a stale build.
 */
import { useSwUpdateStatus, applyUpdate } from '../services/swUpdate'

export function UpdateBanner() {
  const { updateAvailable } = useSwUpdateStatus()
  if (!updateAvailable) return null

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span className="update-banner-text">Update available</span>
      <button className="update-banner-btn" onClick={() => applyUpdate()}>
        Reload
      </button>
    </div>
  )
}
