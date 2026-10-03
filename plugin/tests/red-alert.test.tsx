// Tests for the red-alert mod. Run: claude plugin test plugin
//
// A fake daemon answers `$.http.fetch` beneath the plugin, the clock is
// mocked, and the band and pane are drawn on both terminal and desktop so
// every tree is validated against each surface's element table.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__red-alert__alert'
const NOW = 1_760_000_000_000

const LEVELS = [
  { name: 'normal', priority: 10, description: 'small things', color: '#99CCFF', style: 'sweep', sound_ready: true },
  { name: 'yellow', priority: 50, description: 'big task done', color: '#FFCC33', style: 'pulse', sound_ready: true },
  { name: 'red', priority: 90, description: 'blocked, need the user', color: '#FF3333', style: 'klaxon', sound_ready: true },
]

type Request = { method: string; path: string; body: Record<string, unknown> }

function fakeDaemon(on: On, options: { isOnline?: boolean } = {}) {
  const requests: Request[] = []
  const alerts: Record<string, unknown>[] = []
  const registered: { name: string; description: string; inputSchema?: unknown }[] = []
  const toasts: string[] = []

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => {
    registered.push(e)
    return { value: { tool: `mcp__red-alert__${e.name}` } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('http.fetch', ($, e) => {
    if (options.isOnline === false) {
      return { deny: 'connect ECONNREFUSED 127.0.0.1:1701' }
    }
    const url = new URL(e.url)
    const body = e.init?.body ? (JSON.parse(e.init.body) as Record<string, unknown>) : {}
    requests.push({ method: e.init?.method ?? 'GET', path: url.pathname, body })
    const reply = (payload: unknown, status = 200) => ({
      value: {
        status,
        ok: status < 400,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify(payload),
      },
    })
    switch (url.pathname) {
      case '/health':
        return reply({
          ok: true, version: '0.1.0', hostname: 'bridge', time: NOW / 1000, uptime_s: 3600,
          player: 'auto (pw-play)', levels: LEVELS.map(l => l.name), levels_hash: 'abc123',
          playing: null, mute: null, last_alert: alerts[0] ?? null,
        })
      case '/levels':
        return reply({ ok: true, levels: LEVELS })
      case '/history':
        return reply({ ok: true, alerts })
      case '/alert': {
        const level = LEVELS.find(l => l.name === body.level)
        if (!level) return reply({ ok: false, error: `unknown level '${body.level}'`, levels: LEVELS.map(l => l.name) }, 404)
        const alert = {
          id: `a${alerts.length + 1}`, level: level.name, priority: level.priority, color: level.color,
          style: level.style, title: `${level.name.toUpperCase()} ALERT`, message: body.message ?? '',
          source: body.source ?? '', time: NOW / 1000, status: 'playing', detail: null,
        }
        alerts.unshift(alert)
        return reply({ ok: true, alert })
      }
      case '/stop':
        return reply({ ok: true, stopped: body.id ?? null })
      default:
        return reply({ ok: true })
    }
  })
  return { requests, alerts, registered, toasts }
}

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 110, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

const PANE = {
  component: 'Pane',
  requestId: 'alert-console',
  props: { title: 'Alert console', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  viewport: { columns: 160, rows: 40 },
} as const

describe('the alert tool', () => {
  test('is registered with the daemon levels and sounds an alert', async ($, on) => {
    mock.clock(on, { now: NOW })
    const daemon = fakeDaemon(on)
    await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })

    const tool = daemon.registered[daemon.registered.length - 1]
    expect(tool?.name).toBe('alert')
    expect(tool?.description).toContain('- red: blocked, need the user')
    expect(JSON.stringify(tool?.inputSchema)).toContain('"enum":["normal","yellow","red"]')

    const ran = await $.tool.call({ tool: TOOL, level: 'red', message: 'Need your decision on the schema' })
    expect(JSON.stringify(ran)).toContain('Sounded: RED alert is playing on bridge')
    const sent = daemon.requests.find(r => r.path === '/alert')
    expect(sent?.body).toEqual({ level: 'red', message: 'Need your decision on the schema', source: 'claude-code:project' })
  })

  test('reports an unknown level with the valid ones', async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeDaemon(on)
    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
    const ran = await $.tool.call({ tool: TOOL, level: 'purple', message: 'x' })
    expect(JSON.stringify(ran)).toContain('Valid levels: normal, yellow, red')
  })

  test('says so when the daemon is offline', async ($, on) => {
    mock.clock(on, { now: NOW })
    const daemon = fakeDaemon(on, { isOnline: false })
    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
    expect(daemon.registered[0]?.description).toContain('- yellow:')
    const ran = await $.tool.call({ tool: TOOL, level: 'red', message: 'x' })
    expect(JSON.stringify(ran)).toContain('Offline: the alert system')
  })
})

describe('the band', () => {
  test('shows the link status on every surface', async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeDaemon(on)
    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'red-alert', surface, ...BAND })
      expect(await ui.find({ text: /ONLINE/ })).toBeDefined()
      expect(await ui.find({ text: /ALERT SYSTEM/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('shows OFFLINE with a Start button when the daemon is down', async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeDaemon(on, { isOnline: false })
    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'red-alert', surface, ...BAND })
      expect(await ui.find({ text: /OFFLINE/ })).toBeDefined()
      expect(await ui.find({ key: 'band:start' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('animates an alert, latches it, and acknowledges it', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const daemon = fakeDaemon(on)
    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: TOOL, level: 'red', message: 'Blocked on credentials' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'red-alert', surface, ...BAND })
      expect(await ui.find({ text: /RED ALERT/ })).toBeDefined()
      expect(await ui.find({ text: /Blocked on credentials/ })).toBeDefined()
      if (surface === 'terminal') {
        expect(await ui.find({ key: 'bars:top' })).toBeDefined()
      }
      await ui.unmount()
    }

    await clock.advance(1500)
    await clock.advance(15000)
    const ui = await $.ui.mount({ plugin: 'red-alert', surface: 'terminal', ...BAND })
    expect(await ui.find({ key: 'bars:top' })).toBeUndefined()
    expect(await ui.find({ text: /RED ALERT/ })).toBeDefined()
    await ui.press({ key: 'band:ack' })
    expect(daemon.requests.some(r => r.path === '/stop' && r.body.id === 'a1')).toBe(true)
    expect(await ui.find({ text: /ONLINE/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('the console', () => {
  test('draws levels and log, and tests a level', async ($, on) => {
    mock.clock(on, { now: NOW })
    const daemon = fakeDaemon(on)
    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'red-alert', surface, ...PANE })
      expect(await ui.find({ text: /GREEN · STANDING BY/ })).toBeDefined()
      expect(await ui.find({ text: /big task done/ })).toBeDefined()
      await ui.unmount()
    }
    const ui = await $.ui.mount({ plugin: 'red-alert', surface: 'terminal', ...PANE })
    await ui.press({ key: 'test:yellow' })
    expect(daemon.requests.some(r => r.path === '/alert' && r.body.level === 'yellow')).toBe(true)
    expect(await ui.find({ text: /YELLOW ALERT/ })).toBeDefined()
    await ui.unmount()
  })

  test('/alert subcommands answer', async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeDaemon(on)
    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
    const status = await $.command.run({ command: 'alert', args: 'status', ...TYPED })
    expect(status.text).toContain('red-alert ● online at http://127.0.0.1:1701')
    const tested = await $.command.run({ command: 'alert', args: 'test yellow', ...TYPED })
    expect(tested.text).toBe('YELLOW test alert: playing.')
    const usage = await $.command.run({ command: 'alert', args: 'bogus', ...TYPED })
    expect(usage.text).toContain('Usage: /alert')
  })
})
