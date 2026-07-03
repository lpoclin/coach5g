import type { NFType } from '@/types/topology'

/* ── SVG icon definitions ─────────────────────────────────────────────────── */
function svg(inner: string, bg: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
    <rect width="48" height="48" rx="10" fill="${bg}" opacity="0.95"/>
    ${inner}
  </svg>`
}

// Shared text label at bottom
const label = (t: string, y = 40) =>
  `<text x="24" y="${y}" text-anchor="middle" font-size="9" fill="#e2e8f0" font-family="system-ui,sans-serif" font-weight="700">${t}</text>`

const ICONS: Record<string, string> = {
  NRF: svg(`
    <circle cx="24" cy="20" r="7" fill="none" stroke="#93c5fd" stroke-width="2"/>
    <circle cx="24" cy="8"  r="3" fill="#60a5fa"/>
    <circle cx="35" cy="15" r="3" fill="#60a5fa"/>
    <circle cx="35" cy="29" r="3" fill="#60a5fa"/>
    <circle cx="24" cy="36" r="3" fill="#60a5fa"/>
    <circle cx="13" cy="29" r="3" fill="#60a5fa"/>
    <circle cx="13" cy="15" r="3" fill="#60a5fa"/>
    <line x1="24" y1="11" x2="24" y2="13" stroke="#60a5fa" stroke-width="1.5"/>
    <line x1="32.5" y1="16.8" x2="30.5" y2="18" stroke="#60a5fa" stroke-width="1.5"/>
    <line x1="32.5" y1="27.2" x2="30.5" y2="26" stroke="#60a5fa" stroke-width="1.5"/>
    <line x1="24" y1="33" x2="24" y2="27" stroke="#60a5fa" stroke-width="1.5"/>
    <line x1="15.5" y1="27.2" x2="17.5" y2="26" stroke="#60a5fa" stroke-width="1.5"/>
    <line x1="15.5" y1="16.8" x2="17.5" y2="18" stroke="#60a5fa" stroke-width="1.5"/>
    ${label('NRF', 44)}`, '#1e3a6e'),

  AMF: svg(`
    <rect x="12" y="10" width="24" height="18" rx="3" fill="none" stroke="#93c5fd" stroke-width="2"/>
    <rect x="16" y="14" width="4" height="4" rx="1" fill="#60a5fa"/>
    <rect x="22" y="14" width="4" height="4" rx="1" fill="#60a5fa"/>
    <rect x="28" y="14" width="4" height="4" rx="1" fill="#60a5fa"/>
    <rect x="16" y="20" width="4" height="4" rx="1" fill="#60a5fa"/>
    <rect x="22" y="20" width="4" height="4" rx="1" fill="#60a5fa"/>
    <rect x="28" y="20" width="4" height="4" rx="1" fill="#60a5fa"/>
    <line x1="18" y1="28" x2="18" y2="34" stroke="#93c5fd" stroke-width="1.5"/>
    <line x1="30" y1="28" x2="30" y2="34" stroke="#93c5fd" stroke-width="1.5"/>
    <line x1="14" y1="34" x2="34" y2="34" stroke="#93c5fd" stroke-width="1.5"/>
    ${label('AMF', 44)}`, '#1e3a6e'),

  SMF: svg(`
    <circle cx="24" cy="18" r="9" fill="none" stroke="#93c5fd" stroke-width="2"/>
    <path d="M20 18 L24 14 L28 18 L24 22 Z" fill="#60a5fa"/>
    <line x1="24" y1="27" x2="24" y2="34" stroke="#93c5fd" stroke-width="1.5"/>
    <circle cx="18" cy="34" r="2.5" fill="none" stroke="#93c5fd" stroke-width="1.5"/>
    <circle cx="24" cy="36" r="2.5" fill="none" stroke="#93c5fd" stroke-width="1.5"/>
    <circle cx="30" cy="34" r="2.5" fill="none" stroke="#93c5fd" stroke-width="1.5"/>
    ${label('SMF', 46)}`, '#1e3a6e'),

  AUSF: svg(`
    <path d="M24 8 L32 14 L32 24 C32 30 28 35 24 37 C20 35 16 30 16 24 L16 14 Z" fill="none" stroke="#93c5fd" stroke-width="2"/>
    <path d="M20 22 L23 25 L28 19" stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round" fill="none"/>
    ${label('AUSF', 44)}`, '#1e3a6e'),

  UDM: svg(`
    <ellipse cx="24" cy="14" rx="12" ry="5" fill="none" stroke="#93c5fd" stroke-width="1.5"/>
    <rect x="12" y="14" width="24" height="14" fill="none" stroke="#93c5fd" stroke-width="1.5"/>
    <ellipse cx="24" cy="28" rx="12" ry="5" fill="none" stroke="#93c5fd" stroke-width="1.5"/>
    <line x1="24" y1="19" x2="24" y2="23" stroke="#60a5fa" stroke-width="1.5"/>
    <circle cx="24" cy="21" r="2" fill="#60a5fa"/>
    ${label('UDM', 41)}`, '#1e3a6e'),

  UDR: svg(`
    <ellipse cx="24" cy="13" rx="10" ry="4" fill="none" stroke="#93c5fd" stroke-width="1.5"/>
    <rect x="14" y="13" width="20" height="10" fill="none" stroke="#93c5fd" stroke-width="1.5"/>
    <ellipse cx="24" cy="23" rx="10" ry="4" fill="none" stroke="#93c5fd" stroke-width="1.5"/>
    <ellipse cx="24" cy="30" rx="10" ry="4" fill="none" stroke="#7dd3fc" stroke-width="1.5"/>
    <line x1="16" y1="16" x2="22" y2="16" stroke="#60a5fa" stroke-width="1"/>
    <line x1="16" y1="19" x2="20" y2="19" stroke="#60a5fa" stroke-width="1"/>
    ${label('UDR', 41)}`, '#1e3a6e'),

  PCF: svg(`
    <rect x="14" y="10" width="20" height="22" rx="3" fill="none" stroke="#c084fc" stroke-width="2"/>
    <line x1="18" y1="16" x2="30" y2="16" stroke="#c084fc" stroke-width="1.5"/>
    <line x1="18" y1="20" x2="30" y2="20" stroke="#c084fc" stroke-width="1.5"/>
    <line x1="18" y1="24" x2="26" y2="24" stroke="#c084fc" stroke-width="1.5"/>
    <circle cx="30" cy="33" r="5" fill="#a855f7"/>
    <line x1="28" y1="33" x2="32" y2="33" stroke="white" stroke-width="1.5"/>
    <line x1="30" y1="31" x2="30" y2="35" stroke="white" stroke-width="1.5"/>
    ${label('PCF', 44)}`, '#2d1b69'),

  NSSF: svg(`
    <circle cx="24" cy="18" r="10" fill="none" stroke="#93c5fd" stroke-width="2"/>
    <path d="M17 18 Q20 11 24 18 Q28 25 31 18" fill="none" stroke="#60a5fa" stroke-width="2"/>
    <line x1="14" y1="18" x2="34" y2="18" stroke="#93c5fd" stroke-width="1" stroke-dasharray="2 2"/>
    ${label('NSSF', 36)}`, '#1e3a6e'),

  CHF: svg(`
    <rect x="14" y="10" width="20" height="16" rx="3" fill="none" stroke="#93c5fd" stroke-width="2"/>
    <line x1="19" y1="14" x2="29" y2="14" stroke="#60a5fa" stroke-width="1.5"/>
    <line x1="19" y1="18" x2="26" y2="18" stroke="#60a5fa" stroke-width="1.5"/>
    <path d="M18 27 L18 36 L24 32 L30 36 L30 27" fill="none" stroke="#fbbf24" stroke-width="2"/>
    ${label('CHF', 46)}`, '#1e3a6e'),

  NEF: svg(`
    <rect x="10" y="14" width="28" height="14" rx="7" fill="none" stroke="#93c5fd" stroke-width="2"/>
    <circle cx="17" cy="21" r="3" fill="#60a5fa"/>
    <circle cx="24" cy="21" r="3" fill="#60a5fa"/>
    <circle cx="31" cy="21" r="3" fill="#60a5fa"/>
    <path d="M10 35 Q15 30 20 35 Q25 40 30 35 Q35 30 38 35" fill="none" stroke="#93c5fd" stroke-width="1.5"/>
    ${label('NEF', 46)}`, '#1e3a6e'),

  UPF: svg(`
    <path d="M12 16 L24 10 L36 16 L36 28 L24 34 L12 28 Z" fill="none" stroke="#4ade80" stroke-width="2"/>
    <line x1="12" y1="16" x2="36" y2="16" stroke="#4ade80" stroke-width="1" stroke-dasharray="3 2"/>
    <line x1="24" y1="10" x2="24" y2="34" stroke="#4ade80" stroke-width="1" stroke-dasharray="3 2"/>
    <circle cx="24" cy="22" r="3" fill="#22c55e"/>
    ${label('UPF', 44)}`, '#14532d'),

  iUPF: svg(`
    <path d="M12 16 L24 10 L36 16 L36 28 L24 34 L12 28 Z" fill="none" stroke="#4ade80" stroke-width="2"/>
    <line x1="12" y1="16" x2="36" y2="16" stroke="#4ade80" stroke-width="1" stroke-dasharray="3 2"/>
    <line x1="24" y1="10" x2="24" y2="34" stroke="#4ade80" stroke-width="1" stroke-dasharray="3 2"/>
    <circle cx="24" cy="22" r="3" fill="#22c55e"/>
    <text x="24" y="27" text-anchor="middle" font-size="7" fill="#bbf7d0" font-family="sans-serif">i</text>
    ${label('iUPF', 44)}`, '#14532d'),

  gNB: svg(`
    <line x1="24" y1="8"  x2="24" y2="28" stroke="#fb923c" stroke-width="2.5"/>
    <path d="M18 14 Q24 8 30 14" fill="none" stroke="#fb923c" stroke-width="2"/>
    <path d="M14 18 Q24 6 34 18" fill="none" stroke="#fb923c" stroke-width="1.5" opacity="0.6"/>
    <rect x="20" y="28" width="8" height="6" rx="1" fill="none" stroke="#fb923c" stroke-width="1.5"/>
    <line x1="20" y1="34" x2="16" y2="38" stroke="#fb923c" stroke-width="1.5"/>
    <line x1="28" y1="34" x2="32" y2="38" stroke="#fb923c" stroke-width="1.5"/>
    ${label('gNB', 46)}`, '#431407'),

  UE: svg(`
    <rect x="16" y="10" width="16" height="26" rx="3" fill="none" stroke="#fb923c" stroke-width="2"/>
    <line x1="20" y1="14" x2="28" y2="14" stroke="#fb923c" stroke-width="1.5"/>
    <rect x="20" y="17" width="8" height="12" rx="1" fill="#fb923c" opacity="0.3"/>
    <circle cx="24" cy="33" r="1.5" fill="#fb923c"/>
    ${label('UE', 44)}`, '#431407'),

  DN: svg(`
    <ellipse cx="24" cy="20" rx="14" ry="10" fill="none" stroke="#6b7280" stroke-width="2"/>
    <path d="M10 20 Q17 14 24 20 Q31 26 38 20" fill="none" stroke="#6b7280" stroke-width="1.5"/>
    <line x1="24" y1="10" x2="24" y2="30" stroke="#6b7280" stroke-width="1" stroke-dasharray="2 2"/>
    <line x1="10" y1="20" x2="38" y2="20" stroke="#6b7280" stroke-width="1" stroke-dasharray="2 2"/>
    ${label('DN/Internet', 38)}`, '#1f2937'),

  UNKNOWN: svg(`
    <circle cx="24" cy="20" r="10" fill="none" stroke="#6b7280" stroke-width="2"/>
    <text x="24" y="25" text-anchor="middle" font-size="16" fill="#9ca3af" font-family="sans-serif">?</text>
    ${label('NF', 38)}`, '#1f2937'),
}

export function getNFIcon(nfType: NFType): string {
  const raw = ICONS[nfType] ?? ICONS.UNKNOWN
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`
}

export function getNFColor(nfType: NFType): string {
  const map: Partial<Record<NFType, string>> = {
    NRF: '#3b82f6', AMF: '#3b82f6', SMF: '#3b82f6',
    AUSF: '#3b82f6', UDM: '#3b82f6', UDR: '#3b82f6',
    PCF: '#a855f7', NSSF: '#3b82f6', CHF: '#3b82f6', NEF: '#3b82f6',
    UPF: '#22c55e', iUPF: '#22c55e',
    gNB: '#f97316', UE: '#f97316',
    DN: '#6b7280', UNKNOWN: '#6b7280',
  }
  return map[nfType] ?? '#6b7280'
}

// React icon components for UI elements
interface IconProps { className?: string }

export function IconRefresh({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd"/>
    </svg>
  )
}

export function IconX({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/>
    </svg>
  )
}

export function IconChevronDown({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd"/>
    </svg>
  )
}

export function IconDownload({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd"/>
    </svg>
  )
}

export function IconPlay({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd"/>
    </svg>
  )
}

export function IconStop({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd"/>
    </svg>
  )
}

export function IconPause({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd"/>
    </svg>
  )
}
