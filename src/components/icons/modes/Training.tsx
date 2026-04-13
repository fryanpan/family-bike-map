import type { SVGProps } from 'react'

// Training — single adult cyclist in a leaned-forward sporty
// posture with speed lines behind. Secondary mode, optimized for
// 30 km/h flow and LTS ≤3. Komoot alternative for the primary user.
export function Training(props: SVGProps<SVGSVGElement>) {
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
      {/* Bike */}
      <circle cx="14" cy="36" r="4" />
      <circle cx="36" cy="36" r="4" />
      <path d="M 14 36 L 22 24 L 36 36" />
      {/* seat post */}
      <line x1="22" y1="24" x2="24" y2="20" />
      {/* handlebar stem angled forward/down */}
      <line x1="22" y1="24" x2="30" y2="22" />

      {/* Rider leaning forward, helmet line */}
      <circle cx="30" cy="15" r="2.3" />
      {/* body leaning down toward bars */}
      <line x1="30" y1="17.3" x2="24" y2="20" />
      {/* arm forward to bars */}
      <line x1="28" y1="18" x2="30" y2="22" />

      {/* Speed lines behind */}
      <line x1="3" y1="18" x2="8" y2="18" />
      <line x1="2" y1="23" x2="9" y2="23" />
      <line x1="4" y1="28" x2="8" y2="28" />
    </svg>
  )
}
