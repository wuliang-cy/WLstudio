import { Schema } from "effect"
import { Ipc } from "../sdk"

/**
 * The browser bridge **controller and owner**. The desktop main process holds the single WebDriver
 * BiDi session to the user's Firefox (see `bridge.ts`) and exposes the `firefox.*` tools to the
 * kernel over a loopback endpoint; the kernel plugin only forwards calls. This Ipc therefore
 * reports both the user's choice (mode/keywords) and the live bridge (ready/callers/tabs).
 */
export const BrowserMode = Schema.Literals(["auto", "bridge", "builtin"])
export type BrowserMode = typeof BrowserMode.Type

/** One tab the bridge tracks; the unit of concurrency isolation between callers. */
export const BridgeTab = Schema.Struct({
  context: Schema.String,
  url: Schema.String,
  title: Schema.String,
  active: Schema.Boolean,
})

export type BridgeTab = typeof BridgeTab.Type

export const ControllerState = Schema.Struct({
  /** Which browser the model should use: auto (decide per prompt), bridge (firefox), builtin (chromium). */
  mode: BrowserMode,
  /** Prompt words that switch the `auto` mode to Firefox when no browser is listening yet. */
  keywords: Schema.Array(Schema.String),
  /** Whether something answers on the remote-debugging port (the user's Firefox is reachable). */
  listening: Schema.Boolean,
  /** Whether this controller launched the Firefox currently on that port (so it may stop it). */
  owned: Schema.Boolean,
  /** The Firefox this controller started, when it started one. */
  launching: Schema.Boolean,
  /** Whether the shared bridge currently holds a WebDriver BiDi session. */
  ready: Schema.Boolean,
  /** How the session was obtained: attached to the user's Firefox, or one this app launched. */
  upstream: Schema.Literals(["attached", "managed", "none"]),
  /** How many callers (kernel sessions) hold a tab lease. */
  callers: Schema.Number,
  /** The tabs the bridge tracks. */
  tabs: Schema.Array(BridgeTab),
  /** The loopback endpoint callers use, when the service is up. */
  endpoint: Schema.String,
  error: Schema.optionalKey(Schema.String),
})

export type ControllerState = typeof ControllerState.Type

export const BrowserBridge = Ipc.define({
  id: "wl-browser",
  state: ControllerState,
  methods: {
    setMode: { input: Schema.Struct({ mode: BrowserMode }), output: ControllerState },
    setKeywords: { input: Schema.Struct({ keywords: Schema.Array(Schema.String) }), output: ControllerState },
    launch: { output: ControllerState },
    stop: { output: ControllerState },
    /** Ends the current upstream session (the clean way) and attaches again. */
    reconnect: { output: ControllerState },
    refresh: { output: ControllerState },
  },
  events: {
    changed: ControllerState,
  },
})
