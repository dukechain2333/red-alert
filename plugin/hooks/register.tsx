// red-alert: the Claude Code side of the alert system.
//
// - registers the `alert` tool the model calls on its own judgment, its
//   levels and their descriptions read from the daemon (GET /levels);
// - adds a short section to the system prompt saying when to use it;
// - draws an LCARS strip above the prompt that shows whether the daemon is
//   online, and animates every alert (klaxon, pulse or sweep) there;
// - opens an alert console pane with /alert, and answers /alert subcommands.

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { ActiveAlert, AlertLevel, AlertRecord, DaemonLink } from '../types'
import { Offline, Refused, endpoint, errorText, parseReply, requestInit } from './api'
import type { DaemonAlert, DaemonLevel, Health } from './api'
import { DURATION_MS, FPS, LCARS, bannerColors, barCells, barRuns, chevrons, mix } from './frames'

const TOOL_NAME = 'alert'
const TOOL = 'mcp__red-alert__alert'
const PANE = 'alert-console'
const HISTORY_SIZE = 20
const START_COMMAND = ['systemctl', '--user', 'start', 'red-alert']
/** Alert statuses worth a banner: the alert reached the speaker, or would have. */
const SHOWN = new Set(['playing', 'played', 'muted', 'stopped', 'preempted'])

const link = atom({ plugin: 'red-alert', key: 'link' } as const, null)
const levels = atom({ plugin: 'red-alert', key: 'levels' } as const, [])
const history = atom({ plugin: 'red-alert', key: 'history' } as const, [])
const active = atom({ plugin: 'red-alert', key: 'active' } as const, null)

/** The tool's levels until the daemon has answered once. */
const FALLBACK_LEVELS: AlertLevel[] = [
  {
    name: 'normal', priority: 10, style: 'sweep', color: '#99CCFF', soundReady: false,
    description: 'A light ping: a small milestone or FYI, such as a long build or test run that finished.',
  },
  {
    name: 'yellow', priority: 50, style: 'pulse', color: '#FFCC33', soundReady: false,
    description: 'A significant body of work is complete and ready for review.',
  },
  {
    name: 'red', priority: 90, style: 'klaxon', color: '#FF3333', soundReady: false,
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

function muteLabel(muted: DaemonLink['mute'], nowMs: number): string {
  if (!muted) return ''
  return muted.until === null ? 'MUTED' : `MUTED ${ago(muted.until - nowMs / 1000)}`
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
    `levels: ${list.map(level => `${level.name} (p${level.priority})`).join(', ')}`,
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
    const fresh = isSeeded
      ? alerts.find(alert => !known.has(alert.id) && !ownIds.has(alert.id) && SHOWN.has(alert.status))
      : undefined
    isSeeded = true
    if (fresh) {
      const from = fresh.source ? ` from ${fresh.source}` : ''
      $.ui.toast(`${fresh.title}${from}: ${fresh.message || fresh.level}`, { timeoutMs: 6000 })
      await showAlert($, fresh, false)
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

async function raise($: EngineInterface, level: string, message: string, from: string): Promise<DaemonAlert> {
  const { alert } = await call<{ alert: DaemonAlert }>($, 'POST', '/alert', { level, message, source: from })
  ownIds.add(alert.id)
  await update($, history, list => [toRecord(alert), ...list.filter(one => one.id !== alert.id)].slice(0, HISTORY_SIZE))
  if (SHOWN.has(alert.status)) {
    await showAlert($, alert, true)
  }
  return alert
}

async function testLevel($: EngineInterface, level: string): Promise<void> {
  await raise($, level, `Test of the ${level} alert`, `${source} (console)`).catch(() => null)
}

async function showAlert($: EngineInterface, alert: DaemonAlert, isOwn: boolean): Promise<void> {
  const now = await $.clock.now()
  const shown: ActiveAlert = {
    id: alert.id,
    level: alert.level,
    color: alert.color,
    style: alert.style,
    title: alert.title,
    message: alert.message,
    source: alert.source,
    isOwn,
    startedAt: now,
    animateUntil: now + DURATION_MS[alert.style],
    isLatched: isOwn && alert.style !== 'sweep',
  }
  await update($, active, () => shown)
  animate($)
}

function animate($: EngineInterface): void {
  frameTimer?.cancel()
  frameTimer = $.clock.every(Math.round(1000 / FPS), () => void nextFrame($))
}

/** One animation frame: redraw, or settle the band once the animation is over. */
async function nextFrame($: EngineInterface): Promise<void> {
  const [now, current] = await Promise.all([$.clock.now(), read($, active)])
  if (current && now < current.animateUntil) {
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

/** Clears the banner; silences the sound when this session raised it. */
async function acknowledge($: EngineInterface): Promise<void> {
  const current = await read($, active)
  if (!current) return
  frameTimer?.cancel()
  frameTimer = undefined
  await update($, active, shown => (shown?.id === current.id ? null : shown))
  if (current.isOwn) {
    await call($, 'POST', '/stop', { id: current.id }).catch(() => null)
  }
}

async function silence($: EngineInterface): Promise<string | null> {
  await acknowledge($)
  return (await call<{ stopped: string | null }>($, 'POST', '/stop', {})).stopped
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

/** The strip shown while no alert is up: link status, levels, last alert. */
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
  const brand = '◉ ALERT SYSTEM'
  const status = statusPill(current, now)
  const levelText = list.map(level => level.name.toUpperCase()).join(' · ')
  const last = log[0]
  const lastText = last ? `LAST ${last.level.toUpperCase()} ${ago(now / 1000 - last.time)} AGO` : ''
  const isOffline = current !== null && current.checkedAt > 0 && !current.online
  const isMuted = Boolean(current?.mute)

  let used = brand.length + 4 + 1 + 1 + status.label.length + 4 + (isOffline ? 10 : isMuted ? 11 : 0)
  const isLevelsShown = levelText !== '' && width - used - 4 >= levelText.length + 1
  if (isLevelsShown) used += levelText.length + 1
  const isLastShown = lastText !== '' && width - used - 4 >= lastText.length + 2
  if (isLastShown) used += lastText.length + 2

  return (
    <Box flexDirection="row">
      {pill(t, brand, LCARS.orange)}
      <Text> </Text>
      {rule(t, width - used, LCARS.lavender)}
      <Text> </Text>
      {pill(t, status.label, status.color)}
      {isLevelsShown && <Text> </Text>}
      {isLevelsShown &&
        list.map((level, i) => (
          <Text color={level.color} bold>{`${i > 0 ? ' · ' : ''}${level.name.toUpperCase()}`}</Text>
        ))}
      {isLastShown && <Text color={LCARS.tan}>{`  ${lastText}`}</Text>}
      {isOffline && <Button key="band:start" label="Start" hotkey="s" dimColor onPress={() => void startAndToast($)} />}
      {isMuted && <Button key="band:unmute" label="Unmute" hotkey="u" dimColor onPress={() => void unmute($).catch(() => null)} />}
    </Box>
  )
}

/** The alert banner, with animated light bars above and below while it is fresh. */
function alertBanner($: EngineInterface, t: Table, width: number, maxRows: number, shown: ActiveAlert, now: number) {
  const { Box, Text, Button } = t
  const ms = now - shown.startedAt
  const isAnimating = now < shown.animateUntil
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
  const from = shown.isOwn ? '' : `  · ${shown.source || 'elsewhere'}`

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
        {(shown.isOwn || !isAnimating) && (
          <Button key="band:ack" label="Acknowledge" hotkey="a" onPress={() => void acknowledge($)} />
        )}
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
      description: 'Alert console: daemon status, test a level, stop, mute',
      argumentHint: '[status | test <level> | stop | mute [minutes] | unmute | start]',
    })
    await registerTool($, await read($, levels))
    await Promise.race([poll($), $.clock.sleep(1500)])
    pollTimer?.cancel()
    pollTimer = $.clock.every(settings.pollMs, () => void refresh($))
    const current = await read($, active)
    if (current && (await $.clock.now()) < current.animateUntil) {
      animate($)
    }
    return next(e)
  })

  on('session.end', ($, e, next) => {
    pollTimer?.cancel()
    frameTimer?.cancel()
    return next(e)
  })

  // The person is back at the keyboard: their alert has done its job.
  on('prompt.submit', async ($, e, next) => {
    const current = await read($, active)
    if (current?.isOwn) {
      await Promise.race([acknowledge($), $.clock.sleep(400)])
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
      const alert = await raise($, level, message, source)
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
      await raise($, level, e.message, `${source} (permission prompt)`).catch(() => null)
    }
    return next(e)
  })

  // -- /alert ----------------------------------------------------------------

  on('command.run', { command: 'alert' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    try {
      switch (verb.toLowerCase()) {
        case '':
        case 'console': {
          const opened = await $.ui.open({ id: PANE, title: 'Alert console' })
          return { text: opened.isPlaced ? 'Alert console opened.' : 'Alert console: widen the terminal to see it.' }
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
        case 'test': {
          const list = await read($, levels)
          const name = rest[0] ?? list[list.length - 1]?.name ?? 'red'
          const alert = await raise($, name, `Test of the ${name} alert`, `${source} (/alert test)`)
          return { text: `${alert.level.toUpperCase()} test alert: ${alert.status}.` }
        }
        case 'stop':
        case 'ack': {
          const stopped = await silence($)
          return { text: stopped ? 'Alert silenced.' : 'Nothing was playing.' }
        }
        case 'mute': {
          const minutes = rest[0] === undefined ? 30 : Number(rest[0])
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
        default:
          return { text: 'Usage: /alert [status | test <level> | stop | mute [minutes] | unmute | start]' }
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
    const width = Math.max(20, e.props.bodyColumns)
    if (shown && (now < shown.animateUntil || shown.isLatched)) {
      return alertBanner($, t, width, Math.max(1, e.props.maxRows - 1), shown, now)
    }
    if (!settings.isIdleBandShown) return next(e)
    return idleStrip($, t, width, current, list, log, now)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [current, shown, list, log, now] = await Promise.all([
      read($, link),
      read($, active),
      read($, levels),
      read($, history),
      $.clock.now(),
    ])
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const width = Math.max(30, e.props.bodyColumns)
    const rows = e.viewport?.rows ?? 30

    const condition = shown
      ? { label: `${shown.level.toUpperCase()} ALERT`, color: shown.color }
      : current?.online
        ? { label: 'GREEN · STANDING BY', color: LCARS.green }
        : { label: 'NO CONTACT', color: LCARS.red }
    const system = current?.online
      ? `● ONLINE  ${current.url} · v${current.version} · ${current.hostname} · up ${ago(current.uptimeS ?? 0).toLowerCase()} · ${current.player}`
      : `○ OFFLINE  ${current?.url ?? settings.url}${current?.error ? ` · ${current.error}` : ''}`
    const logRoom = Math.max(1, rows - list.length - 12)

    return (
      <Box flexDirection="column">
        {shown && (now < shown.animateUntil || shown.isLatched)
          ? alertBanner($, t, width, 5, shown, now)
          : consoleHeader(t, width)}
        <Box flexDirection="row" marginTop={1}>
          <Text color={LCARS.sand} bold>{'SYSTEM     '}</Text>
          <Text color={current?.online ? LCARS.green : LCARS.red} wrap="truncate">{system}</Text>
        </Box>
        <Box flexDirection="row">
          <Text color={LCARS.sand} bold>{'CONDITION  '}</Text>
          <Text color={condition.color} bold>{condition.label}</Text>
          {current?.mute && <Text color={LCARS.peach}>{`  · ${muteLabel(current.mute, now)}`}</Text>}
        </Box>

        {section(t, width, 'LEVELS', LCARS.violet)}
        {list.length === 0 && <Text dimColor>No levels yet: the daemon has not answered.</Text>}
        {list.map((level, i) => (
          <Box flexDirection="row">
            <Button
              key={`test:${level.name}`}
              label="Test"
              {...(i < 9 ? { hotkey: String(i + 1) } : {})}
              plain
              dimColor
              onPress={() => void testLevel($, level.name)}
            />
            <Text> </Text>
            {pill(t, level.name.toUpperCase().padEnd(8), level.color)}
            <Text color={LCARS.tan}>{` p${String(level.priority).padEnd(4)}${level.style.padEnd(7)}`}</Text>
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
          <Button key="stop" label="Stop sound" hotkey="s" onPress={() => void silence($).catch(() => null)} />
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
