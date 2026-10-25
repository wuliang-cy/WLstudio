import { NodeHttpClient } from "@effect/platform-node"
import { OpenCode } from "@opencode/client/effect"
import { BrowserWindow, screen } from "electron"
import { Effect, ManagedRuntime, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { ServerEndpoint } from "../sdk/main"
import type { MainSetup } from "../sdk/main"
import type definition from "./index"
import { ThinkingMonitor } from "./ipc"

type Status = "thinking" | "replying" | "idle" | "completed" | "interrupted"

type Session = { id: string; status: Status; text: string }

const WIDTH = 380
const HEIGHT = 148

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)))

// A frameless, click-through overlay: visible over full-screen apps without stealing input.
function createOverlay() {
  const { workArea } = screen.getPrimaryDisplay()
  const win = new BrowserWindow({
    x: workArea.x + workArea.width - WIDTH - 24,
    y: workArea.y + 24,
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  win.setAlwaysOnTop(true, "screen-saver")
  if (process.platform !== "win32") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(overlayHTML))
  return win
}

// `--bg-a` fades the card only, `--fg-a` fades its text, so the two controls stay independent.
const overlayHTML = `<!doctype html><html><head><meta charset="utf-8"><style>
:root { color-scheme: dark; --bg-a: 0.86; --fg-a: 1; }
html,body { margin:0; height:100%; background:transparent; overflow:hidden; font-family:"Segoe UI",system-ui,sans-serif; }
.card { height:100%; box-sizing:border-box; padding:10px 12px; border-radius:12px;
  background:rgba(18,20,28,var(--bg-a)); border:1px solid rgba(255,255,255,calc(.10 * var(--fg-a)));
  color:rgba(231,233,238,var(--fg-a)); display:flex; flex-direction:column; gap:6px; }
.head { display:flex; align-items:center; gap:6px; font-size:12px; font-weight:600; letter-spacing:.02em; }
.dot { width:8px; height:8px; border-radius:50%; background:#8b92a6; box-shadow:0 0 8px currentColor; }
.status { text-transform:uppercase; color:rgba(185,192,208,var(--fg-a)); }
.body { flex:1; min-height:0; overflow:hidden; font-size:12px; line-height:1.45;
  color:rgba(201,207,221,var(--fg-a)); white-space:pre-wrap; word-break:break-word;
  -webkit-mask-image:linear-gradient(to bottom,transparent,#000 14px); }
.pending { opacity:.5; font-style:italic; }
[data-status="thinking"] .dot { background:#a78bfa; }
[data-status="replying"] .dot { background:#60a5fa; }
[data-status="completed"] .dot { background:#34d399; }
[data-status="interrupted"] .dot { background:#f87171; }
[data-status="idle"] .dot { background:#6b7280; }
</style></head><body>
<div class="card" id="card" data-status="idle">
  <div class="head"><span class="dot"></span><span class="status" id="status"></span></div>
  <div class="body" id="body"><span class="pending" id="pending"></span></div>
</div>
<script>
window.__apply = function (state) {
  var card = document.getElementById("card");
  var status = document.getElementById("status");
  var body = document.getElementById("body");
  var pending = document.getElementById("pending");
  if (!card) return;
  card.setAttribute("data-status", state.status || "idle");
  status.textContent = state.label || "";
  if (state.text) {
    pending.style.display = "none";
    body.textContent = state.text;
  } else {
    pending.style.display = "";
    pending.textContent = state.pending || "";
    body.textContent = "";
    body.appendChild(pending);
  }
  body.scrollTop = body.scrollHeight;
};
window.__opacity = function (value) {
  document.documentElement.style.setProperty("--bg-a", String(value.window / 100));
  document.documentElement.style.setProperty("--fg-a", String(value.text / 100));
};
</script></body></html>`

const setup: MainSetup<typeof definition> = (ctx) => {
  let win: BrowserWindow | undefined
  let target: string | undefined
  let endpoint: ServerEndpoint | undefined
  const state: Session = { id: "", status: "idle", text: "" }
  const runtime = ManagedRuntime.make(NodeHttpClient.layerNodeHttp)
  const prefs = ctx.stores.prefs

  const labels = (status: Status) =>
    ({
      thinking: ctx.t("overlay.thinking"),
      replying: ctx.t("overlay.replying"),
      idle: ctx.t("overlay.idle"),
      completed: ctx.t("overlay.completed"),
      interrupted: ctx.t("overlay.interrupted"),
    })[status]

  const opacity = () => ({ window: clamp(prefs.value.window), text: clamp(prefs.value.text) })

  const paintOpacity = () => {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    void win.webContents
      .executeJavaScript(`window.__opacity && window.__opacity(${JSON.stringify(opacity())})`)
      .catch(() => undefined)
  }

  const paint = () => {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    const payload = JSON.stringify({
      status: state.status,
      text: state.text,
      label: labels(state.status),
      pending: ctx.t("overlay.waiting"),
    })
    // Runs before load on the first paint; the page applies the latest state on did-finish-load.
    void win.webContents
      .executeJavaScript(`window.__apply && window.__apply(${payload})`)
      .catch(() => undefined)
  }

  const ensure = () => {
    if (win && !win.isDestroyed()) return win
    win = createOverlay()
    win.on("closed", () => (win = undefined))
    win.webContents.on("did-finish-load", () => {
      paintOpacity()
      paint()
    })
    return win
  }

  const client = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const server = endpoint
        if (!server) throw new Error("wl-thinking.endpoint.unavailable")
        return yield* OpenCode.make({ baseUrl: server.url }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            Object.keys(server.headers).length
              ? HttpClient.mapRequest(http, HttpClientRequest.setHeaders(server.headers))
              : http,
          ),
        )
      }),
    )

  // The latest reasoning part still streaming decides the initial overlay state, so opening the
  // monitor never invents activity that is not there.
  const snapshot = () => {
    void Promise.try(async () => {
      const opencode = await client()
      const active = await runtime.runPromise(opencode.session.active())
      const running = target ? Object.keys(active).includes(target) : false
      state.status = running ? "thinking" : "idle"
      state.text = ""
      paint()
    }).catch((error) => ctx.log.write("warn", "thinking monitor snapshot failed", { error: String(error) }))
  }

  const apply = (event: { type: string; data: Record<string, unknown> }) => {
    const data = event.data
    if (typeof data.sessionID !== "string" || data.sessionID !== target) return
    switch (event.type) {
      case "session.reasoning.started":
        state.status = "thinking"
        state.text = ""
        break
      case "session.reasoning.delta":
        state.status = "thinking"
        state.text += typeof data.delta === "string" ? data.delta : ""
        break
      case "session.reasoning.ended":
        state.status = "thinking"
        state.text = typeof data.text === "string" ? data.text : state.text
        break
      case "session.text.started":
        state.status = "replying"
        break
      case "session.execution.succeeded":
        state.status = "completed"
        break
      case "session.execution.interrupted":
      case "session.execution.failed":
        state.status = "interrupted"
        break
      default:
        return
    }
    paint()
  }

  let started = false
  const start = async () => {
    if (started) return
    endpoint = ctx.serverEndpoints.get("sidecar")
    if (!endpoint) return
    started = true
    const opencode = await client()
    await runtime.runPromise(
      opencode.event.subscribe().pipe(Stream.runForEach((event) => Effect.sync(() => apply(event)))),
    )
  }

  const show = (session: string) => {
    target = session
    state.id = session
    state.status = "idle"
    state.text = ""
    const overlay = ensure()
    overlay.showInactive()
    overlay.setAlwaysOnTop(true, "screen-saver")
    overlay.moveTop()
    paintOpacity()
    paint()
    snapshot()
    void start().catch((error) => ctx.log.write("warn", "thinking monitor stream failed", { error: String(error) }))
  }

  const provider = ctx.provide(ThinkingMonitor, {
    state: () => ({ shown: !!win && !win.isDestroyed() && win.isVisible(), ...opacity() }),
    toggle: ({ session }) => {
      if (win && !win.isDestroyed() && win.isVisible() && target === session) {
        win.hide()
        provider.changed()
        return false
      }
      show(session)
      provider.changed()
      return true
    },
    hide: () => {
      if (win && !win.isDestroyed()) win.hide()
      provider.changed()
      return false
    },
    setOpacity: ({ window, text }) => {
      const next = { window: clamp(window), text: clamp(text) }
      prefs.set(next)
      paintOpacity()
      return next
    },
  })

  ctx.scope.addFinalizer(() => {
    provider.dispose()
    if (win && !win.isDestroyed()) win.destroy()
    void runtime.dispose()
  })
}

export default setup
