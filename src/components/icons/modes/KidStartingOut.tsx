import type { SVGProps } from 'react'

// Kid starting out — adult walking beside a kid on a bike.
// The kid has some bike control but needs fully car-free pathways;
// the walking adult signals "parent stays close on foot, at walking pace."
export function KidStartingOut(props: SVGProps<SVGSVGElement>) {
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
      {/* Adult walking (left) */}
      <circle cx="10" cy="13" r="2.4" />
      <line x1="10" y1="15.4" x2="10" y2="28" />
      {/* swinging arms */}
      <line x1="10" y1="19" x2="6.5" y2="25" />
      <line x1="10" y1="19" x2="13.5" y2="24" />
      {/* walking legs */}
      <line x1="10" y1="28" x2="6.5" y2="41" />
      <line x1="10" y1="28" x2="14" y2="41" />

      {/* Kid on bike (right) */}
      <circle cx="26" cy="38" r="3" />
      <circle cx="38" cy="38" r="3" />
      {/* frame V */}
      <path d="M 26 38 L 32 30 L 38 38" />
      {/* seat post + handlebar stem */}
      <line x1="32" y1="30" x2="33" y2="27" />
      <line x1="32" y1="30" x2="35" y2="28" />
      {/* kid rider */}
      <circle cx="33" cy="23.5" r="1.6" />
      <line x1="33" y1="25.1" x2="32.6" y2="30" />
      <line x1="33" y1="26.5" x2="35" y2="28" />
    </svg>
  )
}
