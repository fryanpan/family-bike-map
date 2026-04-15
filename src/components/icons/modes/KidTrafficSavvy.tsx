import type { SVGProps } from 'react'

// Kid traffic-savvy — adult bike + kid bike + dashed painted-lane stripe
// along the ground. The dashed line below the bikes signals painted-lane
// context where traffic-savvy kids can ride beside cars (no physical
// separation). Same bike composition as "kid confident" with the lane
// stripe as the differentiator.
export function KidTrafficSavvy(props: SVGProps<SVGSVGElement>) {
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
      {/* Adult bike (left) */}
      <circle cx="9" cy="20" r="7" strokeWidth="1.6" />
      <circle cx="25" cy="20" r="7" strokeWidth="1.6" />
      <path d="M9 20 L16 20 L13.5 11 Z" />
      <path d="M13.5 11 L20.5 11 L25 20" />
      <line x1="20.5" y1="11" x2="16" y2="20" />
      <line x1="11" y1="11" x2="16" y2="11" />
      <line x1="18.5" y1="9" x2="22.5" y2="9" />

      {/* Kid bike (right) */}
      <circle cx="40" cy="22" r="5" strokeWidth="1.4" />
      <circle cx="52" cy="22" r="5" strokeWidth="1.4" />
      <path d="M40 22 L46 22 L44 15 Z" strokeWidth="1.3" />
      <path d="M44 15 L49 15 L52 22" strokeWidth="1.3" />
      <line x1="49" y1="15" x2="46" y2="22" strokeWidth="1.3" />
      <line x1="42" y1="15" x2="46" y2="15" strokeWidth="1.3" />
      <line x1="47.5" y1="13" x2="51" y2="13" strokeWidth="1.3" />

      {/* Painted bike lane dashes across the bottom */}
      <line x1="2"  y1="30" x2="8"  y2="30" strokeWidth="1.4" />
      <line x1="12" y1="30" x2="18" y2="30" strokeWidth="1.4" />
      <line x1="22" y1="30" x2="28" y2="30" strokeWidth="1.4" />
      <line x1="32" y1="30" x2="38" y2="30" strokeWidth="1.4" />
      <line x1="42" y1="30" x2="48" y2="30" strokeWidth="1.4" />
      <line x1="52" y1="30" x2="58" y2="30" strokeWidth="1.4" />
    </svg>
  )
}
