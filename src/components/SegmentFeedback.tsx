/**
 * SegmentFeedback — floating button group shown during active navigation.
 * Lets the user rate the current road segment or report a problem.
 */

import { useState } from 'react'
import type { LatLng } from '../utils/types'

type ReportReason = 'surface_mismatch' | 'feels_unsafe' | 'missing_bike_lane' | 'other'

const REPORT_OPTIONS: Array<{ value: ReportReason; label: string }> = [
  { value: 'surface_mismatch', label: 'Surface mismatch' },
  { value: 'feels_unsafe', label: 'Feels unsafe' },
  { value: 'missing_bike_lane', label: 'Missing bike lane' },
  { value: 'other', label: 'Other' },
]

interface Props {
  currentLocation: LatLng | null
  travelMode: string
  routeLogId?: string | null
}

async function sendFeedback(
  location: LatLng,
  feedbackType: string,
  detail: string | null,
  travelMode: string,
  routeLogId?: string | null,
): Promise<void> {
  await fetch('/api/segment-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat: location.lat,
      lng: location.lng,
      feedbackType,
      detail,
      travelMode,
      routeLogId: routeLogId ?? null,
    }),
  })
}

export default function SegmentFeedback({ currentLocation, travelMode, routeLogId }: Props) {
  const [reportOpen, setReportOpen] = useState(false)
  const [sent, setSent] = useState<string | null>(null) // tracks last sent type for brief flash

  function handleQuickFeedback(type: 'good' | 'bad') {
    if (!currentLocation) return
    sendFeedback(currentLocation, type, null, travelMode, routeLogId)
    setSent(type)
    setTimeout(() => setSent(null), 1500)
  }

  function handleReport(reason: ReportReason) {
    if (!currentLocation) return
    sendFeedback(currentLocation, 'report', reason, travelMode, routeLogId)
    setReportOpen(false)
    setSent('report')
    setTimeout(() => setSent(null), 1500)
  }

  return (
    <div className="segment-feedback">
      {sent ? (
        <span className="segment-feedback-sent">Recorded</span>
      ) : (
        <div className="segment-feedback-buttons">
          <button
            className="segment-feedback-btn segment-feedback-good"
            onClick={() => handleQuickFeedback('good')}
            title="Good segment"
            disabled={!currentLocation}
          >
            👍
          </button>
          <button
            className="segment-feedback-btn segment-feedback-bad"
            onClick={() => handleQuickFeedback('bad')}
            title="Bad segment"
            disabled={!currentLocation}
          >
            👎
          </button>
          <button
            className="segment-feedback-btn segment-feedback-report"
            onClick={() => setReportOpen((v) => !v)}
            title="Report issue"
            disabled={!currentLocation}
          >
            ⚠️
          </button>
        </div>
      )}

      {reportOpen && (
        <div className="segment-feedback-form">
          <p className="segment-feedback-form-title">What's wrong?</p>
          {REPORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className="segment-feedback-option"
              onClick={() => handleReport(opt.value)}
            >
              {opt.label}
            </button>
          ))}
          <button
            className="segment-feedback-cancel"
            onClick={() => setReportOpen(false)}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
