/**
 * Decode a Valhalla/Google encoded polyline.
 * Valhalla uses precision=6 (1e6 factor); Google uses precision=5.
 * Returns array of [lat, lng] pairs suitable for Leaflet.
 */
export function decode(encoded, precision = 6) {
  const factor = Math.pow(10, precision)
  const len = encoded.length
  let index = 0
  let lat = 0
  let lng = 0
  const coordinates = []

  while (index < len) {
    let b
    let shift = 0
    let result = 0
    do {
      b = encoded.charCodeAt(index++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    const dlat = result & 1 ? ~(result >> 1) : result >> 1
    lat += dlat

    shift = 0
    result = 0
    do {
      b = encoded.charCodeAt(index++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    const dlng = result & 1 ? ~(result >> 1) : result >> 1
    lng += dlng

    coordinates.push([lat / factor, lng / factor])
  }

  return coordinates
}
