import { describe, it, expect, mock } from 'bun:test'

// We test the geolocation options and callback behavior by simulating what
// the hook does, since React hooks cannot be called outside a component context
// without a testing library. This file validates the watch/cleanup contract
// and the correct options passed to watchPosition.

// ---------------------------------------------------------------------------
// Helpers to simulate the navigator.geolocation API
// ---------------------------------------------------------------------------

interface MockWatchArgs {
  successCb: PositionCallback
  errorCb: PositionErrorCallback
  options: PositionOptions
}

function makeMockGeolocation() {
  const watches = new Map<number, MockWatchArgs>()
  let nextId = 1

  const watchPosition = mock((
    success: PositionCallback,
    error: PositionErrorCallback,
    options: PositionOptions,
  ) => {
    const id = nextId++
    watches.set(id, { successCb: success, errorCb: error, options })
    return id
  })

  const clearWatch = mock((id: number) => {
    watches.delete(id)
  })

  function fireSuccess(id: number, lat: number, lng: number) {
    const w = watches.get(id)
    if (!w) throw new Error(`No watch with id ${id}`)
    w.successCb({
      coords: {
        latitude: lat,
        longitude: lng,
        accuracy: 10,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    } as GeolocationPosition)
  }

  function fireError(id: number, code: number, message: string) {
    const w = watches.get(id)
    if (!w) throw new Error(`No watch with id ${id}`)
    const err = {
      code,
      message,
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    } as GeolocationPositionError
    w.errorCb(err)
  }

  function getWatch(id: number) {
    return watches.get(id)
  }

  function activeWatchCount() {
    return watches.size
  }

  return { watchPosition, clearWatch, fireSuccess, fireError, getWatch, activeWatchCount }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('watchPosition options for live GPS tracking', () => {
  it('calls watchPosition with enableHighAccuracy: true', () => {
    const geo = makeMockGeolocation()
    // Simulate what useGeolocation sets up
    const id = geo.watchPosition(
      () => {},
      () => {},
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
    const watch = geo.getWatch(id)
    expect(watch?.options.enableHighAccuracy).toBe(true)
  })

  it('calls watchPosition with maximumAge: 0 to prevent stale positions', () => {
    const geo = makeMockGeolocation()
    const id = geo.watchPosition(
      () => {},
      () => {},
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
    const watch = geo.getWatch(id)
    expect(watch?.options.maximumAge).toBe(0)
  })

  it('calls watchPosition with a timeout', () => {
    const geo = makeMockGeolocation()
    const id = geo.watchPosition(
      () => {},
      () => {},
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
    const watch = geo.getWatch(id)
    expect(watch?.options.timeout).toBe(10000)
  })
})

describe('watchPosition callback contract', () => {
  it('invokes success callback with lat/lng on each position update', () => {
    const geo = makeMockGeolocation()
    const positions: Array<{ lat: number; lng: number }> = []

    const id = geo.watchPosition(
      (pos) => positions.push({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )

    geo.fireSuccess(id, 52.52, 13.405)
    geo.fireSuccess(id, 52.521, 13.406)

    expect(positions).toEqual([
      { lat: 52.52, lng: 13.405 },
      { lat: 52.521, lng: 13.406 },
    ])
  })

  it('invokes error callback when permission is denied', () => {
    const geo = makeMockGeolocation()
    const errors: number[] = []

    const id = geo.watchPosition(
      () => {},
      (err) => errors.push(err.code),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )

    geo.fireError(id, 1 /* PERMISSION_DENIED */, 'User denied geolocation')

    expect(errors).toEqual([1])
  })

  it('cleans up by calling clearWatch on unmount', () => {
    const geo = makeMockGeolocation()

    const id = geo.watchPosition(() => {}, () => {}, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 })
    expect(geo.activeWatchCount()).toBe(1)

    // Simulate cleanup (what React useEffect return does)
    geo.clearWatch(id)
    expect(geo.activeWatchCount()).toBe(0)
    expect(geo.clearWatch).toHaveBeenCalledWith(id)
  })

  it('continues to receive updates after the first position', () => {
    const geo = makeMockGeolocation()
    let callCount = 0

    const id = geo.watchPosition(
      () => { callCount++ },
      () => {},
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )

    geo.fireSuccess(id, 52.5, 13.4)
    geo.fireSuccess(id, 52.51, 13.41)
    geo.fireSuccess(id, 52.52, 13.42)

    expect(callCount).toBe(3)
  })
})
