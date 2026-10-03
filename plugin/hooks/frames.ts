// Animation frames for the alert band: pure functions of (style, color, time).
//
// The light bars above and below an alert banner are a `Raster` on the
// terminal (one cell per column, packed as RasterProps says) and a handful
// of colored `Text` runs on surfaces without one. Text never goes into a
// Raster: messages may hold wide characters, which a Raster cell cannot.

import type { AlertStyle } from '../types'

/** LCARS console colors. */
export const LCARS = {
  orange: '#FF9900',
  sand: '#FFCC99',
  peach: '#FF9966',
  lavender: '#CC99CC',
  violet: '#9999FF',
  blue: '#99CCFF',
  tan: '#CC9966',
  green: '#66DD99',
  red: '#FF5555',
  ink: '#000000',
} as const

/** How long each style animates before the band settles, in milliseconds. */
export const DURATION_MS: Record<AlertStyle, number> = { sweep: 2600, pulse: 6000, klaxon: 10000 }

/** Frames per second while an alert animates. */
export const FPS = 20

/** A klaxon banner is lit for this long, then dark for as long. */
const BLINK_MS = 420

type Rgb = readonly [number, number, number]

function rgb(color: string): Rgb {
  const n = Number.parseInt(color.slice(1, 7), 16)
  return Number.isNaN(n) ? [255, 153, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function channel(v: number): string {
  return Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
}

/** Blends `a` toward `b` by `t` (0..1). */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a)
  const [br, bg, bb] = rgb(b)
  const k = Math.max(0, Math.min(1, t))
  return `#${channel(ar + (br - ar) * k)}${channel(ag + (bg - ag) * k)}${channel(ab + (bb - ab) * k)}`.toUpperCase()
}

/**
 * Brightness (0..1) of the bar cell at `x` (0 at the left edge, 1 at the
 * right) `ms` into the animation. `row` 0 is nearest the banner.
 */
function intensity(style: AlertStyle, x: number, ms: number, row: number): number {
  const s = ms / 1000
  if (style === 'klaxon') {
    // Waves of light running outward from the center, as on a starship's
    // red alert panel, under a throb that peaks while the banner is lit.
    const d = Math.abs(x - 0.5) * 2
    const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * (d * 2.4 - s * 1.7 + row * 0.18))
    const throb = 0.6 + 0.4 * Math.cos((2 * Math.PI * (ms - BLINK_MS / 2)) / (BLINK_MS * 2))
    return wave * wave * throb
  }
  if (style === 'pulse') {
    // A slow breath, brightest at the center.
    const breath = 0.5 + 0.5 * Math.sin(2 * Math.PI * (s / 1.4) - Math.PI / 2)
    return breath * (1 - 0.45 * Math.abs(x - 0.5) * 2)
  }
  // sweep: a scanner head running left to right with a fading tail.
  const head = ((s / 1.25) % 1) * 1.3 - 0.15
  const behind = head - x
  return behind >= 0 && behind < 0.18 ? 1 - behind / 0.18 : 0
}

function barColor(style: AlertStyle, color: string, x: number, ms: number, row: number): string {
  const floor = style === 'sweep' ? 0.12 : 0.1
  return mix(mix(LCARS.ink, color, floor), color, intensity(style, x, ms, row))
}

/** Every SEGMENT-th column is a gap, so the bars read as LCARS segments. */
const SEGMENT = 7
const DEFAULT_COLOR = 0x01000000

function packed(color: string): number {
  const [r, g, b] = rgb(color)
  return (r << 16) | (g << 8) | b
}

function base64(bytes: Uint8Array): string {
  const native = bytes as Uint8Array & { toBase64?: () => string }
  if (typeof native.toBase64 === 'function') {
    return native.toBase64()
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/**
 * Raster cells for `rows` rows of light bars, `columns` wide. `edge` says
 * which side of the banner they sit on: the row farthest from the banner is
 * a thin half-block line, the rest full blocks.
 */
export function barCells(
  style: AlertStyle,
  color: string,
  columns: number,
  rows: number,
  ms: number,
  edge: 'top' | 'bottom',
): string {
  const view = new DataView(new ArrayBuffer(columns * rows * 12))
  for (let y = 0; y < rows; y += 1) {
    const fromBanner = edge === 'top' ? rows - 1 - y : y
    const isOuter = fromBanner === rows - 1 && rows > 1
    const glyph = isOuter ? (edge === 'top' ? 0x2584 : 0x2580) : rows === 1 ? (edge === 'top' ? 0x2584 : 0x2580) : 0x2588
    for (let x = 0; x < columns; x += 1) {
      const offset = (y * columns + x) * 12
      const isGap = style !== 'sweep' && x % SEGMENT === SEGMENT - 1
      view.setUint32(offset, isGap ? 0x20 : glyph, true)
      view.setUint32(offset + 4, isGap ? DEFAULT_COLOR : packed(barColor(style, color, x / Math.max(1, columns - 1), ms, fromBanner)), true)
      view.setUint32(offset + 8, DEFAULT_COLOR, true)
    }
  }
  return base64(new Uint8Array(view.buffer))
}

/** The same bars as `count` colored runs, for surfaces without a Raster. */
export function barRuns(style: AlertStyle, color: string, count: number, ms: number): string[] {
  return Array.from({ length: count }, (_, i) => barColor(style, color, i / Math.max(1, count - 1), ms, 0))
}

/** Banner colors `ms` into the animation; a settled (latched) banner is steady. */
export function bannerColors(
  style: AlertStyle,
  color: string,
  ms: number,
  isSettled: boolean,
): { background: string; foreground: string } {
  if (isSettled) {
    return { background: mix(LCARS.ink, color, 0.85), foreground: LCARS.ink }
  }
  if (style === 'klaxon') {
    const isOn = Math.floor(ms / BLINK_MS) % 2 === 0
    return isOn
      ? { background: color, foreground: LCARS.ink }
      : { background: mix(LCARS.ink, color, 0.18), foreground: color }
  }
  if (style === 'pulse') {
    const breath = 0.5 + 0.5 * Math.sin(2 * Math.PI * (ms / 1400) - Math.PI / 2)
    return { background: mix(LCARS.ink, color, 0.35 + 0.65 * breath), foreground: LCARS.ink }
  }
  return { background: mix(LCARS.ink, color, 0.22), foreground: color }
}

/** Chevrons that march toward the title while a klaxon sounds. */
export function chevrons(ms: number, side: 'left' | 'right'): string {
  const step = Math.floor(ms / 140) % 3
  return [0, 1, 2]
    .map(i => (side === 'left' ? (i === step ? '▶' : '▷') : i === 2 - step ? '◀' : '◁'))
    .join('')
}
