import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { MainSetup } from "../sdk/main"
import type definition from "./index"
import { createFirefoxBridge } from "./bridge"
import { BrowserBridge, type BrowserMode, type ControllerState } from "./ipc"
import { bundledProfile, configuredRemotePort, findFirefox, portListening } from "./firefox"

/**
 * The browser bridge **owner and controller**, in the desktop main process.
 *
 * It holds the single WebDriver BiDi session to the user's Firefox (`createFirefoxBridge`) and
 * publishes a loopback endpoint the kernel plugin forwards its `firefox.*` calls to. Because the
 * desktop shell outlives every kernel, a kernel restart no longer leaks Firefox's single session
 * slot. Because the session is one process-level singleton with per-tab command queues, several
 * sessions can drive the same browser concurrently without fighting over a page.
 *
 * The controller also keeps the user's choice in `~/.config/wlstudio/wl-browser.json` and can open
 * a Firefox with the remote agent when the user asks for one.
 */
const DEFAULT_KEYWORDS = [
  "打开浏览器",
  "打开火狐",
  "浏览器",
  "火狐",
  "搜索",
  "访问网址",
  "打开网站",
  "网页",
  "打开页面",
  "browser",
  "firefox",
]

function configDir() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "wlstudio")
}

function settingsPath() {
  return join(configDir(), "wl-browser.json")
}

function readSettings(): { mode: BrowserMode; keywords: string[] } {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf8"))
    return {
      mode: (["auto", "bridge", "builtin"] as const).includes(raw?.mode) ? raw.mode : "auto",
      keywords: Array.isArray(raw?.keywords) && raw.keywords.length ? raw.keywords : DEFAULT_KEYWORDS,
    }
  } catch {
    return { mode: "auto", keywords: DEFAULT_KEYWORDS }
  }
}

function writeSettings(settings: { mode: BrowserMode; keywords: string[] }) {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + "\n", "utf8")
}

const setup: MainSetup<typeof definition> = (ctx) => {
  const port = configuredRemotePort()
  const bridge = createFirefoxBridge({
    remotePort: port,
    // Start Firefox ourselves when nothing is listening. The installer already put the bundled
    // Developer Edition at a known path (see findFirefox), so "open the browser" does not need the
    // user to launch it by hand first. Opt out with WLSTUDIO_BROWSER_AUTOLAUNCH=0.
    autolaunch: process.env.WLSTUDIO_BROWSER_AUTOLAUNCH !== "0",
    log: (level, message, data) => ctx.log.write(level, message, data),
  })
  let launched: ChildProcess | undefined
  let owned = false
  let launching = false
  let lastError: string | undefined

  const snapshot = async (): Promise<ControllerState> => {
    const listening = await portListening(port)
    const settings = readSettings()
    const status = bridge.status()
    return {
      mode: settings.mode,
      keywords: settings.keywords,
      listening,
      owned: owned && listening,
      launching,
      ready: status.ready,
      upstream: status.upstream,
      callers: status.callers,
      tabs: status.tabs.map((tab) => ({ ...tab })),
      endpoint: status.endpoint,
      ...(lastError ? { error: lastError } : {}),
    }
  }

  const publish = async () => {
    const state = await snapshot()
    provider.emit("changed", state)
    return state
  }

  const provider = ctx.provide(BrowserBridge, {
    state: () => ({
      mode: readSettings().mode,
      keywords: readSettings().keywords,
      listening: false,
      owned,
      launching,
      ready: bridge.status().ready,
      upstream: bridge.status().upstream,
      callers: bridge.status().callers,
      tabs: bridge.status().tabs.map((tab) => ({ ...tab })),
      endpoint: bridge.status().endpoint,
      ...(lastError ? { error: lastError } : {}),
    }),
    setMode: async ({ mode }) => {
      const settings = readSettings()
      writeSettings({ mode, keywords: settings.keywords })
      lastError = undefined
      return publish()
    },
    setKeywords: async ({ keywords }) => {
      const settings = readSettings()
      writeSettings({ mode: settings.mode, keywords: [...keywords] })
      return publish()
    },
    launch: async () => {
      if (launching) return publish()
      if (await portListening(port)) {
        lastError = undefined
        return publish()
      }
      const binary = findFirefox()
      if (!binary) {
        lastError = ctx.t("error.noFirefox")
        return publish()
      }
      launching = true
      lastError = undefined
      try {
        const profile = bundledProfile() ?? join(configDir(), "firefox-profile")
        try {
          mkdirSync(profile, { recursive: true })
        } catch {
          /* best effort */
        }
        const child = spawn(binary, ["-no-remote", "-profile", profile, "--remote-debugging-port", String(port), "about:blank"], {
          detached: false,
          stdio: "ignore",
          windowsHide: false,
        })
        launched = child
        owned = true
        child.once("exit", () => {
          if (launched === child) {
            launched = undefined
            owned = false
          }
        })
        // Wait (bounded) for the remote agent to come up so the UI can flip to "listening".
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline && !(await portListening(port))) {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      } catch (cause) {
        lastError = cause instanceof Error ? cause.message : String(cause)
      } finally {
        launching = false
      }
      return publish()
    },
    stop: async () => {
      const child = launched
      launched = undefined
      owned = false
      if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve())
          try {
            if (process.platform === "win32") spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true })
            else child.kill("SIGTERM")
          } catch {
            child.kill()
          }
        })
      }
      return publish()
    },
    reconnect: async () => {
      await bridge.reconnect()
      return publish()
    },
    refresh: () => publish(),
  })

  ctx.scope.addFinalizer(() => {
    provider.dispose()
  })

  // Start the shared service, and tear it down with a clean `session.end` so it leaves no leak.
  void bridge
    .start()
    .catch((cause) => ctx.log.write("error", "firefox bridge failed to start", { error: String(cause) }))
    .then(() => publish())
  ctx.scope.addFinalizer(() => bridge.stop())

  // The built-in browser extension reads this state (through the same Ipc) to decide whether it may attach: while
  // the mode targets the user's Firefox, attaching there would grant the `browser` permission and reveal its 45
  // tools beside `firefox.*`. Keep `listening` fresh so a Firefox the user opens or closes is noticed on its own.
  const poll = setInterval(() => void publish(), 8_000)
  ctx.scope.addFinalizer(() => clearInterval(poll))
}

export default setup
