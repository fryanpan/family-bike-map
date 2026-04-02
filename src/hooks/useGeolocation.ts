import { useState, useEffect } from 'react'
import type { LatLng } from '../utils/types'

export type GeolocationStatus = 'idle' | 'active' | 'denied' | 'unavailable'

export interface GeolocationState {
  location: LatLng | null
  status: GeolocationStatus
}

export function useGeolocation(): GeolocationState {
  const [location, setLocation] = useState<LatLng | null>(null)
  const [status, setStatus] = useState<GeolocationStatus>('idle')

  useEffect(() => {
    if (!navigator.geolocation) {
      setStatus('unavailable')
      return
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setStatus('active')
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setStatus('denied')
        } else {
          setStatus('unavailable')
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )

    return () => navigator.geolocation.clearWatch(watchId)
  }, [])

  return { location, status }
}
