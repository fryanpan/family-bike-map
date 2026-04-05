export interface MapillaryImage {
  id: string
  thumbUrl: string
  lat: number
  lng: number
}

const MAPILLARY_API = 'https://graph.mapillary.com/images'
const BBOX_DELTA = 0.0005 // ~50m radius

/**
 * Fetch the nearest Mapillary street-level image within ~50m of the given point.
 * Returns null if no token is configured, no images are found, or the API errors.
 */
export async function getStreetImage(lat: number, lng: number): Promise<MapillaryImage | null> {
  const token = import.meta.env.VITE_MAPILLARY_TOKEN
  if (!token) return null

  const bbox = `${lng - BBOX_DELTA},${lat - BBOX_DELTA},${lng + BBOX_DELTA},${lat + BBOX_DELTA}`
  const params = new URLSearchParams({
    bbox,
    limit: '1',
    fields: 'id,thumb_1024_url,computed_geometry',
    access_token: token,
  })

  try {
    const resp = await fetch(`${MAPILLARY_API}?${params}`)
    if (!resp.ok) return null

    const body = (await resp.json()) as {
      data: Array<{
        id: string
        thumb_1024_url: string
        computed_geometry: { coordinates: [number, number] }
      }>
    }

    if (!body.data || body.data.length === 0) return null

    const img = body.data[0]
    return {
      id: img.id,
      thumbUrl: img.thumb_1024_url,
      lat: img.computed_geometry.coordinates[1],
      lng: img.computed_geometry.coordinates[0],
    }
  } catch {
    return null
  }
}
