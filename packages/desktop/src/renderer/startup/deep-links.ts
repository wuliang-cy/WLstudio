import type { ElectronAPI } from "../api-types"

const deepLinkEvent = "wlstudio:deep-link"

export function startDeepLinks(api: ElectronAPI) {
  void api.consumeInitialDeepLinks().then(emitDeepLinks)
  api.onDeepLink(emitDeepLinks)
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  window.__WLSTUDIO__ ??= {}
  window.__WLSTUDIO__.deepLinks = [...(window.__WLSTUDIO__.deepLinks ?? []), ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}
