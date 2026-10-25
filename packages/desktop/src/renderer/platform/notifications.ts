import type { Platform } from "@opencode/app/desktop"
import type { ElectronAPI } from "../api-types"

function appIconUrl() {
  try {
    return new URL("./wlstudio.png", location.href).toString()
  } catch {
    return "./wlstudio.png"
  }
}

export function createDesktopNotify(api: ElectronAPI): Platform["notify"] {
  return async (title, description, onClick) => {
    const focused = await api.getWindowFocused().catch(() => document.hasFocus())

    if (focused) return

    const notification = new Notification(title, {
      body: description ?? "",
      icon: appIconUrl(),
      silent: true,
    })

    notification.onclick = () => {
      void api.showWindow()
      void api.setWindowFocus()
      onClick?.()
      notification.close()
    }
  }
}
