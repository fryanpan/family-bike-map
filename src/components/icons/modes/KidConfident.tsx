import type { SVGProps } from 'react'

// Kid confident — adult bike + kid bike riding together.
// Adult (left) is bigger, kid (right) is smaller. Same core composition as
// the previous "toddler" icon with clean triangular frame geometry that
// reads as a bike at small sizes.
export function KidConfident(props: SVGProps<SVGSVGElement>) {
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
      <circle cx="9" cy="22" r="8" strokeWidth="1.6" />
      <circle cx="27" cy="22" r="8" strokeWidth="1.6" />
      <path d="M9 22 L17 22 L14 12 Z" />
      <path d="M14 12 L22 12 L27 22" />
      <line x1="22" y1="12" x2="17" y2="22" />
      <line x1="11" y1="12" x2="17" y2="12" />
      <line x1="20" y1="10" x2="24" y2="10" />
      {/* Adult rider */}
      <circle cx="18" cy="5" r="2.2" />
      <line x1="18" y1="7.2" x2="17" y2="12" />
      <line x1="18" y1="7.5" x2="22" y2="10" />

      {/* Kid bike (right, smaller) */}
      <circle cx="44" cy="25" r="5.5" strokeWidth="1.4" />
      <circle cx="56" cy="25" r="5.5" strokeWidth="1.4" />
      <path d="M44 25 L50 25 L48 17.5 Z" strokeWidth="1.3" />
      <path d="M48 17.5 L53.5 17.5 L56 25" strokeWidth="1.3" />
      <line x1="53.5" y1="17.5" x2="50" y2="25" strokeWidth="1.3" />
      <line x1="46" y1="17.5" x2="50" y2="17.5" strokeWidth="1.3" />
      <line x1="51.5" y1="15.5" x2="55" y2="15.5" strokeWidth="1.3" />
      {/* Kid rider */}
      <circle cx="49" cy="11" r="1.8" strokeWidth="1.3" />
      <line x1="49" y1="12.8" x2="48" y2="17.5" strokeWidth="1.3" />
      <line x1="49" y1="13" x2="53" y2="15.5" strokeWidth="1.3" />
    </svg>
  )
}
