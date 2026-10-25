interface ImportMetaEnv {
  readonly WLSTUDIO_CHANNEL: string
  readonly WLSTUDIO_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
