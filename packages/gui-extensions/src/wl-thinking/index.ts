import { Schema } from "effect"
import { Extension, Store } from "../sdk"
import { ThinkingMonitor } from "./ipc"
import en from "./i18n/en"
import zh from "./i18n/zh"

/** Window and text opacity percentages, persisted so the overlay looks the same across restarts. */
const Prefs = Schema.Struct({ window: Schema.Number, text: Schema.Number })

export default Extension.define({
  id: "wl-thinking",
  provides: { monitor: ThinkingMonitor },
  stores: {
    prefs: Store.main(Prefs, { window: 86, text: 100 }),
  },
  i18n: { en, zh },
})
