import { useState, useRef, useEffect } from 'react'
import { getPlaceDetail } from '../utils/types'
import type { Place } from '../utils/types'

interface Props {
  place: Place
  onDirections: () => void
  onBack: () => void
  onSaveAsHome?: (place: Place) => void
  onSaveAsSchool?: (place: Place) => void
  currentHome?: Place | null
  currentSchool?: Place | null
}

/** ~5m at Berlin latitude — plenty of tolerance for "same place". */
function isSamePlace(a: Place | null | undefined, b: Place): boolean {
  if (!a) return false
  return Math.abs(a.lat - b.lat) < 0.00005 && Math.abs(a.lng - b.lng) < 0.00005
}

export default function PlaceCard({
  place, onDirections, onBack,
  onSaveAsHome, onSaveAsSchool,
  currentHome, currentSchool,
}: Props) {
  const detail = getPlaceDetail(place.label)
  const [flash, setFlash] = useState<'home' | 'school' | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => { if (flashTimer.current) clearTimeout(flashTimer.current) }
  }, [])

  const flashFor = (kind: 'home' | 'school') => {
    setFlash(kind)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 1800)
  }

  const isThisHome   = isSamePlace(currentHome, place)
  const isThisSchool = isSamePlace(currentSchool, place)

  const homeLabel =
    flash === 'home' ? '✓ Saved as Home' :
    isThisHome       ? '🏠 Your Home' :
                       '🏠 Save as Home'
  const schoolLabel =
    flash === 'school' ? '✓ Saved as School' :
    isThisSchool       ? '🏫 Your School' :
                         '🏫 Save as School'

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
              className={`place-card-save-btn${flash === 'home' ? ' saved-flash' : ''}${isThisHome ? ' is-current' : ''}`}
              onClick={() => { onSaveAsHome(place); flashFor('home') }}
              title="Use this place as your saved Home"
              disabled={flash === 'home'}
            >
              {homeLabel}
            </button>
          )}
          {onSaveAsSchool && (
            <button
              className={`place-card-save-btn${flash === 'school' ? ' saved-flash' : ''}${isThisSchool ? ' is-current' : ''}`}
              onClick={() => { onSaveAsSchool(place); flashFor('school') }}
              title="Use this place as your saved School"
              disabled={flash === 'school'}
            >
              {schoolLabel}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
