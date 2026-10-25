import type { ElectronNative } from "../preload/types"

declare global {
  interface ImportMetaEnv {
    readonly WLSTUDIO_TEST_ONBOARDING: boolean
  }

  interface Window {
    electron: ElectronNative
    __WLSTUDIO__?: {
      deepLinks?: string[]
    }
  }
}
