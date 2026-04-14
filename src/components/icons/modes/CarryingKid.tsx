import type { SVGProps } from 'react'

// Carrying kid — adult piloting a bike with a small passenger
// in a rear child seat. Ambiguous enough to represent child seat,
// longtail cargo, bucket cargo, or trailer — hardware refinement
// lives in Layer 3 prose, not in the picker.
export function CarryingKid(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {/* Bike (larger adult-scale, centered) */}
      <circle cx="12" cy="38" r="4" />
      <circle cx="36" cy="38" r="4" />
      <path d="M 12 38 L 22 26 L 36 38" />
      {/* seat post */}
      <line x1="22" y1="26" x2="24" y2="22" />
      {/* handlebar stem */}
      <line x1="22" y1="26" x2="28" y2="24" />

      {/* Adult rider (leaning forward) */}
      <circle cx="28" cy="17" r="2.4" />
      <line x1="28" y1="19.4" x2="24" y2="22" />
      <line x1="26.5" y1="21" x2="28" y2="24" />

      {/* Rear child seat with small passenger */}
      {/* seat bracket */}
      <line x1="14" y1="28" x2="14" y2="24" />
      <line x1="14" y1="24" x2="18" y2="24" />
      {/* kid passenger */}
      <circle cx="16" cy="19" r="1.6" />
      <line x1="16" y1="20.6" x2="16" y2="24" />
    </svg>
  )
}
