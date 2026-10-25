import { expect, test } from "bun:test"
import { Env } from "../src/env"

test("session environment omits server credentials", () => {
  const previousPassword = process.env.WLSTUDIO_PASSWORD
  const previousLegacyPassword = process.env.WLSTUDIO_SERVER_PASSWORD
  const previousValue = process.env.WLSTUDIO_SESSION_ENV_TEST
  process.env.WLSTUDIO_PASSWORD = "password"
  process.env.WLSTUDIO_SERVER_PASSWORD = "legacy"
  process.env.WLSTUDIO_SESSION_ENV_TEST = "included"

  const environment = Env.session()

  if (previousPassword === undefined) delete process.env.WLSTUDIO_PASSWORD
  else process.env.WLSTUDIO_PASSWORD = previousPassword
  if (previousLegacyPassword === undefined) delete process.env.WLSTUDIO_SERVER_PASSWORD
  else process.env.WLSTUDIO_SERVER_PASSWORD = previousLegacyPassword
  if (previousValue === undefined) delete process.env.WLSTUDIO_SESSION_ENV_TEST
  else process.env.WLSTUDIO_SESSION_ENV_TEST = previousValue

  expect(environment.WLSTUDIO_PASSWORD).toBeUndefined()
  expect(environment.WLSTUDIO_SERVER_PASSWORD).toBeUndefined()
  expect(environment.WLSTUDIO_SESSION_ENV_TEST).toBe("included")
})
