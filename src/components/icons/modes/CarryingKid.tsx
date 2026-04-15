import type { SVGProps } from 'react'

// Carrying kid — adult bike towing a child trailer. The trailer is a
// single boxy shape because the mode covers all carrying variants
// (trailer, longtail, bucket cargo, child seat). Landscape composition:
// trailer on the left, bike on the right, hitch arm connecting them.
export function CarryingKid(props: SVGProps<SVGSVGElement>) {
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
      {/* Bike (right portion) */}
      <circle cx="34" cy="22" r="8" strokeWidth="1.6" />
      <circle cx="52" cy="22" r="8" strokeWidth="1.6" />
      <path d="M34 22 L42 22 L39 12 Z" />
      <path d="M39 12 L47 12 L52 22" />
      <line x1="47" y1="12" x2="42" y2="22" />
      <line x1="36" y1="12" x2="42" y2="12" />
      <line x1="45" y1="10" x2="49" y2="10" />

      {/* Hitch arm: rear axle → trailer coupling */}
      <line x1="34" y1="22" x2="22" y2="20" strokeWidth="1.4" />

      {/* Trailer body */}
      <rect x="5" y="13" width="17" height="12" rx="2" strokeWidth="1.4" />
      {/* Trailer wheels */}
      <circle cx="9.5"  cy="25" r="4" strokeWidth="1.4" />
      <circle cx="17.5" cy="25" r="4" strokeWidth="1.4" />
    </svg>
  )
}
