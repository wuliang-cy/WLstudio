/**
 * Finds and launches a Firefox build that can speak WebDriver BiDi, in the desktop main process.
 *
 * Modern Firefox ships the remote agent: `--remote-debugging-port <port>` exposes a browser-level
 * BiDi endpoint at `ws://127.0.0.1:<port>/session`. We probe known install locations, preferring the
 * Developer Edition the user runs day to day, then fall back to a `PATH` lookup.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { createConnection, createServer } from "node:net"
import { join } from "node:path"

// The Firefox the installer deploys into the user's own LOCALAPPDATA, kept apart from any Firefox
// the user already has. Tried first so the managed instance uses the bundled build when present.
const BUNDLED_CANDIDATES =
  process.platform === "win32" && process.env.LOCALAPPDATA
    ? [join(process.env.LOCALAPPDATA, "WLstudio", "firefox", "firefox.exe")]
    : []

const WINDOWS_CANDIDATES = [
  "C:/Program Files/Firefox Developer Edition/firefox.exe",
  "C:/Program Files/Mozilla Firefox/firefox.exe",
  "C:/Program Files (x86)/Mozilla Firefox/firefox.exe",
]

const MAC_CANDIDATES = [
  "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
  "/Applications/Firefox.app/Contents/MacOS/firefox",
]

const LINUX_CANDIDATES = ["/usr/bin/firefox", "/usr/bin/firefox-developer-edition", "/snap/bin/firefox"]

const ENV_CANDIDATES = [
  process.env.WLSTUDIO_FIREFOX,
  process.env.FIREFOX_PATH,
  process.env.FIREFOX_DEVELOPER_EDITION_PATH,
].filter((value): value is string => typeof value === "string" && value.length > 0)

export function findFirefox(): string | undefined {
  const candidates =
    process.platform === "win32" ? WINDOWS_CANDIDATES : process.platform === "darwin" ? MAC_CANDIDATES : LINUX_CANDIDATES
  return [...ENV_CANDIDATES, ...BUNDLED_CANDIDATES, ...candidates].find((path) => existsSync(path))
}

/** The profile the installer pre-created for the bundled bridge browser, if it exists. */
export function bundledProfile(): string | undefined {
  const path = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "WLstudio", "firefox-profile")
    : undefined
  return path && existsSync(path) ? path : undefined
}

/** A free loopback port for the remote agent; released immediately for Firebase to bind. */
export function allocatePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("browser.firefox.port"))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

export type FirefoxLaunch = {
  readonly process: ChildProcess
  readonly url: string
  readonly port: number
  stop(): Promise<void>
}

/**
 * Launches Firefox with the remote agent enabled on a dedicated profile directory. `-no-remote`
 * keeps the instance detached from a running Firefox so we never attach to the user's session.
 */
export async function launchFirefox(input: {
  binary: string
  profile: string
  port: number
  url?: string
  signal?: AbortSignal
}): Promise<FirefoxLaunch> {
  const args = [
    "-no-remote",
    "-profile",
    input.profile,
    "--remote-debugging-port",
    String(input.port),
    input.url ?? "about:blank",
  ]
  const child = spawn(input.binary, args, { detached: process.platform !== "win32", stdio: "ignore", windowsHide: false })
  const exited = new Promise<never>((_, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => reject(new Error(`browser.firefox.exited:${code ?? "null"}`)))
  })
  const abort = new Promise<never>((_, reject) => input.signal?.addEventListener("abort", () => reject(new Error("browser.firefox.aborted")), { once: true }))

  // The endpoint accepts connections only once the remote agent is up; the caller retries the
  // WebSocket handshake while `exited`/`abort` guard against a process that died or was cancelled.
  await Promise.race([waitForPort(input.port, input.signal), exited, abort]).catch(async (error) => {
    await stop(child)
    throw error
  })

  return {
    process: child,
    url: `ws://127.0.0.1:${input.port}/session`,
    port: input.port,
    stop: () => stop(child),
  }
}

async function waitForPort(port: number, signal?: AbortSignal) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !signal?.aborted) {
    if (await reachable(port)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  if (signal?.aborted) throw new Error("browser.firefox.aborted")
  throw new Error("browser.firefox.timeout")
}

// The remote agent has no HTTP surface other than the WebSocket upgrade, so this is a raw TCP dial:
// a successful connect means something is listening on the port.
function reachable(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    const done = (value: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    socket.setTimeout(1_000, () => done(false))
  })
}

function stop(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    child.once("exit", () => resolve())
    try {
      if (process.platform === "win32") spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true })
      else child.kill("SIGTERM")
    } catch {
      child.kill()
    }
  })
}

/** The default per-user profile directory for the WLstudio-managed Firefox instance. */
export function managedProfile(userData: string) {
  return join(userData, "wlstudio-firefox")
}

/**
 * The port the bridge looks for a user-run Firefox on. A shortcut that launches Firefox with
 * `--remote-debugging-port 9222` lets us attach to the browser the user already has open instead of
 * starting a second one. Override with `WLSTUDIO_BROWSER_PORT`.
 */
export const defaultRemotePort = 9222

export function configuredRemotePort() {
  const raw = Number(process.env.WLSTUDIO_BROWSER_PORT)
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : defaultRemotePort
}

/** Whether something is listening on the loopback port; a fast pre-check before a WebSocket dial. */
export function portListening(port: number) {
  return reachable(port)
}
