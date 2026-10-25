import { Schema } from "effect"
import { Ipc } from "../sdk"

/** Window and text opacity, each a percentage from 0 (invisible) to 100 (opaque). */
export const Opacity = Schema.Struct({
  window: Schema.Number,
  text: Schema.Number,
})

/**
 * The thinking-monitor overlay, owned by the desktop main process. A window toggles the always-on-top
 * overlay for one session and adjusts how transparent its card and its text are.
 */
export const ThinkingMonitor = Ipc.define({
  id: "wl-thinking",
  methods: {
    toggle: {
      input: Schema.Struct({ session: Schema.String }),
      output: Schema.Boolean,
    },
    hide: {
      output: Schema.Boolean,
    },
    setOpacity: {
      input: Opacity,
      output: Opacity,
    },
  },
  state: Schema.Struct({
    shown: Schema.Boolean,
    window: Schema.Number,
    text: Schema.Number,
  }),
})
