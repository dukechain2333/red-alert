/** How an alert animates in Claude Code; set per level in the daemon config. */
export type AlertStyle = 'sweep' | 'pulse' | 'klaxon'

/** One alert level, as the daemon's GET /levels describes it. */
export type AlertLevel = {
  name: string
  priority: number
  description: string
  color: string
  style: AlertStyle
  /** How long it sounds, in seconds: cut or looped to fit; 0 plays the sound once. */
  duration: number
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
  /** Seconds it sounds for; 0 plays the sound once. */
  duration: number
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

/** Who raised an alert: this session's Claude, the person by hand, or anyone else. */
export type AlertOrigin = 'claude' | 'manual' | 'remote'

/** The alert the band is showing: animating while it sounds, then latched until silenced. */
export type ActiveAlert = {
  id: string
  level: string
  color: string
  style: AlertStyle
  title: string
  message: string
  source: string
  origin: AlertOrigin
  /** Seconds the sound runs for; 0 when it plays once (its length unknown). */
  duration: number
  /** Milliseconds since the epoch. */
  startedAt: number
  /** The animation runs at least until then, and on while the sound plays. */
  animateUntil: number
  /** Keeps the band lit after the animation until the person silences it. */
  isLatched: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'red-alert': {
      link: DaemonLink | null
      levels: AlertLevel[]
      history: AlertRecord[]
      active: ActiveAlert | null
      /** The message typed into the console's manual-alert field. */
      draft: string
    }
  }
}
