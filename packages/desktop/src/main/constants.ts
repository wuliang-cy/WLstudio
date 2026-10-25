import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"

const raw = import.meta.env.WLSTUDIO_CHANNEL

export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.WLSTUDIO_VERSION ?? app.getVersion())

const appNames: Record<string, string> = {
  dev: "WLstudio Dev",
  beta: "WLstudio Beta",
  prod: "WLstudio",
}

const appIDs: Record<string, string> = {
  dev: "com.wlstudio.desktop.dev",
  beta: "com.wlstudio.desktop.beta",
  prod: "com.wlstudio.desktop",
}

// Local renderer/server mode keeps the dev application identity.
export const APP_NAME = app.isPackaged ? appNames[CHANNEL] : "WLstudio Dev"

export const APP_ID = app.isPackaged ? appIDs[CHANNEL] : "com.wlstudio.desktop.dev"
