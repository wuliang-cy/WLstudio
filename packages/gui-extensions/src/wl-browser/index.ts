import { Extension } from "../sdk"
import en from "./i18n/en"
import zh from "./i18n/zh"
import { BrowserBridge } from "./ipc"

export default Extension.define({
  id: "wl-browser",
  provides: { bridge: BrowserBridge },
  i18n: { en, zh },
})
