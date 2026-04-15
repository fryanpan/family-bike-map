import type { SVGProps } from 'react'

// Training — road bike with speed lines trailing behind. Sporty frame
// geometry (lower bars, longer reach) signals adult fitness riding.
// Single bike, no rider — the speed lines do the "fast" signalling.
export function Training(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="36"
      height="22"
      viewBox="0 0 56 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/* Speed lines (left, behind bike) */}
      <line x1="2" y1="13" x2="14" y2="13" strokeWidth="1.6" opacity="0.75" />
      <line x1="4" y1="18" x2="14" y2="18" strokeWidth="1.6" opacity="0.5" />
      <line x1="6" y1="23" x2="14" y2="23" strokeWidth="1.6" opacity="0.3" />

      {/* Road bike — slightly more aggressive frame (lower bars, longer reach) */}
      <circle cx="27" cy="22" r="8" strokeWidth="1.6" />
      <circle cx="46" cy="22" r="8" strokeWidth="1.6" />
      <path d="M27 22 L35 22 L32 12 Z" />
      <path d="M32 12 L41 13.5 L46 22" />
      <line x1="41" y1="13.5" x2="35" y2="22" />
      <line x1="29.5" y1="12" x2="35" y2="12" />
      {/* Drop handlebars — lower than seat, road style */}
      <line x1="40" y1="16" x2="44" y2="16" />
    </svg>
  )
}
