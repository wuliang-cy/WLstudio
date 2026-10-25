import path from "node:path"
import { WLSTUDIO_CHANNEL } from "./version"

export function databasePath(data: string) {
  const filename =
    process.env.WLSTUDIO_DB ??
    (["latest", "dev", "beta", "next", "prod"].includes(WLSTUDIO_CHANNEL) ||
    process.env.WLSTUDIO_DISABLE_CHANNEL_DB === "1" ||
    process.env.WLSTUDIO_DISABLE_CHANNEL_DB === "true"
      ? "wlstudio.db"
      : `wlstudio-${WLSTUDIO_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
