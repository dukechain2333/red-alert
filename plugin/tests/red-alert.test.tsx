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
  { name: 'normal', priority: 10, description: 'small things', color: '#99CCFF', style: 'sweep', duration: 0, sound_ready: true },
  { name: 'yellow', priority: 50, description: 'big task done', color: '#FFCC33', style: 'pulse', duration: 0, sound_ready: true },
  { name: 'red', priority: 90, description: 'blocked, need the user', color: '#FF3333', style: 'klaxon', duration: 12, sound_ready: true },
]

type Request = { method: string; path: string; body: Record<string, unknown> }
type FakeAlert = Record<string, unknown> & { id: string; status: string }

/**
 * A daemon in memory. The alert raised last plays until the test calls
 * `finish()`, or until a `/stop` (or `stopElsewhere`) stops it.
 */
function fakeDaemon(on: On, options: { isOnline?: boolean } = {}) {
  const requests: Request[] = []
  const alerts: FakeAlert[] = []
  const registered: { name: string; description: string; inputSchema?: unknown }[] = []
  const toasts: string[] = []
  const processes: string[][] = []
  let playing: FakeAlert | null = null
  let mute: { until: number | null } | null = null
  let healthHeld: Promise<void> | null = null

  const stop = (id: string | undefined) => {
    if (!playing || (id && playing.id !== id)) return null
    playing.status = 'stopped'
    const stopped = playing.id
    playing = null
    return stopped
  }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
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
  on('ui.focus', () => ({ deny: 'not holding the keys in a test' }))
  on('process.run', ($, e) => {
    processes.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', async ($, e) => {
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
        await healthHeld
        return reply({
          ok: true, version: '0.1.0', hostname: 'bridge', time: NOW / 1000, uptime_s: 3600,
          player: 'auto (pw-play)', levels: LEVELS.map(l => l.name), levels_hash: 'abc123',
          playing: playing ? { id: playing.id, level: playing.level } : null, mute,
          last_alert: alerts[0] ?? null,
        })
      case '/levels':
        return reply({ ok: true, levels: LEVELS })
      case '/history':
        return reply({ ok: true, alerts })
      case '/alert': {
        const level = LEVELS.find(l => l.name === body.level)
        if (!level) return reply({ ok: false, error: `unknown level '${body.level}'`, levels: LEVELS.map(l => l.name) }, 404)
        if (playing) playing.status = 'preempted'
        const alert: FakeAlert = {
          id: `a${alerts.length + 1}`, level: level.name, priority: level.priority, color: level.color,
          style: level.style, title: `${level.name.toUpperCase()} ALERT`, message: body.message ?? '',
          source: body.source ?? '', time: NOW / 1000, duration: body.duration ?? level.duration,
          status: 'playing', detail: null,
        }
        alerts.unshift(alert)
        playing = alert
        return reply({ ok: true, alert })
      }
      case '/stop':
        return reply({ ok: true, stopped: stop(typeof body.id === 'string' ? body.id : undefined) })
      case '/mute':
        mute = { until: body.minutes === 0 ? null : NOW / 1000 + Number(body.minutes) * 60 }
        return reply({ ok: true, mute })
      case '/unmute':
        mute = null
        return reply({ ok: true, mute })
      default:
        return reply({ ok: true })
    }
  })
  return {
    requests,
    alerts,
    registered,
    toasts,
    processes,
    finish: () => {
      if (playing) playing.status = 'played'
      playing = null
    },
    stopElsewhere: () => stop(undefined),
    /** Holds every /health answer until the returned function is called. */
    holdHealth: () => {
      let release = () => {}
      healthHeld = new Promise(resolve => (release = resolve))
      return () => {
        healthHeld = null
        release()
      }
    },
    sent: (path: string) => requests.filter(r => r.path === path),
  }
}

const START = { cwd: '/home/u/project', surface: 'terminal', isInteractive: true } as const

const ending = (reason: 'clear' | 'resume' | 'prompt_input_exit') => ({ reason, sessionId: 's1', resume: { id: 's1' } })

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
    await $.session.start(START)

    const tool = daemon.registered[daemon.registered.length - 1]
    expect(tool?.name).toBe('alert')
    expect(tool?.description).toContain('- red: blocked, need the user')
    expect(tool?.description).toContain('whether or not the user seems to be at the keyboard')
    expect(JSON.stringify(tool?.inputSchema)).toContain('"enum":["normal","yellow","red"]')

    const ran = await $.tool.call({ tool: TOOL, level: 'red', message: 'Need your decision on the schema' })
    expect(JSON.stringify(ran)).toContain('Sounded: RED alert is playing on bridge')
    expect(daemon.sent('/alert')[0]?.body).toEqual({
      level: 'red',
      message: 'Need your decision on the schema',
      source: 'claude-code:project',
    })
  })

  test('reports an unknown level with the valid ones', async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeDaemon(on)
    await $.session.start(START)
    const ran = await $.tool.call({ tool: TOOL, level: 'purple', message: 'x' })
    expect(JSON.stringify(ran)).toContain('Valid levels: normal, yellow, red')
  })

  test('says so when the daemon is offline', async ($, on) => {
    mock.clock(on, { now: NOW })
    const daemon = fakeDaemon(on, { isOnline: false })
    await $.session.start(START)
    expect(daemon.registered[0]?.description).toContain('- yellow:')
    const ran = await $.tool.call({ tool: TOOL, level: 'red', message: 'x' })
    expect(JSON.stringify(ran)).toContain('Offline: the alert system')
  })
})

describe('the band', () => {
  test('shows the daemon state, and the levels as the only items to press', async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeDaemon(on)
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'red-alert', surface, ...BAND })
      expect(await ui.find({ text: /ALERT SYSTEM/ })).toBeDefined()
      expect(await ui.find({ text: /● ONLINE/ })).toBeDefined()
      const keys = ['band:level:normal', 'band:level:yellow', 'band:level:red']
      const items = await Promise.all(keys.map(key => ui.find({ key })))
      expect(items.map(item => item?.text)).toEqual(['NORMAL', 'YELLOW', 'RED'])
      expect(items.map(item => item?.props.autoFocus)).toEqual([true, undefined, undefined])
      // a bare digit at an empty prompt presses band Buttons: none of these may have one
      expect(items.map(item => item?.props.hotkey)).toEqual([undefined, undefined, undefined])
      const buttons = await ui.findAll({ type: 'Button' })
      expect(buttons.map(button => button.key)).toEqual(keys)
      await ui.unmount()
    }
  })

  test('Enter on a level item sounds it by hand', async ($, on) => {
    mock.clock(on, { now: NOW })
    const daemon = fakeDaemon(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'red-alert', surface: 'terminal', ...BAND })
    await ui.press({ key: 'band:level:yellow' })
    expect(daemon.sent('/alert')[0]?.body).toEqual({
      level: 'yellow',
      message: 'Manual yellow alert',
      source: 'claude-code:project (manual)',
    })
    expect(await ui.find({ text: /YELLOW ALERT/ })).toBeDefined()
    expect(await ui.find({ key: 'band:level:yellow' })).toBeUndefined()
    await ui.unmount()
  })

  test('shows OFFLINE when the daemon is down', async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeDaemon(on, { isOnline: false })
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'red-alert', surface, ...BAND })
      expect(await ui.find({ text: /○ OFFLINE/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('shows MUTED with the time left', async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeDaemon(on)
    await $.session.start(START)
    await $.command.run({ command: 'alert', args: 'mute 30', ...TYPED })
    const ui = await $.ui.mount({ plugin: 'red-alert', surface: 'terminal', ...BAND })
    expect(await ui.find({ text: /◐ MUTED 30M/ })).toBeDefined()
    await ui.unmount()
  })

  test('counts a mute down rounding up', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    fakeDaemon(on)
    await $.session.start(START)
    await $.command.run({ command: 'alert', args: 'mute 30', ...TYPED })
    await clock.advance(3000)
    const ui = await $.ui.mount({ plugin: 'red-alert', surface: 'terminal', ...BAND })
    expect(await ui.find({ text: /◐ MUTED 30M/ })).toBeDefined()
    await ui.unmount()
  })

  test('shows OFFLINE when the daemon takes the request but never answers', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const daemon = fakeDaemon(on)
    await $.session.start(START)
    const release = daemon.holdHealth()
    await clock.advance(5000) // a poll asks, and hears nothing
    await clock.advance(5000) // its call times out
    const ui = await $.ui.mount({ plugin: 'red-alert', surface: 'terminal', ...BAND })
    expect(await ui.find({ text: /○ OFFLINE/ })).toBeDefined()
    await ui.unmount()
    release()
  })

  test('animates for as long as the alert sounds, counting down, then latches', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const daemon = fakeDaemon(on)
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, level: 'red', message: 'Blocked on credentials' }) // red sounds 12 s

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'red-alert', surface, ...BAND })
      expect(await ui.find({ text: /RED ALERT/ })).toBeDefined()
      expect(await ui.find({ text: /Blocked on credentials/ })).toBeDefined()
      expect(await ui.find({ text: / 12s / })).toBeDefined()
      expect((await ui.find({ key: 'band:silence' }))?.props.hotkey).toBe('0')
      if (surface === 'terminal') {
        expect(await ui.find({ key: 'bars:top' })).toBeDefined()
      }
      await ui.unmount()
    }

    await clock.advance(9000) // 9 s of the 12
    let ui = await $.ui.mount({ plugin: 'red-alert', surface: 'terminal', ...BAND })
    expect(await ui.find({ key: 'bars:top' })).toBeDefined()
    expect(await ui.find({ text: / 3s / })).toBeDefined()
    await ui.unmount()

    await clock.advance(5000) // 14 s: the planned time is over, but the daemon still plays it
    ui = await $.ui.mount({ plugin: 'red-alert', surface: 'terminal', ...BAND })
    expect(await ui.find({ key: 'bars:top' })).toBeDefined()
    await ui.unmount()

    daemon.finish()
    await clock.advance(1500)
    ui = await $.ui.mount({ plugin: 'red-alert', surface: 'terminal', ...BAND })
    expect(await ui.find({ key: 'bars:top' })).toBeUndefined()
    expect(await ui.find({ text: /RED ALERT/ })).toBeDefined()
    expect((await ui.find({ key: 'band:silence' }))?.text).toContain('Dismiss')
    await ui.unmount()
  })

  test('0 silences the alert it shows', async ($, on) => {
    mock.clock(on, { now: NOW })
    const daemon = fakeDaemon(on)
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, level: 'yellow', message: 'Refactor done' })
    const ui = await $.ui.mount({ plugin: 'red-alert', surface: 'terminal', ...BAND })
    await ui.press({ key: 'band:silence' })
    expect(daemon.sent('/stop').map(r => r.body)).toEqual([{ id: 'a1' }])
    expect(daemon.alerts[0]?.status).toBe('stopped')
    expect(await ui.find({ text: /YELLOW ALERT/ })).toBeUndefined()
    expect(await ui.find({ text: /ONLINE/ })).toBeDefined()
    await ui.unmount()
  })

  test('a new alert animates on when the last one settles under it', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const daemon = fakeDaemon(on)
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, level: 'red', message: 'Blocked' }) // red sounds 12 s
    const release = daemon.holdHealth()
    await clock.advance(12_100) // its animation is over: a frame asks the daemon whether it still plays
    await $.tool.call({ tool: TOOL, level: 'normal', message: 'Build finished' }) // a sweep: not latched
    release() // the daemon answers: it plays the new alert, not the red one
    daemon.finish()
    await clock.advance(5000) // past the sweep
    const ui = await $.ui.mount({ plugin: 'red-alert', surface: 'terminal', ...BAND })
    expect(await ui.find({ text: /NORMAL ALERT/ })).toBeUndefined()
    await ui.unmount()
  })

  test('takes the banner down when the alert is silenced elsewhere', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const daemon = fakeDaemon(on)
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, level: 'red', message: 'Blocked' })
    daemon.stopElsewhere()
    await clock.advance(5000) // one health check
    const ui = await $.ui.mount({ plugin: 'red-alert', surface: 'terminal', ...BAND })
    expect(await ui.find({ text: /RED ALERT/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('session end', () => {
  for (const reason of ['clear', 'resume'] as const) {
    test(`a /${reason} keeps the band polling and the banner animating`, async ($, on) => {
      const clock = mock.clock(on, { now: NOW })
      const daemon = fakeDaemon(on)
      await $.session.start(START)
      await $.tool.call({ tool: TOOL, level: 'normal', message: 'Build finished' }) // a sweep: not latched
      await $.session.end(ending(reason))

      const polled = daemon.sent('/health').length
      daemon.finish()
      await clock.advance(5000) // past the sweep, and one poll
      expect(daemon.sent('/health').length).toBeGreaterThan(polled)
      const ui = await $.ui.mount({ plugin: 'red-alert', surface: 'terminal', ...BAND })
      expect(await ui.find({ text: /NORMAL ALERT/ })).toBeUndefined()
      expect(await ui.find({ text: /ONLINE/ })).toBeDefined()
      await ui.unmount()
    })
  }

  test('an exit stops polling', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const daemon = fakeDaemon(on)
    await $.session.start(START)
    await $.session.end(ending('prompt_input_exit'))
    const polled = daemon.sent('/health').length
    await clock.advance(15000)
    expect(daemon.sent('/health').length).toBe(polled)
  })
})

describe('sounding alerts by hand', () => {
  test('/alert <level> [duration] [message]', async ($, on) => {
    mock.clock(on, { now: NOW })
    const daemon = fakeDaemon(on)
    await $.session.start(START)

    const red = await $.command.run({ command: 'alert', args: 'red 30s 开会了', ...TYPED })
    expect(red.text).toBe('RED alert sounding (30s). Press 0 at an empty prompt to silence it.')
    expect(daemon.sent('/alert')[0]?.body).toEqual({
      level: 'red',
      message: '开会了',
      source: 'claude-code:project (manual)',
      duration: 30,
    })

    const ui = await $.ui.mount({ plugin: 'red-alert', surface: 'terminal', ...BAND })
    expect(await ui.find({ text: /开会了  · manual/ })).toBeDefined()
    await ui.unmount()

    await $.command.run({ command: 'alert', args: 'sound normal 2m', ...TYPED })
    expect(daemon.sent('/alert')[1]?.body).toEqual({
      level: 'normal',
      message: 'Manual normal alert',
      source: 'claude-code:project (manual)',
      duration: 120,
    })

    await $.command.run({ command: 'alert', args: 'yellow lunch is ready', ...TYPED })
    expect(daemon.sent('/alert')[2]?.body.message).toBe('lunch is ready')
    expect(daemon.sent('/alert')[2]?.body.duration).toBeUndefined()

    const usage = await $.command.run({ command: 'alert', args: 'purple', ...TYPED })
    expect(usage.text).toContain('levels: normal, yellow, red')

    const stopped = await $.command.run({ command: 'alert', args: 'stop', ...TYPED })
    expect(stopped.text).toBe('Alert silenced.')
    expect(daemon.sent('/stop').map(r => r.body)).toEqual([{}])
  })

  test('the console sounds a level with the typed message', async ($, on) => {
    mock.clock(on, { now: NOW })
    const daemon = fakeDaemon(on)
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'red-alert', surface, ...PANE })
      expect(await ui.find({ text: /GREEN · STANDING BY/ })).toBeDefined()
      expect(await ui.find({ text: /MANUAL ALERT/ })).toBeDefined()
      expect(await ui.find({ text: /klaxon 12s/ })).toBeDefined()
      expect(await ui.find({ text: /pulse  once/ })).toBeDefined()
      expect((await ui.find({ key: 'sound:red' }))?.props.hotkey).toBe('3')
      await ui.unmount()
    }

    const ui = await $.ui.mount({ plugin: 'red-alert', surface: 'terminal', ...PANE })
    await ui.input({ key: 'manual:message', text: '午饭好了' })
    await ui.press({ key: 'sound:red' })
    expect(daemon.sent('/alert')[0]?.body).toEqual({
      level: 'red',
      message: '午饭好了',
      source: 'claude-code:project (manual)',
    })
    expect(await ui.find({ text: /RED ALERT/ })).toBeDefined()
    expect((await ui.find({ key: 'manual:message' }))?.props.value).toBe('')

    await ui.press({ key: 'silence' })
    expect(daemon.sent('/stop').map(r => r.body)).toEqual([{}])
    expect(await ui.find({ text: /GREEN · STANDING BY/ })).toBeDefined()
    await ui.unmount()
  })

  test('/alert status lists the durations', async ($, on) => {
    mock.clock(on, { now: NOW })
    fakeDaemon(on)
    await $.session.start(START)
    const status = await $.command.run({ command: 'alert', args: 'status', ...TYPED })
    expect(status.text).toContain('red-alert ● online at http://127.0.0.1:1701')
    expect(status.text).toContain('normal (p10, once), yellow (p50, once), red (p90, 12s)')
  })
})
