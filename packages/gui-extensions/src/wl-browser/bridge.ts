/**
 * The Firefox bridge service: the single, long-lived owner of the user's Firefox WebDriver BiDi
 * session, running in the desktop main process.
 *
 * Why it lives here, and not in the kernel plugin:
 *  - Firefox permits **one** BiDi session per instance, and only `session.end` frees that slot. A
 *    kernel that dies (SIGKILL, a crash) drops the socket without ending the session, leaking the
 *    slot so every later attach is refused. The desktop shell outlives every kernel and every
 *    session, so it is the only place that can hold the session across kernel restarts.
 *  - A browser project (a CTF, an analysis) spans several sessions. The owner must therefore be a
 *    process-level singleton, shared by all callers, never re-acquired per session.
 *
 * How concurrency works ("like an open port, anyone can use it"):
 *  - One upstream BiDi session, many downstream callers (kernel sessions, in practice).
 *  - Isolation unit = tab (`browsingContext`). A caller that does not name a context gets its own
 *    leased tab, so two sessions never fight over the same page.
 *  - Commands are serialised **per tab** (navigation, clicks and typing have order semantics) while
 *    different tabs run truly concurrently.
 *  - Events carry their `context`, so tab state is tracked per tab and routed, not global.
 *
 * Callers reach it over loopback HTTP: `POST /call { caller, method, params }`. The kernel plugin
 * keeps the `firefox.*` tool names and rewrites only its transport.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { BidiClient, type BidiEvent } from "./bidi"
import {
  bundledProfile,
  findFirefox,
  portListening,
  seedManagedProfile,
  tunedFirefoxProfile,
} from "./firefox"

/**
 * Bring the browser window to the foreground.
 *
 * BiDi can select a tab and load a URL, but it has no concept of OS window focus: the browser keeps
 * running behind whatever is on screen. Without this, a `navigate` looks like nothing happened even
 * though the page really loaded. Best effort by design — a failed raise must never fail the call,
 * and on non-Windows platforms it is skipped rather than shelled out.
 */
function raiseBrowserWindow(): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve()
  const binary = findFirefox()
  if (!binary) return Promise.resolve()

  // Match on the image name only: the user's own Firefox and the bundled one behave the same here,
  // and whichever is visible is the one the user needs to see.
  const script = [
    "$p = Get-Process -Name firefox -ErrorAction SilentlyContinue |",
    "  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;",
    "if (-not $p) { exit 0 };",
    "Add-Type -Namespace W -Name U -MemberDefinition '",
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);' + "';",
    "[void][W.U]::ShowWindow($p.MainWindowHandle, 9);",
    "[void][W.U]::SetForegroundWindow($p.MainWindowHandle);",
  ].join(" ")

  return new Promise((resolve) => {
    try {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
        { detached: true, stdio: "ignore", windowsHide: true },
      )
      child.on("error", () => resolve())
      child.on("exit", () => resolve())
      // Never hold the call open for a cosmetic step.
      setTimeout(resolve, 1500)
    } catch {
      resolve()
    }
  })
}

/**
 * Is Firefox holding a BiDi session that nobody owns any more?
 *
 * The decisive signal is asymmetry: the debugging port is listening, the probe below reports that a
 * session already exists, yet no client is connected to that port. A live owner always keeps its
 * socket open, so "session exists + nobody connected" can only mean the previous owner died without
 * `session.end` and leaked the slot. Checking the connection table is what separates this from the
 * normal case where another process legitimately holds the session and is using it right now.
 */
async function isOrphanedSession(port: number): Promise<boolean> {
  if (process.platform !== "win32") return false
  const holders = establishedConnections(port)
  // Somebody is attached: the slot belongs to a live owner, so leave it alone. Attaching will fail
  // for us, but recycling the browser would break the project that owns it.
  if (holders.length > 0) return false
  return sessionInUse(port)
}

/** TCP connections currently established on the debugging port (both directions). */
function establishedConnections(port: number): string[] {
  const script = [
    `$c = @(Get-NetTCPConnection -LocalPort ${port} -State Established -ErrorAction SilentlyContinue);`,
    "$c | ForEach-Object { \"$($_.LocalAddress):$($_.LocalPort)>$($_.RemoteAddress):$($_.RemotePort)\" }",
  ].join(" ")
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    { encoding: "utf8", timeout: 5000, windowsHide: true },
  )
  const out = (result.stdout ?? "").trim()
  return out ? out.split(/\r?\n/).filter((line) => line.trim().length > 0) : []
}

/**
 * Ask BiDi whether the single session slot is taken. `session.status` is answered before the
 * connection is registered as the session owner, so it is safe to call on a fresh socket: it neither
 * creates nor leaks a session, unlike `session.new` followed by a bare close.
 */
function sessionInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/session`)
      const timer = setTimeout(() => {
        try {
          socket.close()
        } catch {
          /* ignore */
        }
        finish(false)
      }, 4000)
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ id: 1, method: "session.status", params: {} }))
      })
      socket.addEventListener("message", (event: MessageEvent) => {
        clearTimeout(timer)
        const text = typeof event.data === "string" ? event.data : ""
        // `{ ready: false }` means a session is already started; `{ ready: true }` means the slot is
        // free (our own probe does not occupy it).
        finish(text.includes('"ready":false') || text.includes('"ready": false'))
        try {
          socket.close()
        } catch {
          /* ignore */
        }
      })
      socket.addEventListener("error", () => {
        clearTimeout(timer)
        finish(false)
      })
      socket.addEventListener("close", () => {
        clearTimeout(timer)
        finish(false)
      })
    } catch {
      finish(false)
    }
  })
}

/**
 * Restart the managed browser so Firefox drops its leaked BiDi slot. Only the tuned/managed install
 * this app owns is touched -- never an unrelated Firefox the user runs -- and only when every
 * connection on that port is already gone, which is exactly the orphan case.
 */
async function recycleFirefox(port: number): Promise<void> {
  if (process.platform !== "win32") return
  const primary = findFirefox()
  if (!primary) return
  // Kill by install directory so a second, unrelated Firefox keeps running.
  const dir = dirname(primary).replace(/'/g, "''")
  const script = [
    `$target = '${dir}';`,
    "$procs = @(Get-CimInstance Win32_Process |",
    '  Where-Object { $_.Name -eq "firefox.exe" -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($target, "OrdinalIgnoreCase") });',
    "foreach ($p in $procs) { & taskkill.exe /F /T /PID $p.ProcessId 2>&1 | Out-Null }",
    `$deadline = (Get-Date).AddSeconds(10);`,
    `while ((Get-Date) -lt $deadline -and @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { Start-Sleep -Milliseconds 200 }`,
  ].join(" ")
  await new Promise<void>((resolve) => {
    try {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
        { stdio: "ignore", windowsHide: true },
      )
      child.on("error", () => resolve())
      child.on("exit", () => resolve())
      setTimeout(resolve, 15_000)
    } catch {
      resolve()
    }
  })
}

/** The events that keep the per-tab inventory current. */
const EVENTS = [
  "browsingContext.contextCreated",
  "browsingContext.contextDestroyed",
  "browsingContext.navigationStarted",
  "browsingContext.load",
]

export type TabInfo = { context: string; url: string; title: string; active: boolean }

export type BridgeStatus = {
  readonly ready: boolean
  readonly upstream: "attached" | "managed" | "none"
  readonly port: number
  readonly endpoint: string
  readonly callers: number
  readonly tabs: readonly TabInfo[]
  readonly error?: string
}

type Lease = { context: string; callers: Set<string> }

type Options = {
  /** The loopback port the user's Firefox speaks BiDi on. */
  readonly remotePort: number
  /** Open a Firefox of our own when none is listening. Off unless explicitly requested. */
  readonly autolaunch: boolean
  readonly log?: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void
}

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "wlstudio")
}

/** Where callers discover this service. Next to the plugin's own settings file. */
export function discoveryPath(): string {
  return join(configDir(), "firefox-bridge.json")
}

export function createFirefoxBridge(options: Options) {
  const log = options.log ?? (() => {})
  const tabs = new Map<string, TabInfo>()
  const leases = new Map<string, Lease>()
  const queues = new Map<string, Promise<unknown>>()
  let client: BidiClient | undefined
  let mode: BridgeStatus["upstream"] = "none"
  let launched: ChildProcess | undefined
  let starting: Promise<BidiClient> | undefined
  let lastError: string | undefined
  let server: Server | undefined
  let endpoint = ""
  let token = ""

  // -------------------------------------------------------------------------
  // Upstream session
  // -------------------------------------------------------------------------

  const applyEvent = (event: BidiEvent): void => {
    const params = event.params ?? {}
    const context = String(params.context ?? "")
    if (!context) return
    switch (event.method) {
      case "browsingContext.contextCreated":
        tabs.set(context, {
          context,
          url: String(params.url ?? ""),
          title: String(params.title ?? ""),
          active: tabs.get(context)?.active ?? false,
        })
        break
      case "browsingContext.contextDestroyed":
        tabs.delete(context)
        for (const [caller, lease] of leases) if (lease.context === context) leases.delete(caller)
        break
      case "browsingContext.navigationStarted":
      case "browsingContext.load": {
        const tab = tabs.get(context)
        if (tab)
          tabs.set(context, {
            ...tab,
            url: String(params.url ?? tab.url),
            title: event.method === "browsingContext.load" ? String(params.title ?? tab.title) : tab.title,
          })
        else tabs.set(context, { context, url: String(params.url ?? ""), title: String(params.title ?? ""), active: false })
        break
      }
      default:
        break
    }
  }

  const refreshTabs = async (): Promise<void> => {
    const active = client
    if (!active) return
    const result = (await active.send("browsingContext.getTree", {})) as { contexts?: Array<{ context?: string; url?: string }> }
    for (const context of result?.contexts ?? []) {
      const id = String(context.context ?? "")
      if (!id) continue
      const existing = tabs.get(id)
      tabs.set(id, { context: id, url: String(context.url ?? existing?.url ?? ""), title: existing?.title ?? "", active: existing?.active ?? false })
    }
  }

  // Hiding `navigator.webdriver` matters because Firefox reports it as `true` for as long as a remote
  // protocol (BiDi) session is open — and sites like Baidu refuse to log in when they see it. This only
  // masks the flag the browser exposes to the page; it does not change what the browser does. A global
  // preload script (no `contexts`) covers every current and future tab. Best effort: an older Firefox
  // without `script.addPreloadScript` must not break the attach.
  const HIDE_WEBDRIVER = `() => {
    try {
      Object.defineProperty(Navigator.prototype, "webdriver", {
        get: () => false,
        configurable: true,
        enumerable: true,
      })
    } catch {}
  }`

  const connect = async (port: number): Promise<BidiClient> => {
    const active = await BidiClient.connect(`ws://127.0.0.1:${port}/session`)
    active.onEvent(applyEvent)
    await active.subscribe(EVENTS)
    try {
      await active.send("script.addPreloadScript", { functionDeclaration: HIDE_WEBDRIVER })
    } catch (error) {
      log("warn", "could not install webdriver mask", { error: error instanceof Error ? error.message : String(error) })
    }
    // Preload scripts only apply to documents loaded after they are installed, so mask the tabs that
    // are already open too. Best effort; a context that navigates away between the two calls is fine.
    try {
      const tree = (await active.send("browsingContext.getTree", {})) as { contexts?: Array<{ context?: string }> }
      for (const context of tree?.contexts ?? []) {
        const id = String(context.context ?? "")
        if (!id) continue
        await active
          .send("script.evaluate", {
            expression: `(${HIDE_WEBDRIVER})()`,
            target: { context: id },
            awaitPromise: false,
          })
          .catch(() => undefined)
      }
    } catch {
      /* best effort */
    }
    return active
  }

  const ensure = (mayLaunch = false): Promise<BidiClient> => {
    if (client && !client.closed) return Promise.resolve(client)
    if (starting) return starting
    starting = (async () => {
      if (await portListening(options.remotePort)) {
        // A previous owner that died without `session.end` leaves Firefox's single BiDi slot taken
        // forever: `onConnectionClose` only unregisters the connection and never deletes the
        // session, so every later attach is refused with "Maximum number of active sessions" and
        // there is no way to clear it from outside. Detect it (nobody is connected but the slot is
        // still held) and recycle the browser, otherwise every session is locked out of the
        // browser until the user restarts it by hand.
        if (await isOrphanedSession(options.remotePort)) {
          log("warn", "firefox session orphaned, recycling browser", { port: options.remotePort })
          await recycleFirefox(options.remotePort)
        }
        // Attaching to a session another client still holds is refused. Retry briefly: a previous
        // owner may be ending its own session right now.
        let lastError2: unknown
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try {
            client = await connect(options.remotePort)
            break
          } catch (error) {
            client = undefined
            lastError2 = error
            if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 700))
          }
        }
        if (client) {
          mode = "attached"
          lastError = undefined
          await refreshTabs()
          log("info", "firefox bridge attached", { port: options.remotePort })
          return client
        }
        const detail = lastError2 instanceof Error ? lastError2.message : String(lastError2)
        lastError = `firefox.attachFailed:${detail}`
        log("warn", "firefox attach failed", { port: options.remotePort, error: detail })
        throw new Error(lastError)
      }

      if (!options.autolaunch && !mayLaunch) {
        lastError = "firefox.notRunning"
        log("info", "firefox not running", { port: options.remotePort })
        throw new Error(lastError)
      }

      // One launch strategy now: the tuned build the installer deployed, with the dedicated profile
      // the installer created for it. The old "take over the user's own profile" mode is gone --
      // driving a browser profile the user relies on risks their bookmarks and logins, and the
      // installer no longer offers it.
      const tunedProfile = tunedFirefoxProfile()
      const binary = findFirefox()
      if (!binary) throw new Error("firefox.notFound")
      const args = (() => {
        const profile = tunedProfile ?? bundledProfile() ?? join(configDir(), "firefox-profile")
        try {
          mkdirSync(profile, { recursive: true })
          // A brand-new profile opens without the bookmarks toolbar on normal pages; keep it
          // visible so the managed browser does not look like it dropped the user's bookmarks.
          seedManagedProfile(profile)
        } catch {
          /* best effort */
        }
        return ["-no-remote", "-profile", profile, "--remote-debugging-port", String(options.remotePort), "about:blank"]
      })()
      launched = spawn(binary, args, {
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: false,
      })
      launched.unref?.()
      const child = launched
      child.once("exit", () => {
        if (launched === child) {
          launched = undefined
          if (mode === "managed") mode = "none"
        }
      })
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline && !(await portListening(options.remotePort))) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      client = await connect(options.remotePort)
      mode = "managed"
      lastError = undefined
      await refreshTabs()
      log("info", "firefox bridge launched", { port: options.remotePort })
      return client
    })()
    const pending = starting
    return pending.finally(() => {
      if (starting === pending) starting = undefined
    })
  }

  /** Runs `work` after every earlier command on the same tab; different tabs stay concurrent. */
  const serialized = <T>(context: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(context) ?? Promise.resolve()
    const next = previous.then(work, work)
    queues.set(
      context,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /** The caller's leased tab, creating one when it has none (or its tab is gone). */
  const lease = async (caller: string): Promise<string> => {
    const active = await ensure()
    const current = leases.get(caller)
    if (current && tabs.has(current.context)) {
      current.callers.add(caller)
      return current.context
    }
    const created = (await active.send("browsingContext.create", { type: "tab" })) as { context?: string }
    const context = String(created?.context ?? "")
    if (!context) throw new Error("firefox.tabFailed")
    await refreshTabs()
    const existing = leases.get(current?.context ?? "")
    if (existing) existing.callers.delete(caller)
    leases.set(caller, { context, callers: new Set([caller]) })
    return context
  }

  const resolveContext = async (caller: string, params: Record<string, unknown>): Promise<string> => {
    const explicit = typeof params.context === "string" && params.context ? params.context : ""
    if (explicit) return explicit
    return lease(caller)
  }

  // -------------------------------------------------------------------------
  // Methods (the wire surface the kernel plugin forwards to)
  // -------------------------------------------------------------------------

  const evaluate = async (context: string, expression: string): Promise<unknown> => {
    const active = await ensure()
    const result = (await active.send("script.evaluate", {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: "none",
    })) as { result?: { value?: unknown } }
    return result?.result?.value
  }

  const safeParse = (value: unknown): unknown => {
    if (typeof value !== "string") return value
    try {
      return JSON.parse(value)
    } catch {
      return { text: value }
    }
  }

  const methods: Record<string, (caller: string, params: Record<string, unknown>) => Promise<unknown>> = {
    async status() {
      return {
        ready: !!client && !client.closed,
        upstream: mode,
        port: options.remotePort,
        endpoint,
        callers: leases.size,
        tabs: [...tabs.values()],
        ...(lastError ? { error: lastError } : {}),
      } satisfies BridgeStatus
    },
    async navigate(caller, params) {
      const context = await resolveContext(caller, params)
      return serialized(context, async () => {
        const active = await ensure()
        const url = String(params.url ?? "")
        const result = (await active.send("browsingContext.navigate", { context, url, wait: "complete" })) as { url?: string }
        const tab = tabs.get(context)
        if (tab) tabs.set(context, { ...tab, url: result?.url ?? url })
        // Loading the page is not the same as showing it. `browsingContext.activate` only selects the
        // tab inside Firefox, so when the browser window sits behind the app the user sees nothing
        // happen and reads the tool result as "it never opened a browser". Mark the tab active and
        // raise the OS window so a navigate actually surfaces what it loaded.
        await active.send("browsingContext.activate", { context }).catch(() => undefined)
        for (const [id, value] of tabs) tabs.set(id, { ...value, active: id === context })
        await raiseBrowserWindow()
        return { url: result?.url ?? url }
      })
    },
    async snapshot(caller, params) {
      const context = await resolveContext(caller, params)
      const value = await evaluate(
        context,
        `JSON.stringify({
          url: location.href,
          title: document.title,
          text: document.body ? document.body.innerText : "",
          links: Array.from(document.querySelectorAll("a[href]")).slice(0, 200).map((a) => ({ text: a.innerText, href: a.href })),
          forms: Array.from(document.querySelectorAll("form")).map((f) => ({ action: f.action, method: f.method })),
        })`,
      )
      const parsed = safeParse(value) as Record<string, unknown>
      return { ...parsed, tabs: [...tabs.values()], context }
    },
    async text(caller, params) {
      const context = await resolveContext(caller, params)
      const value = params.selector
        ? await evaluate(context, `(() => { const el = document.querySelector(${JSON.stringify(String(params.selector))}); return el ? el.innerText : null })()`)
        : await evaluate(context, "document.body ? document.body.innerText : ''")
      return typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value)
    },
    async source(caller, params) {
      const context = await resolveContext(caller, params)
      const value = await evaluate(context, "document.documentElement ? document.documentElement.outerHTML : ''")
      return typeof value === "string" ? value : ""
    },
    async evaluate(caller, params) {
      const context = await resolveContext(caller, params)
      const value = await evaluate(context, `JSON.stringify(${String(params.expression ?? "undefined")})`)
      return safeParse(value)
    },
    async click(caller, params) {
      const context = await resolveContext(caller, params)
      return serialized(context, async () => {
        const selector = String(params.selector ?? "")
        if (!selector) throw new Error("selector required")
        const value = await evaluate(
          context,
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return "missing"; el.click(); return "ok" })()`,
        )
        if (value === "missing") throw new Error(`selector not found: ${selector}`)
        return { ok: true }
      })
    },
    async fill(caller, params) {
      const context = await resolveContext(caller, params)
      return serialized(context, async () => {
        const value = await evaluate(
          context,
          `(() => { const el = document.querySelector(${JSON.stringify(String(params.selector ?? ""))}); if (!el) return "missing"; el.focus(); el.value = ${JSON.stringify(String(params.value ?? ""))}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return "ok" })()`,
        )
        if (value === "missing") throw new Error(`selector not found: ${String(params.selector ?? "")}`)
        return { ok: true }
      })
    },
    async press(caller, params) {
      const context = await resolveContext(caller, params)
      return serialized(context, async () => {
        const active = await ensure()
        const key = String(params.key ?? "")
        const KEYS: Record<string, string> = {
          Enter: "\uE007",
          Tab: "\uE004",
          Escape: "\uE00C",
          Backspace: "\uE003",
          ArrowDown: "\uE015",
          ArrowUp: "\uE013",
        }
        const value = key.length === 1 ? key : KEYS[key] || key
        await active.send("input.performActions", {
          context,
          actions: [{ type: "key", id: "kb", actions: [{ type: "keyDown", value }, { type: "keyUp", value }] }],
        })
        return { ok: true }
      })
    },
    async screenshot(caller, params) {
      const context = await resolveContext(caller, params)
      const active = await ensure()
      const result = (await active.send("browsingContext.captureScreenshot", { context })) as { data?: string }
      if (!result?.data) return { ok: false }
      const dir = join(configDir(), "screenshots")
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        /* best effort */
      }
      const file = join(dir, `shot-${Date.now()}.png`)
      writeFileSync(file, Buffer.from(result.data, "base64"))
      return { path: file }
    },
    async tabs(caller, params) {
      await ensure()
      const action = String(params.action ?? "list")
      if (action === "list") return { tabs: [...tabs.values()] }
      if (action === "new") {
        const context = await lease(caller)
        if (params.url) {
          const url = await methods.navigate(caller, { context, url: params.url })
          return { context, ...(url as object), tabs: [...tabs.values()] }
        }
        return { context, tabs: [...tabs.values()] }
      }
      const context = await resolveContext(caller, params)
      if (action === "close") {
        const active = await ensure()
        await active.send("browsingContext.close", { context })
        tabs.delete(context)
      } else if (action === "activate") {
        const active = await ensure()
        await active.send("browsingContext.activate", { context })
        for (const [id, tab] of tabs) tabs.set(id, { ...tab, active: id === context })
      }
      await refreshTabs()
      return { tabs: [...tabs.values()] }
    },
    async cookies(_caller, params) {
      const active = await ensure()
      const action = String(params.action ?? "get")
      if (action === "get") {
        const result = (await active.send("storage.getCookies", {})) as { cookies?: unknown[] }
        return { cookies: result?.cookies ?? [] }
      }
      if (action === "set") {
        await active.send("storage.setCookie", {
          cookie: {
            name: String(params.name ?? ""),
            value: { type: "string", value: String(params.value ?? "") },
            ...(params.domain ? { domain: String(params.domain) } : {}),
          },
        })
        return { ok: true }
      }
      if (action === "delete") {
        await active.send("storage.deleteCookies", { filter: { name: String(params.name ?? "") } })
        return { ok: true }
      }
      if (action === "clear") {
        await active.send("storage.deleteCookies", { filter: {} })
        return { ok: true }
      }
      throw new Error(`unknown cookies action: ${action}`)
    },
  }

  // -------------------------------------------------------------------------
  // Loopback HTTP surface
  // -------------------------------------------------------------------------

  const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let body = ""
      request.on("data", (chunk) => {
        body += chunk
        if (body.length > 8_000_000) reject(new Error("firefox.payloadTooLarge"))
      })
      request.on("end", () => resolve(body))
      request.on("error", reject)
    })

  const reply = (response: ServerResponse, code: number, value: unknown): void => {
    const body = JSON.stringify(value)
    response.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) })
    response.end(body)
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = request.url ?? "/"
    if (url === "/status" && request.method === "GET") {
      reply(response, 200, await methods.status("", {}))
      return
    }
    if (url !== "/call" || request.method !== "POST") {
      reply(response, 404, { error: "not found" })
      return
    }
    if (request.headers["x-wl-token"] !== token) {
      reply(response, 403, { error: "forbidden" })
      return
    }
    let payload: { caller?: unknown; method?: unknown; params?: unknown }
    try {
      payload = JSON.parse(await readBody(request))
    } catch {
      reply(response, 400, { error: "bad request" })
      return
    }
    const name = String(payload.method ?? "")
    const method = methods[name]
    if (!method) {
      reply(response, 404, { error: `unknown method: ${name}` })
      return
    }
    const caller = typeof payload.caller === "string" && payload.caller ? payload.caller : "anonymous"
    const params = (payload.params as Record<string, unknown> | undefined) ?? {}
    try {
      reply(response, 200, { ok: true, value: await method(caller, params) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A refused attach is a state a caller may retry after the user acts; keep it a normal reply.
      reply(response, 200, { ok: false, error: message })
    }
  }

  const writeDiscovery = (port: number) => {
    const payload = { version: 1, url: endpoint, port, token, pid: process.pid }
    try {
      mkdirSync(configDir(), { recursive: true })
      writeFileSync(discoveryPath(), JSON.stringify(payload, null, 2) + "\n", "utf8")
    } catch (error) {
      log("warn", "could not write bridge discovery file", { error: String(error) })
    }
  }

  return {
    /** Binds the loopback port and publishes the discovery file the kernel plugin reads. */
    async start(): Promise<BridgeStatus> {
      if (server) return this.status()
      token = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
      server = createServer((request, response) => {
        void handle(request, response).catch((error) =>
          reply(response, 500, { error: error instanceof Error ? error.message : String(error) }),
        )
      })
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject)
        server!.listen(0, "127.0.0.1", () => resolve())
      })
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      endpoint = `http://127.0.0.1:${port}`
      writeDiscovery(port)
      log("info", "firefox bridge service listening", { endpoint })
      // Attach eagerly when the user's Firefox is already up, so the first tool call has no wait.
      if (await portListening(options.remotePort)) {
        try {
          await ensure()
        } catch {
          /* status carries the reason; the call path reports it again */
        }
      }
      return this.status()
    },

    /** Ends the current upstream session (the clean way), then attaches again if a Firefox is up. */
    async reconnect(): Promise<BridgeStatus> {
      const previous = client
      client = undefined
      mode = "none"
      if (previous) {
        await previous.end().catch(() => undefined)
      }
      if (await portListening(options.remotePort)) {
        try {
          await ensure()
        } catch {
          /* status carries the reason */
        }
      }
      return this.status()
    },

    /** Ends the BiDi session (never a bare close) and stops the loopback server. */
    async stop(): Promise<void> {
      try {
        await client?.end()
      } catch {
        /* best effort */
      }
      client = undefined
      mode = "none"
      const active = server
      server = undefined
      if (active) await new Promise<void>((resolve) => active.close(() => resolve()))
      if (launched && launched.exitCode === null && launched.signalCode === null && launched.pid !== undefined) {
        try {
          spawn("taskkill", ["/F", "/T", "/PID", String(launched.pid)], { windowsHide: true })
        } catch {
          launched.kill()
        }
      }
      launched = undefined
      try {
        if (existsSync(discoveryPath())) writeFileSync(discoveryPath(), JSON.stringify({ version: 1, stopped: true }) + "\n", "utf8")
      } catch {
        /* the file is only a hint */
      }
    },

    status(): BridgeStatus {
      return {
        ready: !!client && !client.closed,
        upstream: mode,
        port: options.remotePort,
        endpoint,
        callers: leases.size,
        tabs: [...tabs.values()],
        ...(lastError ? { error: lastError } : {}),
      }
    },
  }
}

export type FirefoxBridge = ReturnType<typeof createFirefoxBridge>

/** Reads the discovery file a caller needs to reach the service; undefined when it is absent. */
export function readDiscovery(): { url: string; token: string; pid: number } | undefined {
  try {
    const raw = JSON.parse(readFileSync(discoveryPath(), "utf8"))
    if (typeof raw?.url !== "string" || typeof raw?.token !== "string") return undefined
    return { url: raw.url, token: raw.token, pid: Number(raw.pid ?? 0) }
  } catch {
    return undefined
  }
}
