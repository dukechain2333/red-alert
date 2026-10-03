// red-alert: the Claude Code side of the alert system.
//
// - registers the `alert` tool the model calls on its own judgment, its
//   levels and their descriptions read from the daemon (GET /levels);
// - adds a short section to the system prompt saying when to use it;
// - draws an LCARS strip above the prompt that shows whether the daemon is
//   online, and animates every alert (klaxon, pulse or sweep) there for as
//   long as it sounds; `0` at an empty prompt silences it;
// - opens an alert console pane with /alert, where the person sounds alerts
//   by hand, and answers /alert subcommands (`/alert red 30s message`).

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { ActiveAlert, AlertLevel, AlertOrigin, AlertRecord, DaemonLink } from '../types'
import { Offline, Refused, endpoint, errorText, parseReply, requestInit } from './api'
import type { DaemonAlert, DaemonLevel, Health } from './api'
import { DURATION_MS, FPS, LCARS, bannerColors, barCells, barRuns, chevrons } from './frames'

const TOOL_NAME = 'alert'
const TOOL = 'mcp__red-alert__alert'
const PANE = 'alert-console'
const HISTORY_SIZE = 20
const MAX_DURATION_S = 300
/** Silences an alert: a bare digit typed into an empty prompt presses the band's Button for it. */
const SILENCE_KEY = '0'
const START_COMMAND = ['systemctl', '--user', 'start', 'red-alert']
const SUBCOMMANDS = '[<level> [30s] [message] | status | stop | mute [minutes] | unmute | start]'
/** Alert statuses worth a banner: the alert reached the speaker, or would have. */
const SHOWN = new Set(['playing', 'played', 'muted', 'stopped', 'preempted'])

const link = atom({ plugin: 'red-alert', key: 'link' } as const, null)
const levels = atom({ plugin: 'red-alert', key: 'levels' } as const, [])
const history = atom({ plugin: 'red-alert', key: 'history' } as const, [])
const active = atom({ plugin: 'red-alert', key: 'active' } as const, null)
const draft = atom({ plugin: 'red-alert', key: 'draft' } as const, '')

/** The tool's levels until the daemon has answered once. */
const FALLBACK_LEVELS: AlertLevel[] = [
  {
    name: 'normal', priority: 10, style: 'sweep', color: '#99CCFF', duration: 0, soundReady: false,
    description: 'A light ping: a small milestone or FYI, such as a long build or test run that finished.',
  },
  {
    name: 'yellow', priority: 50, style: 'pulse', color: '#FFCC33', duration: 0, soundReady: false,
    description: 'A significant body of work is complete and ready for review.',
  },
  {
    name: 'red', priority: 90, style: 'klaxon', color: '#FF3333', duration: 12, soundReady: false,
    description: 'The user is needed now: you are blocked, need a decision, credentials or approval, or something failed badly.',
  },
]

const POLICY = `# Audible alerts
The user runs red-alert: the \`${TOOL}\` tool plays a sound through this machine's speakers and flashes a banner in Claude Code, so the user can step away while you work. Decide on your own when to use it and at which level, following the levels in the tool's description: usually once, as your last action before you end a turn that did substantial work, or right before you stop to wait for the user. Skip it for quick back-and-forth while the user is clearly at the keyboard.`

type Table = Elements[keyof Elements]

type Settings = {
  url: string
  token: string
  pollMs: number
  permissionPromptLevel: string
  isIdleBandShown: boolean
}

// The module's own variables: they start over when the module reloads, while
// everything drawn from lives in $.state.
let settings: Settings = settingsFrom({})
let source = 'claude-code'
let toolHash = ''
let isPolling = false
let isSeeded = false
let pollTimer: Timer | undefined
let frameTimer: Timer | undefined
/** Once an animation's planned time is over: when the daemon was last asked, and its answer. */
let soundCheckedAt = 0
let isStillSounding = true
const ownIds = new Set<string>()

function settingsFrom(options: PluginOptions): Settings {
  const text = (key: string, fallback: string) => {
    const value = options[key]
    return typeof value === 'string' && value.trim() ? value.trim() : fallback
  }
  const seconds = Number(options.pollSeconds)
  return {
    url: text('url', 'http://127.0.0.1:1701'),
    token: text('token', ''),
    pollMs: Math.round((Number.isFinite(seconds) && seconds >= 1 ? seconds : 5) * 1000),
    permissionPromptLevel: text('permissionPromptLevel', 'off').toLowerCase(),
    isIdleBandShown: options.idleBand !== false,
  }
}

// ---------------------------------------------------------------------------
// Conversions and text
// ---------------------------------------------------------------------------

function toLevel(level: DaemonLevel): AlertLevel {
  return {
    name: level.name,
    priority: level.priority,
    description: level.description,
    color: level.color,
    style: level.style,
    duration: level.duration ?? 0,
    soundReady: level.sound_ready,
  }
}

function toRecord(alert: DaemonAlert): AlertRecord {
  return {
    id: alert.id,
    level: alert.level,
    color: alert.color,
    style: alert.style,
    title: alert.title,
    message: alert.message,
    source: alert.source,
    status: alert.status,
    time: alert.time,
    duration: alert.duration ?? 0,
  }
}

function emptyLink(url: string): DaemonLink {
  return {
    online: false,
    url,
    checkedAt: 0,
    error: null,
    version: null,
    hostname: null,
    player: null,
    uptimeS: null,
    mute: null,
    playing: null,
    levelsHash: null,
  }
}

function toolDescription(list: readonly AlertLevel[]): string {
  return [
    "Sound an audible alert on the user's machine: its speakers play the level's sound and Claude Code flashes an alert banner, so the user notices even when away from the screen. You decide when to call it and which level fits.",
    '',
    'Levels, lowest to highest priority:',
    ...list.map(level => `- ${level.name}: ${level.description}`),
    '',
    'How to use it:',
    '- Call it at most once per turn, as the last thing you do before ending your turn, or right before you ask a question that blocks you. Pick the highest level that fits.',
    '- Do not alert for quick conversational replies while the user is clearly at the keyboard, and never for each small step of a task.',
    '- If the user asks for fewer or no alerts, follow that for the rest of the session.',
    '- The result says whether the sound played. If the system is offline or muted, carry on; do not retry.',
  ].join('\n')
}

function ago(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s >= 86400) return `${Math.floor(s / 86400)}D`
  if (s >= 3600) return `${Math.floor(s / 3600)}H`
  if (s >= 60) return `${Math.floor(s / 60)}M`
  return `${s}S`
}

function clockText(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

function lengthText(duration: number): string {
  return duration > 0 ? `${Number(duration.toFixed(1))}s` : 'once'
}

function muteLabel(muted: DaemonLink['mute'], nowMs: number): string {
  if (!muted) return ''
  return muted.until === null ? 'MUTED' : `MUTED ${ago(muted.until - nowMs / 1000)}`
}

/** `30s`, `2m`, `1.5m` as seconds; undefined for anything else. */
function parseDuration(word: string | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(s|m)$/i.exec(word ?? '')
  if (!match) return undefined
  const seconds = Number(match[1]) * (match[2]?.toLowerCase() === 'm' ? 60 : 1)
  return Math.min(MAX_DURATION_S, seconds)
}

function outcome(alert: DaemonAlert, host: string): string {
  const name = alert.level.toUpperCase()
  switch (alert.status) {
    case 'playing':
    case 'played':
      return `Sounded: ${name} alert is playing on ${host}. The user has been alerted; finish your turn (or ask your question) now.`
    case 'muted':
      return `Muted: the user has muted alerts, so the ${name} banner was shown without sound. Carry on.`
    case 'cooldown':
      return `Skipped: a ${name} alert sounded moments ago (cooldown). Do not retry.`
    case 'suppressed':
      return `Skipped: ${alert.detail ?? 'a higher-priority alert is playing'}. Do not retry.`
    default:
      return `Failed: the daemon could not play the sound (${alert.detail ?? alert.status}). Mention this to the user.`
  }
}

function manualOutcome(alert: DaemonAlert): string {
  const what = `${alert.level.toUpperCase()} alert`
  switch (alert.status) {
    case 'playing':
    case 'played':
      return `${what} sounding (${lengthText(alert.duration ?? 0)}). Press ${SILENCE_KEY} at an empty prompt to silence it.`
    case 'muted':
      return `${what} shown, but alerts are muted (/alert unmute).`
    case 'cooldown':
      return `${what} skipped: it sounded moments ago (cooldown).`
    case 'suppressed':
      return `${what} skipped: ${alert.detail ?? 'a higher-priority alert is playing'}.`
    default:
      return `${what} failed: ${alert.detail ?? alert.status}.`
  }
}

function statusText(
  current: DaemonLink | null,
  list: readonly AlertLevel[],
  log: readonly AlertRecord[],
  now: number,
): string {
  if (!current?.online) {
    return `red-alert ○ offline at ${current?.url ?? settings.url}${current?.error ? ` (${current.error})` : ''}. Start it with /alert start.`
  }
  const last = log[0]
  return [
    `red-alert ● online at ${current.url} (v${current.version} on ${current.hostname}, player ${current.player})`,
    `levels: ${list.map(level => `${level.name} (p${level.priority}, ${lengthText(level.duration)})`).join(', ')}`,
    `muted: ${current.mute ? muteLabel(current.mute, now).toLowerCase() : 'no'}`,
    last
      ? `last: ${last.level} "${last.message || '-'}" ${last.status}, ${ago(now / 1000 - last.time).toLowerCase()} ago`
      : 'last: none',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// The daemon
// ---------------------------------------------------------------------------

async function call<T>($: EngineInterface, method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
  let response: Awaited<ReturnType<EngineInterface['http']['fetch']>>
  try {
    response = await $.http.fetch(endpoint(settings.url, path), requestInit(method, body, settings.token))
  } catch (error) {
    throw new Offline(errorText(error))
  }
  return parseReply<T>(response, settings.url)
}

async function registerTool($: EngineInterface, list: readonly AlertLevel[]): Promise<void> {
  const ordered = [...(list.length > 0 ? list : FALLBACK_LEVELS)].sort((a, b) => a.priority - b.priority)
  await $.tool.register({
    name: TOOL_NAME,
    description: toolDescription(ordered),
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ordered.map(level => level.name),
          description: 'Which alert to sound; see the levels above.',
        },
        message: {
          type: 'string',
          maxLength: 200,
          description:
            'One short line, in the language you are using with the user, saying what happened or what you need from them.',
        },
      },
      required: ['level', 'message'],
      additionalProperties: false,
    },
  })
}

async function markOffline($: EngineInterface, checkedAt: number, reason: string): Promise<void> {
  await update($, link, previous => ({
    ...(previous ?? emptyLink(settings.url)),
    online: false,
    url: settings.url,
    checkedAt,
    error: reason,
    playing: null,
  }))
  $.ui.status('○ alert system offline · /alert start')
}

/** Checks the daemon, refreshes levels and history, and shows alerts raised elsewhere. */
async function poll($: EngineInterface): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    const checkedAt = await $.clock.now()
    let health: Health
    try {
      health = await call<Health>($, 'GET', '/health')
    } catch (error) {
      await markOffline($, checkedAt, errorText(error))
      return
    }
    await update($, link, () => ({
      online: true,
      url: settings.url,
      checkedAt,
      error: null,
      version: health.version,
      hostname: health.hostname,
      player: health.player,
      uptimeS: health.uptime_s,
      mute: health.mute,
      playing: health.playing,
      levelsHash: health.levels_hash,
    }))
    $.ui.status(health.mute ? `◐ alerts ${muteLabel(health.mute, checkedAt).toLowerCase()}` : undefined)

    if (health.levels_hash !== toolHash) {
      const list = (await call<{ levels: DaemonLevel[] }>($, 'GET', '/levels')).levels.map(toLevel)
      await update($, levels, () => list)
      await registerTool($, list)
      toolHash = health.levels_hash
    }

    const known = new Set((await read($, history)).map(alert => alert.id))
    let alerts: DaemonAlert[]
    try {
      alerts = (await call<{ alerts: DaemonAlert[] }>($, 'GET', `/history?limit=${HISTORY_SIZE}`)).alerts
    } catch {
      alerts = health.last_alert ? [health.last_alert] : []
    }
    if (alerts.length > 0) {
      await update($, history, () => alerts.map(toRecord))
    }

    // Silenced from elsewhere (another session, the CLI): take the banner down too.
    const shown = await read($, active)
    if (shown && alerts.some(alert => alert.id === shown.id && alert.status === 'stopped')) {
      await clearBanner($, shown.id)
    }

    const fresh = isSeeded
      ? alerts.find(alert => !known.has(alert.id) && !ownIds.has(alert.id) && SHOWN.has(alert.status))
      : undefined
    isSeeded = true
    if (fresh) {
      const from = fresh.source ? ` from ${fresh.source}` : ''
      $.ui.toast(`${fresh.title}${from}: ${fresh.message || fresh.level}`, { timeoutMs: 6000 })
      await showAlert($, fresh, 'remote')
    }
  } catch (error) {
    $.ui.log(`red-alert: health check failed: ${errorText(error)}`, { to: 'debug' })
  } finally {
    isPolling = false
  }
}

async function refresh($: EngineInterface): Promise<void> {
  await poll($)
}

// ---------------------------------------------------------------------------
// Alerts and their animation
// ---------------------------------------------------------------------------

async function raise(
  $: EngineInterface,
  alert: { level: string; message: string; from: string; origin: AlertOrigin; duration?: number },
): Promise<DaemonAlert> {
  const body = {
    level: alert.level,
    message: alert.message,
    source: alert.from,
    ...(alert.duration === undefined ? {} : { duration: alert.duration }),
  }
  const { alert: raised } = await call<{ alert: DaemonAlert }>($, 'POST', '/alert', body)
  ownIds.add(raised.id)
  await update($, history, list => [toRecord(raised), ...list.filter(one => one.id !== raised.id)].slice(0, HISTORY_SIZE))
  if (SHOWN.has(raised.status)) {
    await showAlert($, raised, alert.origin)
  }
  return raised
}

/** Sounds a level by hand: from /alert, or a console button. */
async function soundByHand($: EngineInterface, level: string, message: string, duration?: number): Promise<DaemonAlert> {
  return raise($, {
    level,
    message: message || `Manual ${level} alert`,
    from: `${source} (manual)`,
    origin: 'manual',
    duration,
  })
}

/** A console Sound button: sounds `level` with the message typed into the console. */
async function soundDraft($: EngineInterface, level: string): Promise<void> {
  const message = (await read($, draft)).trim()
  try {
    const alert = await soundByHand($, level, message)
    await update($, draft, () => '')
    if (!SHOWN.has(alert.status)) $.ui.toast(manualOutcome(alert))
  } catch (error) {
    $.ui.toast(error instanceof Offline ? 'The alert system is offline.' : `red-alert: ${errorText(error)}`)
  }
}

async function showAlert($: EngineInterface, alert: DaemonAlert, origin: AlertOrigin): Promise<void> {
  const now = await $.clock.now()
  const isPlaying = alert.status === 'playing'
  const duration = isPlaying ? (alert.duration ?? 0) : 0
  const shown: ActiveAlert = {
    id: alert.id,
    level: alert.level,
    color: alert.color,
    style: alert.style,
    title: alert.title,
    message: alert.message,
    source: alert.source,
    origin,
    duration,
    startedAt: now,
    animateUntil: now + (duration > 0 ? Math.max(2000, duration * 1000) : DURATION_MS[alert.style]),
    isLatched: origin !== 'remote' && alert.style !== 'sweep',
  }
  soundCheckedAt = 0
  isStillSounding = isPlaying
  await update($, active, () => shown)
  animate($)
}

function animate($: EngineInterface): void {
  frameTimer?.cancel()
  frameTimer = $.clock.every(Math.round(1000 / FPS), () => void nextFrame($))
}

/**
 * Whether the daemon still plays `id`, asked at most once a second: a sound
 * played once runs as long as its file, which the mod does not know.
 */
async function isSounding($: EngineInterface, id: string, now: number): Promise<boolean> {
  if (now - soundCheckedAt >= 1000) {
    soundCheckedAt = now
    try {
      isStillSounding = (await call<Health>($, 'GET', '/health')).playing?.id === id
    } catch {
      isStillSounding = false
    }
  }
  return isStillSounding
}

/** One animation frame: redraw, or settle the band once the animation and the sound are over. */
async function nextFrame($: EngineInterface): Promise<void> {
  const [now, current] = await Promise.all([$.clock.now(), read($, active)])
  if (current && (now < current.animateUntil || (await isSounding($, current.id, now)))) {
    $.ui.invalidate('ui.render')
    return
  }
  frameTimer?.cancel()
  frameTimer = undefined
  if (current && !current.isLatched) {
    await update($, active, shown => (shown?.id === current.id ? null : shown))
  }
  $.ui.invalidate('ui.render')
}

async function clearBanner($: EngineInterface, id: string): Promise<void> {
  frameTimer?.cancel()
  frameTimer = undefined
  await update($, active, shown => (shown?.id === id ? null : shown))
}

/**
 * Takes the banner down and stops its sound; with `isEverything`, stops
 * whatever the daemon is playing, banner or not.
 */
async function silence($: EngineInterface, isEverything = false): Promise<string | null> {
  const current = await read($, active)
  if (current) {
    await clearBanner($, current.id)
  }
  const body = current && !isEverything ? { id: current.id } : {}
  return (await call<{ stopped: string | null }>($, 'POST', '/stop', body)).stopped
}

async function silenceQuietly($: EngineInterface, isEverything = false): Promise<void> {
  await silence($, isEverything).catch(() => null)
}

async function mute($: EngineInterface, minutes: number): Promise<void> {
  await call($, 'POST', '/mute', { minutes })
  await poll($)
}

async function unmute($: EngineInterface): Promise<void> {
  await call($, 'POST', '/unmute', {})
  await poll($)
}

async function startDaemon($: EngineInterface): Promise<string> {
  try {
    const run = await $.process.run(START_COMMAND, { timeoutMs: 15000 })
    if (run.exitCode !== 0) {
      return `Could not start it: ${run.stderr.trim() || `exit ${run.exitCode}`}`
    }
  } catch (error) {
    return `Could not start it: ${errorText(error)}`
  }
  await $.clock.sleep(800)
  await poll($)
  return (await read($, link))?.online
    ? 'Alert system online.'
    : 'Started, but it is not answering yet: see `journalctl --user -u red-alert`.'
}

async function startAndToast($: EngineInterface): Promise<void> {
  $.ui.toast(await startDaemon($))
}

/** A level item on the band: sounds that alert by hand, for the level's own duration. */
async function soundFromBand($: EngineInterface, level: string): Promise<void> {
  try {
    const alert = await soundByHand($, level, '')
    if (!SHOWN.has(alert.status)) $.ui.toast(manualOutcome(alert))
  } catch (error) {
    $.ui.toast(error instanceof Offline ? 'The alert system is offline.' : `red-alert: ${errorText(error)}`)
  }
}

async function openConsole($: EngineInterface, isFocused: boolean): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'Alert console', ...(isFocused ? { focus: true } : {}) })
  return opened.isPlaced
}

/** After the message field's Enter: the ring moves to the levels, where a digit sounds one. */
async function focusFirstSound($: EngineInterface): Promise<void> {
  const [first] = [...(await read($, levels))].sort((a, b) => a.priority - b.priority)
  if (first) {
    await $.ui.focus({ requestId: PANE, key: `sound:${first.name}` }).catch(() => null)
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function pill(t: Table, label: string, color: string) {
  const { Text } = t
  return [
    <Text color={color}>▐</Text>,
    <Text backgroundColor={color} color={LCARS.ink} bold>{` ${label} `}</Text>,
    <Text color={color}>▌</Text>,
  ]
}

function rule(t: Table, width: number, color: string) {
  const { Text } = t
  return <Text color={color}>{'━'.repeat(Math.max(1, width))}</Text>
}

function statusPill(current: DaemonLink | null, now: number): { label: string; color: string } {
  if (!current || current.checkedAt === 0) return { label: '◌ LINKING', color: LCARS.tan }
  if (!current.online) return { label: '○ OFFLINE', color: LCARS.red }
  if (current.mute) return { label: `◐ ${muteLabel(current.mute, now)}`, color: LCARS.peach }
  return { label: '● ONLINE', color: LCARS.green }
}

/**
 * The strip shown while no alert is up: the daemon's state, then the levels
 * as Buttons the person reaches with the band's focus (ctrl+x tab), walks
 * with ←/→ and presses with Enter to sound that alert by hand. No digit
 * hotkeys: a bare digit at an empty prompt would press them while the
 * person starts a message.
 */
function idleStrip(
  $: EngineInterface,
  t: Table,
  width: number,
  current: DaemonLink | null,
  list: readonly AlertLevel[],
  log: readonly AlertRecord[],
  now: number,
) {
  const { Box, Text, Button } = t
  const status = statusPill(current, now)

  // the status and the levels first; then the brand, the rule and the last alert where room is left
  const levelsWidth = list.reduce((n, level) => n + level.name.length + 2, 0) + 2 * Math.max(0, list.length - 1)
  const fixed = 1 + 1 + status.label.length + 4 + (list.length > 0 ? 2 + levelsWidth : 0)
  const brand = width - fixed - 18 >= 4 ? '◉ ALERT SYSTEM' : '◉'
  let used = brand.length + 4 + fixed
  const last = log[0]
  const lastText = last ? `LAST ${last.level.toUpperCase()} ${ago(now / 1000 - last.time)} AGO` : ''
  const isLastShown = lastText !== '' && width - used - 4 >= lastText.length + 2
  if (isLastShown) used += lastText.length + 2

  return (
    <Box flexDirection="row">
      {pill(t, brand, LCARS.orange)}
      <Text> </Text>
      {rule(t, width - used, LCARS.lavender)}
      <Text> </Text>
      {pill(t, status.label, status.color)}
      {list.length > 0 && <Text>  </Text>}
      {list.map((level, i) => [
        i > 0 ? <Text>  </Text> : null,
        <Text color={level.color} bold>● </Text>,
        <Button
          key={`band:level:${level.name}`}
          label={level.name.toUpperCase()}
          plain
          {...(i === 0 ? { autoFocus: true } : {})}
          onPress={() => void soundFromBand($, level.name)}
        />,
      ])}
      {isLastShown && <Text color={LCARS.tan}>{`  ${lastText}`}</Text>}
    </Box>
  )
}

/** The alert banner, with animated light bars above and below while it sounds. */
function alertBanner($: EngineInterface, t: Table, width: number, maxRows: number, shown: ActiveAlert, now: number) {
  const { Box, Text, Button } = t
  const ms = now - shown.startedAt
  const isAnimating = frameTimer !== undefined || now < shown.animateUntil
  const colors = bannerColors(shown.style, shown.color, ms, !isAnimating)
  const Raster = 'Raster' in t ? t.Raster : undefined

  const wanted = shown.style === 'klaxon' ? 2 : 1
  const spare = Math.max(0, maxRows - 1)
  const top = isAnimating ? Math.min(wanted, shown.style === 'sweep' ? spare : Math.floor(spare / 2)) : 0
  const bottom = isAnimating && shown.style !== 'sweep' ? Math.min(wanted, spare - top) : 0

  const bars = (rows: number, edge: 'top' | 'bottom') => {
    if (rows <= 0) return null
    if (Raster) {
      return (
        <Raster
          key={`bars:${edge}`}
          columns={width}
          rows={rows}
          cells={barCells(shown.style, shown.color, width, rows, ms, edge)}
        />
      )
    }
    const runs = barRuns(shown.style, shown.color, Math.max(8, Math.floor(width / 4)), ms)
    const run = Math.floor(width / runs.length)
    return (
      <Box flexDirection="row">
        {runs.map((color, i) => (
          <Text color={color}>{'█'.repeat(i === runs.length - 1 ? width - run * (runs.length - 1) : run)}</Text>
        ))}
      </Box>
    )
  }

  const title =
    shown.style === 'klaxon' && isAnimating
      ? ` ${chevrons(ms, 'left')}  ${shown.title}  ${chevrons(ms, 'right')} `
      : shown.style === 'sweep'
        ? ` ◉ INCOMING · ${shown.title} `
        : ` ◆ ${shown.title} ◆ `
  const from =
    shown.origin === 'remote' ? `  · ${shown.source || 'elsewhere'}` : shown.origin === 'manual' ? '  · manual' : ''
  const secondsLeft = shown.duration > 0 ? Math.ceil((shown.startedAt + shown.duration * 1000 - now) / 1000) : 0

  return (
    <Box flexDirection="column">
      {bars(top, 'top')}
      <Box flexDirection="row" width={width} backgroundColor={colors.background}>
        <Text backgroundColor={colors.background} color={colors.foreground} bold>{title}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text backgroundColor={colors.background} color={colors.foreground} wrap="truncate">
            {` ${shown.message}${from} `}
          </Text>
        </Box>
        {secondsLeft > 0 && (
          <Text backgroundColor={colors.background} color={colors.foreground}>{` ${secondsLeft}s `}</Text>
        )}
        <Button
          key="band:silence"
          label={isAnimating ? 'Silence' : 'Dismiss'}
          hotkey={SILENCE_KEY}
          plain
          onPress={() => void silenceQuietly($)}
        />
        <Text backgroundColor={colors.background}> </Text>
      </Box>
      {bars(bottom, 'bottom')}
    </Box>
  )
}

function consoleHeader(t: Table, width: number) {
  const { Box, Text } = t
  return (
    <Box flexDirection="row">
      {pill(t, 'LCARS 1701', LCARS.orange)}
      <Text> </Text>
      {rule(t, width - 34, LCARS.lavender)}
      <Text> </Text>
      {pill(t, 'ALERT CONDITION', LCARS.violet)}
    </Box>
  )
}

function section(t: Table, width: number, label: string, color: string) {
  const { Box, Text } = t
  return (
    <Box flexDirection="row" marginTop={1}>
      {pill(t, label, color)}
      <Text> </Text>
      {rule(t, width - label.length - 5, color)}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  settings = settingsFrom(options)

  on('session.start', async ($, e, next) => {
    source = `claude-code:${e.cwd.split('/').filter(Boolean).pop() ?? 'session'}`
    await $.command.register({
      name: 'alert',
      description: 'Alert console; sound an alert by hand, silence, mute, status',
      argumentHint: SUBCOMMANDS,
      immediate: true,
    })
    await registerTool($, await read($, levels))
    await Promise.race([poll($), $.clock.sleep(1500)])
    pollTimer?.cancel()
    pollTimer = $.clock.every(settings.pollMs, () => void refresh($))
    if (await read($, active)) {
      animate($)
    }
    return next(e)
  })

  on('session.end', ($, e, next) => {
    pollTimer?.cancel()
    frameTimer?.cancel()
    return next(e)
  })

  // The person is back at the keyboard: Claude's alert has done its job.
  on('prompt.submit', async ($, e, next) => {
    const current = await read($, active)
    if (current?.origin === 'claude') {
      await Promise.race([silenceQuietly($), $.clock.sleep(400)])
    }
    return next(e)
  })

  // -- the tool --------------------------------------------------------------

  on('tool.describe', { tool: TOOL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  // Playing a sound on the user's own machine needs no permission prompt.
  on('tool.check', { tool: TOOL }, () => ({
    decision: 'allow',
    reason: 'red-alert: sounding an alert on this machine is always allowed',
  }))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const level = typeof e.level === 'string' ? e.level : ''
    const message = typeof e.message === 'string' ? e.message : ''
    try {
      const alert = await raise($, { level, message, from: source, origin: 'claude' })
      const host = (await read($, link))?.hostname ?? 'this machine'
      return { result: outcome(alert, host) }
    } catch (error) {
      if (error instanceof Offline) {
        void refresh($)
        return {
          result: `Offline: the alert system at ${settings.url} is not answering, so no sound played. Carry on without it and do not retry.`,
        }
      }
      if (error instanceof Refused) {
        const valid = error.levels.length > 0 ? ` Valid levels: ${error.levels.join(', ')}.` : ''
        return { result: `Refused: ${error.message}.${valid}` }
      }
      throw error
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL)) return composed
    return { sections: [...composed.sections, { id: 'red-alert:policy', text: POLICY, scope: 'session' }] }
  })

  // Optional: a permission prompt is the one wait the model cannot announce.
  on('classic.Notification', async ($, e, next) => {
    const level = settings.permissionPromptLevel
    if (level !== 'off' && e.notification_type === 'permission_prompt') {
      await raise($, { level, message: e.message, from: `${source} (permission prompt)`, origin: 'claude' }).catch(
        () => null,
      )
    }
    return next(e)
  })

  // -- /alert ----------------------------------------------------------------

  on('command.run', { command: 'alert' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const verb = (words[0] ?? '').toLowerCase()
    try {
      switch (verb) {
        case '':
        case 'console':
          return {
            text: (await openConsole($, false)) ? 'Alert console opened.' : 'Alert console: widen the terminal to see it.',
          }
        case 'status': {
          await poll($)
          const [current, list, log, now] = await Promise.all([
            read($, link),
            read($, levels),
            read($, history),
            $.clock.now(),
          ])
          return { text: statusText(current, list, log, now) }
        }
        case 'stop':
        case 'silence': {
          const stopped = await silence($, true)
          return { text: stopped ? 'Alert silenced.' : 'Nothing was playing.' }
        }
        case 'mute': {
          const minutes = words[1] === undefined ? 30 : Number(words[1])
          if (!Number.isFinite(minutes) || minutes < 0) {
            return { text: 'Usage: /alert mute [minutes]  (0 = until /alert unmute)' }
          }
          await mute($, minutes)
          return { text: minutes === 0 ? 'Alerts muted until /alert unmute.' : `Alerts muted for ${minutes} min.` }
        }
        case 'unmute': {
          await unmute($)
          return { text: 'Alerts unmuted.' }
        }
        case 'start':
          return { text: await startDaemon($) }
        default: {
          // `/alert <level> [30s] [message]`; also `/alert sound <level> ...` and `/alert test [level]`
          const rest = verb === 'sound' || verb === 'test' ? words.slice(1) : words
          const list = await read($, levels)
          const level = (rest[0] ?? (verb === 'test' ? list[list.length - 1]?.name : undefined))?.toLowerCase()
          if (!level || (list.length > 0 && !list.some(one => one.name === level))) {
            const names = list.map(one => one.name).join(', ')
            return { text: `Usage: /alert ${SUBCOMMANDS}${names ? `\nlevels: ${names}` : ''}` }
          }
          const duration = parseDuration(rest[1])
          const message = rest.slice(duration === undefined ? 1 : 2).join(' ')
          return { text: manualOutcome(await soundByHand($, level, message, duration)) }
        }
      }
    } catch (error) {
      if (error instanceof Offline) {
        return { text: `The alert system at ${settings.url} is offline. Start it with /alert start.` }
      }
      if (error instanceof Refused) {
        const valid = error.levels.length > 0 ? ` (levels: ${error.levels.join(', ')})` : ''
        return { text: `red-alert: ${error.message}${valid}` }
      }
      throw error
    }
  })

  // -- drawing ---------------------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [current, shown, list, log, now] = await Promise.all([
      read($, link),
      read($, active),
      read($, levels),
      read($, history),
      $.clock.now(),
    ])
    const t = $.ui.resolve(e)
    // the engine draws its own collapse mark, ` [-]`, at the band's right edge
    const width = Math.max(20, e.props.bodyColumns - 4)
    if (shown) {
      return alertBanner($, t, width, Math.max(1, e.props.maxRows - 1), shown, now)
    }
    if (!settings.isIdleBandShown) return next(e)
    return idleStrip($, t, width, current, list, log, now)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [current, shown, list, log, message, now] = await Promise.all([
      read($, link),
      read($, active),
      read($, levels),
      read($, history),
      read($, draft),
      $.clock.now(),
    ])
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const Input = 'Input' in t ? t.Input : undefined
    const width = Math.max(30, e.props.bodyColumns)
    const rows = e.viewport?.rows ?? 30
    const ordered = [...list].sort((a, b) => a.priority - b.priority)

    const condition = shown
      ? { label: `${shown.level.toUpperCase()} ALERT`, color: shown.color }
      : current?.online
        ? { label: 'GREEN · STANDING BY', color: LCARS.green }
        : { label: 'NO CONTACT', color: LCARS.red }
    const system = current?.online
      ? `● ONLINE  ${current.url} · v${current.version} · ${current.hostname} · up ${ago(current.uptimeS ?? 0).toLowerCase()} · ${current.player}`
      : `○ OFFLINE  ${current?.url ?? settings.url}${current?.error ? ` · ${current.error}` : ''}`
    const logRoom = Math.max(1, rows - ordered.length - 15)

    return (
      <Box flexDirection="column">
        {shown ? alertBanner($, t, width, 5, shown, now) : consoleHeader(t, width)}
        <Box flexDirection="row" marginTop={1}>
          <Text color={LCARS.sand} bold>{'SYSTEM     '}</Text>
          <Text color={current?.online ? LCARS.green : LCARS.red} wrap="truncate">{system}</Text>
        </Box>
        <Box flexDirection="row">
          <Text color={LCARS.sand} bold>{'CONDITION  '}</Text>
          <Text color={condition.color} bold>{condition.label}</Text>
          {current?.mute && <Text color={LCARS.peach}>{`  · ${muteLabel(current.mute, now)}`}</Text>}
        </Box>

        {section(t, width, 'MANUAL ALERT', LCARS.violet)}
        {Input && (
          <Input
            key="manual:message"
            label="Message "
            placeholder="optional; Enter, then a level's number"
            value={message}
            submitLabel="pick a level"
            onInput={value => void update($, draft, () => value)}
            onSubmit={value => void update($, draft, () => value).then(() => focusFirstSound($))}
          />
        )}
        {ordered.length === 0 && <Text dimColor>No levels yet: the daemon has not answered.</Text>}
        {ordered.map((level, i) => (
          <Box flexDirection="row">
            <Button
              key={`sound:${level.name}`}
              label="Sound"
              {...(i < 9 ? { hotkey: String(i + 1) } : {})}
              plain
              dimColor
              onPress={() => void soundDraft($, level.name)}
            />
            <Text> </Text>
            {pill(t, level.name.toUpperCase().padEnd(8), level.color)}
            <Text color={LCARS.tan}>
              {` p${String(level.priority).padEnd(4)}${level.style.padEnd(7)}${lengthText(level.duration).padEnd(6)}`}
            </Text>
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate">
                {level.soundReady ? level.description : `(sound not cached yet) ${level.description}`}
              </Text>
            </Box>
          </Box>
        ))}

        {section(t, width, 'LOG', LCARS.peach)}
        {log.length === 0 && <Text dimColor>No alerts yet.</Text>}
        {log.slice(0, logRoom).map(alert => (
          <Box flexDirection="row">
            <Text dimColor>{`${clockText(alert.time)}  `}</Text>
            <Text color={alert.color} bold>{alert.level.toUpperCase().padEnd(8)}</Text>
            <Text color={LCARS.tan}>{alert.status.padEnd(11)}</Text>
            <Box flexShrink={1}>
              <Text wrap="truncate">{`${alert.message || '-'}${alert.source ? `  · ${alert.source}` : ''}`}</Text>
            </Box>
          </Box>
        ))}

        <Box flexDirection="row" marginTop={1} gap={1}>
          <Button key="silence" label="Silence" hotkey={SILENCE_KEY} onPress={() => void silenceQuietly($, true)} />
          <Button key="mute" label="Mute 30m" hotkey="m" onPress={() => void mute($, 30).catch(() => null)} />
          <Button key="unmute" label="Unmute" hotkey="u" onPress={() => void unmute($).catch(() => null)} />
          {current !== null && current.checkedAt > 0 && !current.online && (
            <Button key="start" label="Start daemon" hotkey="d" variant="primary" onPress={() => void startAndToast($)} />
          )}
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void refresh($)} />
          <Button key="close" label="Close" hotkey="x" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })

  // The tool's own transcript row: a pill in the level's color.
  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e) => {
    const input = (e.props.input ?? {}) as { level?: unknown; message?: unknown }
    const level = typeof input.level === 'string' ? input.level : '?'
    const message = typeof input.message === 'string' ? input.message : ''
    const color = (await read($, levels)).find(one => one.name === level)?.color ?? LCARS.orange
    const output = typeof e.props.output === 'string' ? e.props.output : ''
    const state = e.props.isRunning
      ? 'sounding…'
      : e.props.isInterrupted
        ? 'interrupted'
        : e.props.isErrored
          ? 'failed'
          : (output.split(':')[0] ?? '').toLowerCase()
    const t = $.ui.resolve(e)
    const { Box, Text } = t
    return (
      <Box flexDirection="row">
        {pill(t, `${level.toUpperCase()} ALERT`, color)}
        <Text> </Text>
        <Box flexShrink={1}>
          <Text wrap="truncate">{message}</Text>
        </Box>
        <Text dimColor>{`  ${state}`}</Text>
      </Box>
    )
  })
}
