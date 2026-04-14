import type { SVGProps } from 'react'

// Kid confident — kid and adult both on bikes, riding together.
// Kid has good control and basic road awareness; adult is alongside
// close enough to correct mistakes, but no longer on foot.
export function KidConfident(props: SVGProps<SVGSVGElement>) {
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
      {/* Adult on bike (left, bigger) */}
      <circle cx="6" cy="38" r="3.5" />
      <circle cx="18" cy="38" r="3.5" />
      <path d="M 6 38 L 12 28 L 18 38" />
      <line x1="12" y1="28" x2="13" y2="24" />
      <line x1="12" y1="28" x2="15" y2="25.5" />
      {/* adult rider */}
      <circle cx="13" cy="19.5" r="2.2" />
      <line x1="13" y1="21.7" x2="12.5" y2="28" />
      <line x1="13" y1="23.5" x2="15" y2="25.5" />

      {/* Kid on bike (right, smaller) */}
      <circle cx="28" cy="39" r="2.6" />
      <circle cx="38" cy="39" r="2.6" />
      <path d="M 28 39 L 33 32 L 38 39" />
      <line x1="33" y1="32" x2="34" y2="29.5" />
      <line x1="33" y1="32" x2="35.5" y2="30" />
      {/* kid rider */}
      <circle cx="34" cy="26" r="1.5" />
      <line x1="34" y1="27.5" x2="33.7" y2="32" />
      <line x1="34" y1="28.5" x2="35.5" y2="30" />
    </svg>
  )
}
