// First-launch seed materialization.
//
// The packaged app ships a `seed/` directory in its resources (outside the asar).
// On the first real launch we copy that seed into the user's home in an
// "installation" style: anything the user has already customized is preserved,
// so re-installing or upgrading never clobbers user data (preferences, plugins,
// experience files). Nothing here runs in tests or when the app is not packaged.
//
// This is what makes the installer feel "one-click": the user gets working
// preferences, plugins and an empty experience folder with no post-install
// script, and later upgrades only replace the app itself.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { app } from "electron"

function xdgConfigRoot() {
  const value = process.env.XDG_CONFIG_HOME
  return value && value.length > 0 ? value : path.join(homeRoot(), ".config")
}

// Match the kernel's home resolution (see packages/util Global): honour the test override so an
// isolated run never writes into the real user profile.
function homeRoot() {
  return process.env.WLSTUDIO_TEST_HOME ?? homedir()
}

/** Every seed target, plus whether the seed step should run at all. */
export function seedTargets() {
  const home = homeRoot()
  const resources = process.resourcesPath ?? ""
  return {
    seedRoot: path.join(resources, "seed"),
    configDir: path.join(xdgConfigRoot(), "wlstudio"),
    home,
    seDir: path.join(home, "WLstudio SE"),
    // The experience library grows without bound and must survive reinstalls, so it lives next to
    // the installation (same volume, roomy) instead of the user profile on C:. The installer
    // records the chosen location in WLSTUDIO_DATA; `dataDir()` falls back for portable/dev runs.
    exBagsDir: path.join(dataDir(), "ex-bags"),
  }
}

export type SeedTargets = ReturnType<typeof seedTargets>

/** The three paths the shipped preference files may mention. */
export type PathTargets = { exBagsDir: string; seDir: string; home: string }

/**
 * Root of user data that outlives the installation: experience library and handover notes.
 * Honours `WLSTUDIO_DATA` (written by the installer for the selected install volume) and falls
 * back to a sibling `WLstudio-data` directory next to the executable.
 */
/**
 * Where the experience library and database live.
 *
 * The installer records the root it managed to create in `WLSTUDIO_DATA`, so that is authoritative.
 * Without it (portable run, dev build, or a user who cleared the variable) fall back the same way
 * the installer searches: beside the install volume first, then under `%APPDATA%`. A drive letter is
 * never assumed — a machine may have only `C:`, and a per-user install cannot write a system drive
 * root at all.
 */
/**
 * Where mutable data (the experience library) lives.
 *
 * The installer records `WLSTUDIO_DATA`, and that is always the answer when it is set. The
 * fallbacks exist for a launch without the installer (a dev checkout, or a machine where the
 * variable was cleared), and they must land on the same directory the installer would have
 * chosen: `<install>\WLstudio-data`, next to the executable. A drive letter is never assumed,
 * because a machine may only have `C:` and a per-user install cannot write a drive root.
 *
 * After an uninstall the library is rescued to `%APPDATA%\WLstudio-data`, and that rescue sets
 * `WLSTUDIO_DATA` to match, so the next install picks it back up rather than starting empty.
 */
export function dataDir() {
  const configured = process.env.WLSTUDIO_DATA
  if (configured && configured.length > 0) return configured
  const exe = process.execPath
  if (exe && exe.length > 0) {
    const beside = path.join(path.dirname(exe), "WLstudio-data")
    try {
      mkdirSync(beside, { recursive: true })
      return beside
    } catch {}
  }
  const roaming = process.env.APPDATA
  if (roaming && roaming.length > 0) return path.join(roaming, "WLstudio-data")
  return path.join(homeRoot(), "WLstudio-data")
}

function isDirectory(value: string) {
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

// The seed preferences describe conventions plus a few concrete locations. The author's paths are
// never shipped; the file is written with this machine's real paths at seed time, and
// `migratePreferences` rewrites them later if the install volume changes. Keeping the actual path
// (rather than an environment variable) means the model can read and act on it directly, and a
// human opening AGENTS.md sees where things really are.
function renderPreferences(text: string, targets: PathTargets) {
  return text
    .replaceAll("__WLSTUDIO_EXBAGS__", targets.exBagsDir)
    .replaceAll("__WLSTUDIO_SE_DIR__", targets.seDir)
    .replaceAll("__WLSTUDIO_WORKSPACE__", targets.home)
    .replaceAll("__WLSTUDIO_HOME__", targets.home)
    // The database lives next to the experience library, not in the home directory, so it needs its
    // own placeholder. Leaving it unrendered shipped a literal `__WLSTUDIO_DBDIR__` to users.
    .replaceAll("__WLSTUDIO_DBDIR__", path.dirname(targets.exBagsDir))
}

// Any spelling an older build may have written for the same two locations. Rewriting these makes
// upgrades self-healing: a user who installed to C:\ once and later to E:\ does not keep a stale
// pointer, and no repack is needed to correct it.
const LEGACY_EXBAGS = ["%WLSTUDIO_DATA%\\ex-bags", "__WLSTUDIO_EXBAGS__"]
const LEGACY_SE = ["__WLSTUDIO_SE_DIR__"]
// Only placeholders belong here. A hard-coded absolute path would be substituted into files the
// user wrote themselves: the migration cannot tell an author's development directory from a
// legitimate user path, and rewriting a user's own notes is never intended.
const LEGACY_HOME = ["__WLSTUDIO_WORKSPACE__", "__WLSTUDIO_HOME__"]

// Every data root an earlier build could have rendered into `AGENTS.md`. Releases before the
// drive-root change wrote `<install>\..\WLstudio-data`, which for the per-user default is
// `%LOCALAPPDATA%\Programs\WLstudio-data`; older ones used the home directory instead. A fixed
// list cannot cover a user-chosen install path, so the actual directory is matched by shape too.
const LEGACY_DATA_DIRS = ["%WLSTUDIO_DATA%", "E:\\WLstudio-data", "C:\\WLstudio-data"]
// `<anything>\WLstudio-data` or `<anything>/WLstudio-data`, keeping the matched text so it can be
// swapped for the current root. Anchored on a drive letter or UNC prefix to avoid matching prose.
const DATA_DIR_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+[\\/])(?:[^\\/\r\n"`]*[\\/])*WLstudio-data/g

/**
 * Rewrite stale location pointers in an already-seeded preference file. Only the known path tokens
 * are touched, so user edits everywhere else survive. Returns the number of replacements, and the
 * caller decides whether to write.
 */
export function migratePreferences(text: string, targets: PathTargets) {
  let out = text
  let changes = 0
  const swap = (from: string, to: string) => {
    if (from === to || !out.includes(from)) return
    const before = out
    out = out.split(from).join(to)
    if (out !== before) changes += 1
  }
  for (const from of LEGACY_EXBAGS) swap(from, targets.exBagsDir)
  for (const from of LEGACY_SE) swap(from, targets.seDir)
  for (const from of LEGACY_HOME) swap(from, targets.home)
  const dataDir = path.dirname(targets.exBagsDir)
  for (const from of LEGACY_DATA_DIRS) swap(from, dataDir)
  // A placeholder the running build knows how to render but an older build shipped verbatim. Doing
  // this here heals files already on disk, not just freshly seeded ones, so a user who installed a
  // build with an unrendered token does not have to reinstall to see a real path.
  const rerendered = renderPreferences(out, targets)
  if (rerendered !== out) {
    out = rerendered
    changes += 1
  }
  // Catch-all for a data root rendered from an install path this build never shipped with.
  out = out.replace(DATA_DIR_PATTERN, (matched) => {
    if (matched === dataDir) return matched
    changes += 1
    return dataDir
  })
  return { text: out, changes }
}

/** Copy a text seed file to a target only when the target is absent, rendering placeholders. */
function copyMissingRendered(source: string, target: string, targets: PathTargets) {
  if (!existsSync(source) || existsSync(target)) return
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, renderPreferences(readFileSync(source, "utf8"), targets), "utf8")
}

/**
 * Bring an existing preference file up to date in place. Runs on every launch, does nothing when
 * the paths already match, and backs the file up before the first rewrite.
 */
function migrateRendered(target: string, targets: PathTargets) {
  if (!existsSync(target)) return
  let text: string
  try {
    text = readFileSync(target, "utf8")
  } catch {
    return
  }
  const { text: next, changes } = migratePreferences(text, targets)
  if (changes === 0) return
  try {
    writeFileSync(`${target}.bak-paths`, text, "utf8")
    writeFileSync(target, next, "utf8")
  } catch {
    // A read-only profile must not break startup; the stale path is cosmetic next to a crash.
  }
}

/** Copy a seed path to a target only when the target is absent; recurse otherwise. */
function copyMissing(source: string, target: string) {
  if (!existsSync(source)) return

  if (!existsSync(target)) {
    mkdirSync(path.dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true, force: false, errorOnExist: false })
    return
  }

  // Both exist: recurse into directories so newly added seed files land while
  // user modifications and extra files stay untouched.
  if (!isDirectory(source) || !isDirectory(target)) return

  for (const entry of readdirSync(source)) copyMissing(path.join(source, entry), path.join(target, entry))
}

function readTemplate(seedRoot: string) {
  const file = path.join(seedRoot, "config", "wlstudio", "opencode.template.json")
  if (!existsSync(file)) return null
  return readFileSync(file, "utf8")
}

/**
 * Remove the placeholder provider (and the default model that selects it) from a rendered config.
 * Structured edit rather than string surgery, so formatting quirks in the template cannot make the
 * result unparsable — the file has to load on the very first launch.
 */
function stripUnconfiguredProvider(rendered: string) {
  try {
    const config = JSON.parse(rendered) as Record<string, unknown>
    const providers = config.providers as Record<string, unknown> | undefined
    const unconfigured = Object.entries(providers ?? {})
      .filter(([, value]) => JSON.stringify(value).includes("REPLACE_WITH_DEEPSEEK_API_KEY"))
      .map(([id]) => id)
    if (unconfigured.length === 0) return rendered

    for (const id of unconfigured) delete providers![id]
    if (Object.keys(providers!).length === 0) delete config.providers
    // A default model naming a removed provider would fail provider resolution at startup.
    const model = typeof config.model === "string" ? config.model : undefined
    if (model && unconfigured.some((id) => model.startsWith(`${id}/`) || model === id)) delete config.model
    return JSON.stringify(config, null, 2) + "\n"
  } catch {
    // An unparsable template is a build defect; fall back to the verbatim text and let the
    // kernel report it rather than writing nothing at all.
    return rendered
  }
}

/**
 * Materialize the packaged seed into the user's home. Idempotent and safe to run
 * on every launch; existing user content is never overwritten. The optional
 * override exists so the logic can be exercised without a packaged app.
 */
export function materializeSeed(override: Partial<ReturnType<typeof seedTargets>> = {}) {
  const { seedRoot, configDir, home, seDir, exBagsDir } = { ...seedTargets(), ...override }

  if (!existsSync(seedRoot)) return

  const seedConfig = path.join(seedRoot, "config", "wlstudio")
  const seedPrefs = path.join(seedRoot, "prefs")

  // 1) Config: plugins, scripts, commands (copy-missing, recurse).
  copyMissing(path.join(seedConfig, "plugin"), path.join(configDir, "plugin"))
  copyMissing(path.join(seedConfig, "scripts"), path.join(configDir, "scripts"))
  copyMissing(path.join(seedConfig, "commands"), path.join(configDir, "commands"))

  // 1a) Browser bridge settings. Without this file the kernel falls back to `mode: "auto"`, which
  // only picks Firefox when a prompt happens to contain a trigger word and nothing is listening on
  // the remote port — so a fresh install quietly drives the built-in browser instead of the bridge
  // the user expects. Ship `bridge` explicitly; it is a per-user file, so an existing choice wins.
  copyMissing(path.join(seedConfig, "wl-browser.json"), path.join(configDir, "wl-browser.json"))

  // 1b) Plugin dependencies (mammoth/xlsx/adm-zip closure). Atomic: copied once, never merged into an
  // existing tree, so upgrades never churn thousands of files and a user-provided tree is preserved.
  const seedNodeModules = path.join(seedConfig, "node_modules")
  const targetNodeModules = path.join(configDir, "node_modules")
  if (existsSync(seedNodeModules) && !existsSync(targetNodeModules)) {
    mkdirSync(path.dirname(targetNodeModules), { recursive: true })
    cpSync(seedNodeModules, targetNodeModules, { recursive: true, force: false, errorOnExist: false })
  }

  // 2) opencode.json from the template, only when the user has none yet.
  //
  // The template ships a provider entry whose API key is a placeholder. Writing that to disk would
  // point the default model at a provider that cannot authenticate: the first launch fails outright,
  // and on the next launch the provider is dropped from the catalog, leaving no model to pick and
  // only a "choose a model first" prompt. When no real key was supplied, strip the provider and the
  // default model so the app opens in its unconfigured state, where the user can add one properly.
  const configFile = path.join(configDir, "opencode.json")
  if (!existsSync(configFile)) {
    const template = readTemplate(seedRoot)
    if (template !== null) {
      const apiKey = process.env.WLSTUDIO_DEEPSEEK_API_KEY
      const rendered = template
        .replaceAll("__WLSTUDIO_SE_DIR__", seDir)
        .replaceAll("__WLSTUDIO_HOME__", home)
        .replaceAll("__DEEPSEEK_API_KEY__", apiKey ?? "REPLACE_WITH_DEEPSEEK_API_KEY")
      mkdirSync(configDir, { recursive: true })
      writeFileSync(configFile, apiKey ? rendered : stripUnconfiguredProvider(rendered), "utf8")
    }
  }

  // 3) Preferences: AGENTS.md / WARMUP.md in the home dir, SE-AGENTS.md in its own folder.
  // Fresh installs get the file written with this machine's real paths. Existing files are then
  // migrated in place, so an upgrade that moved the installation to another volume rewrites the
  // stale pointers instead of leaving the model reading a path that no longer exists.
  //
  // SE-AGENTS.md ships as an empty skeleton on purpose. It is listed in the config's
  // `instructions`, so leaving it out makes every fresh install start with a red
  // "File not found" line. The skeleton carries no author-specific content (no proxy, no tool
  // paths, no personal notes) — only the structure and usage notes — and `copyMissingRendered`
  // never overwrites an existing file, so a user's own edits always win.
  const placeholders = { exBagsDir, seDir, home }
  copyMissingRendered(path.join(seedPrefs, "AGENTS.md"), path.join(home, "AGENTS.md"), placeholders)
  copyMissingRendered(path.join(seedPrefs, "WARMUP.md"), path.join(home, "WARMUP.md"), placeholders)
  copyMissingRendered(path.join(seedPrefs, "SE-AGENTS.md"), path.join(seDir, "SE-AGENTS.md"), placeholders)

  migrateRendered(path.join(home, "AGENTS.md"), placeholders)
  migrateRendered(path.join(home, "WARMUP.md"), placeholders)
  migrateRendered(path.join(seDir, "SE-AGENTS.md"), placeholders)

  // 4) The experience library: ship the STRUCTURE only — the ten domain folders, the tag
  // vocabulary and an empty index. Authoring experience documents is the user's own work, so none
  // of it belongs in an installer. `copyMissing` recurses, so anything already inside the user's
  // folder (their own documents) is preserved, while newly added skeleton entries still land.
  mkdirSync(exBagsDir, { recursive: true })
  copyMissing(path.join(seedRoot, "ex-bags"), exBagsDir)
}

/** Runs the seed step only for a real packaged launch. */
export function seedConfigOnFirstLaunch() {
  if (!app.isPackaged) return
  // The onboarding harness is a test mode; without an explicit home override it would write into the
  // developer's real profile, so skip it. An override (WLSTUDIO_TEST_HOME) makes it a safe dry run.
  if (process.env.WLSTUDIO_TEST_ONBOARDING === "1" && !process.env.WLSTUDIO_TEST_HOME) return

  try {
    materializeSeed()
  } catch (error) {
    // A failed seed must never block startup.
    console.error("WLstudio seed materialization failed", error)
  }
}
