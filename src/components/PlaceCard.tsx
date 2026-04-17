import { getPlaceDetail } from '../utils/types'
import type { Place } from '../utils/types'

interface Props {
  place: Place
  onDirections: () => void
  onBack: () => void
  onSaveAsHome?: (place: Place) => void
  onSaveAsSchool?: (place: Place) => void
}

export default function PlaceCard({ place, onDirections, onBack, onSaveAsHome, onSaveAsSchool }: Props) {
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
      {(onSaveAsHome || onSaveAsSchool) && (
        <div className="place-card-save-row">
          {onSaveAsHome && (
            <button
              className="place-card-save-btn"
              onClick={() => onSaveAsHome(place)}
              title="Use this place as your saved Home"
            >
              🏠 Save as Home
            </button>
          )}
          {onSaveAsSchool && (
            <button
              className="place-card-save-btn"
              onClick={() => onSaveAsSchool(place)}
              title="Use this place as your saved School"
            >
              🏫 Save as School
            </button>
          )}
        </div>
      )}
    </div>
  )
}
