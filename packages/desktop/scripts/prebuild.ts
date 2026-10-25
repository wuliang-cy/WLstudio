#!/usr/bin/env bun
import { $ } from "bun"

import { copyBuiltCliToResources, downloadCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()

if (channel === "prod" && !Bun.env.WLSTUDIO_CLI_DIST) {
  throw new Error("WLSTUDIO_CLI_DIST is required for production desktop builds")
}

await $`bun ./scripts/copy-icons.ts ${channel}`

await $`bun ./scripts/copy-metainfo.ts ${channel}`

if (channel === "dev") await downloadCliToResources()

if ((channel === "beta" || channel === "prod") && Bun.env.WLSTUDIO_CLI_DIST) {
  await copyBuiltCliToResources(Bun.env.WLSTUDIO_CLI_DIST)
}

if (channel === "beta" && !Bun.env.WLSTUDIO_CLI_DIST) await downloadCliToResources("beta")
