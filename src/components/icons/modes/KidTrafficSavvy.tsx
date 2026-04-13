import type { SVGProps } from 'react'

// Kid traffic-savvy — kid on a painted bike lane with a car in the
// adjacent traffic lane, adult following behind. Dashed line signals
// "painted lane separation only" — the kid is making their own
// split-second decisions next to real traffic.
export function KidTrafficSavvy(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 56 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {/* Car in its lane (top) */}
      <path d="M 10 16 L 10 11 L 14 11 L 17 6 L 33 6 L 36 11 L 44 11 L 44 16 Z" />
      {/* windows */}
      <line x1="18" y1="11" x2="32" y2="11" />
      {/* wheels */}
      <circle cx="17" cy="16" r="2" />
      <circle cx="38" cy="16" r="2" />

      {/* Painted lane separator (dashed) */}
      <line x1="2" y1="22" x2="7" y2="22" />
      <line x1="12" y1="22" x2="17" y2="22" />
      <line x1="22" y1="22" x2="27" y2="22" />
      <line x1="32" y1="22" x2="37" y2="22" />
      <line x1="42" y1="22" x2="47" y2="22" />
      <line x1="52" y1="22" x2="54" y2="22" />

      {/* Adult on bike (behind, left) */}
      <circle cx="6" cy="42" r="3" />
      <circle cx="16" cy="42" r="3" />
      <path d="M 6 42 L 11 34 L 16 42" />
      <line x1="11" y1="34" x2="12" y2="31" />
      <line x1="11" y1="34" x2="13.5" y2="32" />
      <circle cx="12" cy="28" r="1.8" />
      <line x1="12" y1="29.8" x2="11.5" y2="34" />
      <line x1="12" y1="31" x2="13.5" y2="32" />

      {/* Kid on bike (ahead, right — in the painted lane) */}
      <circle cx="36" cy="43" r="2.4" />
      <circle cx="46" cy="43" r="2.4" />
      <path d="M 36 43 L 41 36 L 46 43" />
      <line x1="41" y1="36" x2="42" y2="33.5" />
      <line x1="41" y1="36" x2="43.5" y2="34" />
      <circle cx="42" cy="30" r="1.4" />
      <line x1="42" y1="31.4" x2="41.7" y2="36" />
      <line x1="42" y1="32.5" x2="43.5" y2="34" />
    </svg>
  )
}
