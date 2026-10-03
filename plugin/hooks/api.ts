// The daemon's HTTP API (docs/API.md): shapes, request building and reply
// parsing. The fetch itself is `$.http.fetch` in register.tsx.

import type { AlertStyle } from '../types'

/** An alert as the daemon reports it. */
export type DaemonAlert = {
  id: string
  level: string
  priority: number
  color: string
  style: AlertStyle
  title: string
  message: string
  source: string
  time: number
  duration: number
  status: string
  detail: string | null
}

export type Health = {
  ok: true
  version: string
  hostname: string
  time: number
  uptime_s: number
  player: string
  levels: string[]
  levels_hash: string
  playing: { id: string; level: string } | null
  mute: { until: number | null } | null
  last_alert: DaemonAlert | null
}

export type DaemonLevel = {
  name: string
  priority: number
  description: string
  color: string
  style: AlertStyle
  duration: number
  sound_ready: boolean
}

/** The daemon could not be reached at all. */
export class Offline extends Error {}

/** The daemon answered with an error. */
export class Refused extends Error {
  readonly levels: readonly string[]

  constructor(message: string, levels: readonly string[] = []) {
    super(message)
    this.levels = levels
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function endpoint(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path
}

export function requestInit(method: 'GET' | 'POST', body: object | undefined, token: string) {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
}

export function parseReply<T>(response: { ok: boolean; status: number; text: string }, base: string): T {
  let payload: { error?: string; levels?: string[] }
  try {
    payload = JSON.parse(response.text)
  } catch {
    throw new Refused(`HTTP ${response.status} from ${base}: not the red-alert daemon?`)
  }
  if (!response.ok) {
    throw new Refused(payload.error ?? `HTTP ${response.status}`, payload.levels ?? [])
  }
  return payload as T
}
