import { getPlaceDetail } from '../utils/types'
import type { Place } from '../utils/types'

interface Props {
  place: Place
  onDirections: () => void
  onBack: () => void
}

export default function PlaceCard({ place, onDirections, onBack }: Props) {
  const detail = getPlaceDetail(place.label)

  return (
    <div className="place-card">
      <button className="place-card-back" onClick={onBack} aria-label="Back to search">
        ← Back
      </button>
      <div className="place-card-info">
        <h2 className="place-card-name">{place.shortLabel}</h2>
        {detail && <p className="place-card-detail">{detail}</p>}
      </div>
      <button className="place-card-directions-btn" onClick={onDirections}>
        🚲 Directions
      </button>
    </div>
  )
}
