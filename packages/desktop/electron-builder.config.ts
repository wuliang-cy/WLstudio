import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { CustomMacSignOptions } from "app-builder-lib"
import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)

const packageDir = path.dirname(fileURLToPath(import.meta.url))

const rootDir = path.resolve(packageDir, "../..")

const signScript = path.join(rootDir, "script", "sign-windows.ps1")

// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")

const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return

  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir, windowsHide: true },
  )
}

function macSignOptions(options: CustomMacSignOptions): CustomMacSignOptions {
  return {
    ...options,
    optionsForFile: (file) => {
      const defaults = options.optionsForFile?.(file)

      if (file !== path.join(options.app, "Contents/Resources/wlstudio-cli")) return defaults ?? {}

      // The Bun CLI loads bun-pty's native library; Electron and its helpers do not need this exception.
      return { ...defaults, entitlements: path.join(packageDir, "resources/entitlements.cli.plist") }
    },
  }
}

const channel = (() => {
  const raw = process.env.WLSTUDIO_CHANNEL

  if (raw === "dev" || raw === "beta" || raw === "prod") return raw

  if (raw === "latest") return "prod"

  return "dev"
})()

const APP_IDS = {
  dev: "com.wlstudio.desktop.dev",
  beta: "com.wlstudio.desktop.beta",
  prod: "com.wlstudio.desktop",
} as const

const getBase = (appId: string): Configuration => ({
  // The version belongs in the file name: every build gets its own artifact, so a browser or CDN
  // never serves a stale copy under a name that looks current.
  artifactName: "wlstudio-desktop-${version}-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: [
    "out/**/*",
    "resources/**/*",
    "!resources/wlstudio-cli*",
    // Legacy 1.14.x kernel left over from before the rename. Nothing loads it (the desktop spawns
    // `wlstudio-cli` from extraResources), but the `resources/**/*` glob above swept it into the
    // asar, adding ~218 MB of dead weight to every installer.
    "!resources/opencode-cli*",
    // The bundled Firefox installer is deployed as an extra resource, not into the asar.
    "!resources/windows/firefox-devedition-setup.exe",
    // The install-time seed is deployed via extraResources, not into the asar.
    "!resources/seed{,/**/*}",
    // Maintenance scripts are deployed via extraResources, not into the asar.
    "!resources/tools{,/**/*}",
    // License texts are deployed via extraResources, not into the asar.
    "!resources/licenses{,/**/*}",
    // Log export imports Zip.js as ESM. Keep index.js and lib, including its inline worker.
    "!**/node_modules/@zip.js/zip.js/dist{,/**/*}",
    "!**/node_modules/@zip.js/zip.js/{index.cjs,index.min.js,index-fflate.js,deno.json,eslint.config.mjs}",
    // Nothing executes type declarations or source maps, and every entry costs startup time: the
    // main process parses the whole asar header before it runs any JavaScript.
    "!**/node_modules/**/*.d.{ts,cts,mts}",
    "!**/node_modules/**/*.d.{ts,cts,mts}.map",
    "!**/node_modules/**/*.{js,cjs,mjs}.map",
    // These packages execute compiled JavaScript, not their sources.
    "!**/node_modules/ajv/lib{,/**/*}",
    "!**/node_modules/ajv-formats/src{,/**/*}",
    // Keep js-yaml's CommonJS sources and dist/js-yaml.mjs ESM entry, not browser bundles or its CLI.
    "!**/node_modules/js-yaml/dist/{js-yaml.js,js-yaml.min.js,*.map}",
    "!**/node_modules/js-yaml/bin{,/**/*}",
  ],
  extraResources: [
    {
      from: "resources/",
      to: "",
      filter: ["wlstudio-cli", "wlstudio-cli.exe", "wlstudio-cli.version"],
    },
    {
      from: "resources/windows/firefox-devedition-setup.exe",
      to: "windows/firefox-devedition-setup.exe",
    },
    // Maintenance scripts shipped alongside the app: the one-click uninstaller used
    // when testing a deployment on a server (no Start Menu entry required).
    {
      from: "resources/tools",
      to: "tools",
    },
    // Installation-time seed: preferences, plugins, commands, scripts and an empty
    // experience folder, materialized into the user's home on first launch.
    {
      from: "resources/seed",
      to: "seed",
    },
    // License and attribution texts. The MIT license this app is derived from requires the
    // copyright notice *and* the permission notice to travel with every distributed copy, and
    // the bundled Firefox installer carries its own attribution obligations.
    {
      from: "resources/licenses",
      to: "licenses",
    },
  ],
  afterPack: async (context) => {
    const cli = path.join(
      context.packager.getResourcesDir(context.appOutDir),
      context.electronPlatformName === "win32" ? "wlstudio-cli.exe" : "wlstudio-cli",
    )

    const file = await stat(cli)

    if (!file.isFile() || file.size === 0) throw new Error(`Bundled CLI must be a non-empty file: ${cli}`)
    const version = path.join(path.dirname(cli), "wlstudio-cli.version")

    if ((await stat(version)).size === 0) throw new Error(`Bundled CLI version must be a non-empty file: ${version}`)
  },
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    extendInfo: {
      NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac: true,
    },
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    sign: async (options) => {
      const { sign } = await import("app-builder-lib/out/codeSign/macCodeSign")
      await sign(macSignOptions(options))
    },
    notarize: true,
    target: ["dmg", "zip"],
  },
  protocols: {
    name: "WLstudio",
    schemes: ["wlstudio"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    include: path.join(packageDir, "resources", "windows", "installer.nsh"),
    // An assisted installer shows the custom page where the user opts into the bundled
    // bridge browser; a one-click install has no page to opt in on.
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "WLstudio Dev",
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "wlstudio-dev", fpm: [metainfoFpm(appId)] },
      }
    }

    case "beta": {
      return {
        ...base,
        appId,
        productName: "WLstudio Beta",
        protocols: { name: "WLstudio Beta", schemes: ["wlstudio"] },
        publish: {
          provider: "generic",
          // WLstudio publishes its own installers. Never point this at opencode.ai: that feed serves an
          // `OpenCode` build, so the updater would replace WLstudio with upstream.
          url: "https://wlstudio.invalid/update/api/beta/desktop/wlstudio/",
          channel: "latest",
        },
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "wlstudio-beta", fpm: [metainfoFpm(appId)] },
      }
    }

    case "prod": {
      return {
        ...base,
        appId,
        productName: "WLstudio",
        protocols: { name: "WLstudio", schemes: ["wlstudio"] },
        publish: {
          provider: "generic",
          // WLstudio publishes its own installers. Never point this at opencode.ai: that feed serves an
          // `OpenCode` build, so the updater would replace WLstudio with upstream.
          url: "https://wlstudio.invalid/update/api/latest/desktop/wlstudio/",
          channel: "latest",
        },
        deb: { fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
        rpm: { packageName: "wlstudio", fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
