import type { SVGProps } from 'react'

// Kid starting out — walking adult figure beside a small kid on a bike.
// The adult is on foot next to the kid's bike, signalling the earliest
// riding stage where the parent walks alongside on car-free paths.
// Landscape-aspect line art drawn to read as a bike at ~22px tall.
export function KidStartingOut(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="40"
      height="22"
      viewBox="0 0 62 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/* Walking adult (stick figure, left) */}
      <circle cx="9" cy="6" r="2.5" />
      <line x1="9" y1="8.5" x2="9" y2="19" />
      {/* arms swinging */}
      <line x1="9" y1="12" x2="5" y2="17" />
      <line x1="9" y1="12" x2="13" y2="16" />
      {/* legs walking */}
      <line x1="9" y1="19" x2="5" y2="30" />
      <line x1="9" y1="19" x2="14" y2="30" />

      {/* Kid bike (right) */}
      <circle cx="32" cy="25" r="5.5" strokeWidth="1.4" />
      <circle cx="44" cy="25" r="5.5" strokeWidth="1.4" />
      {/* Rear triangle */}
      <path d="M32 25 L38 25 L36 17.5 Z" strokeWidth="1.3" />
      {/* Top tube + fork */}
      <path d="M36 17.5 L41.5 17.5 L44 25" strokeWidth="1.3" />
      {/* Down tube */}
      <line x1="41.5" y1="17.5" x2="38" y2="25" strokeWidth="1.3" />
      {/* Seat */}
      <line x1="34" y1="17.5" x2="38" y2="17.5" strokeWidth="1.3" />
      {/* Handlebar */}
      <line x1="39.5" y1="15.5" x2="43" y2="15.5" strokeWidth="1.3" />

      {/* Kid rider: head above seat, torso leaning toward handlebar */}
      <circle cx="37" cy="11" r="2" strokeWidth="1.3" />
      <line x1="37" y1="13" x2="36" y2="17.5" strokeWidth="1.3" />
      <line x1="37" y1="13.5" x2="41" y2="15.5" strokeWidth="1.3" />
    </svg>
  )
}
