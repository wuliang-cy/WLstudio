declare const WLSTUDIO_VERSION: string
declare const WLSTUDIO_CHANNEL: string
declare const WLSTUDIO_ARTIFACT: string

const version = typeof WLSTUDIO_VERSION === "string" ? WLSTUDIO_VERSION : "local"
const channel = typeof WLSTUDIO_CHANNEL === "string" ? WLSTUDIO_CHANNEL : "local"
const artifact = typeof WLSTUDIO_ARTIFACT === "string" ? WLSTUDIO_ARTIFACT : "cli"

export { version as WLSTUDIO_VERSION, channel as WLSTUDIO_CHANNEL, artifact as WLSTUDIO_ARTIFACT }
export const WLSTUDIO_LOCAL = channel === "local"
