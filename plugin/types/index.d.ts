/** How an alert animates in Claude Code; set per level in the daemon config. */
export type AlertStyle = 'sweep' | 'pulse' | 'klaxon'

/** One alert level, as the daemon's GET /levels describes it. */
export type AlertLevel = {
  name: string
  priority: number
  description: string
  color: string
  style: AlertStyle
  soundReady: boolean
}

/** One alert, as the daemon's history records it. */
export type AlertRecord = {
  id: string
  level: string
  color: string
  style: AlertStyle
  title: string
  message: string
  source: string
  status: string
  /** Seconds since the epoch, the daemon's clock. */
  time: number
}

/** What the last health check of the daemon found. */
export type DaemonLink = {
  online: boolean
  url: string
  /** Milliseconds since the epoch of the last check; 0 before the first. */
  checkedAt: number
  error: string | null
  version: string | null
  hostname: string | null
  player: string | null
  uptimeS: number | null
  /** Muted: `until` in epoch seconds, or null for "until unmuted". */
  mute: { until: number | null } | null
  playing: { id: string; level: string } | null
  levelsHash: string | null
}

/** The alert the band is showing: animating, then latched until acknowledged. */
export type ActiveAlert = {
  id: string
  level: string
  color: string
  style: AlertStyle
  title: string
  message: string
  source: string
  /** Raised by this session's Claude, not by another session or the CLI. */
  isOwn: boolean
  /** Milliseconds since the epoch. */
  startedAt: number
  animateUntil: number
  /** Keeps the band lit after the animation until the person acknowledges it. */
  isLatched: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'red-alert': {
      link: DaemonLink | null
      levels: AlertLevel[]
      history: AlertRecord[]
      active: ActiveAlert | null
    }
  }
}
