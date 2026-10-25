import { describe, expect, test } from "bun:test"
import { toProviderConfig, validateCustomProvider } from "./form"

const t = (key: string) => key

describe("validateCustomProvider", () => {
  test("builds trimmed config payload", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: " Custom Provider ",
        baseURL: "https://api.example.com ",
        apiKey: " {env: CUSTOM_PROVIDER_KEY} ",
        models: [{ row: "m0", id: " model-a ", name: " Model A ", err: {} }],
        headers: [
          { row: "h0", key: " X-Test ", value: " enabled ", err: {} },
          { row: "h1", key: "", value: "", err: {} },
        ],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })

    expect(result.result).toEqual({
      providerID: "custom-provider",
      name: "Custom Provider",
      key: undefined,
      config: {
        npm: "@ai-sdk/openai-compatible",
        name: "Custom Provider",
        env: ["CUSTOM_PROVIDER_KEY"],
        options: {
          baseURL: "https://api.example.com",
          headers: {
            "X-Test": "enabled",
          },
        },
        models: {
          "model-a": { name: "Model A" },
        },
      },
    })
  })

  test("flags duplicate rows and allows reconnecting disabled providers", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: "Provider",
        baseURL: "https://api.example.com",
        apiKey: "secret",
        models: [
          { row: "m0", id: "model-a", name: "Model A", err: {} },
          { row: "m1", id: "model-a", name: "Model A 2", err: {} },
        ],
        headers: [
          { row: "h0", key: "Authorization", value: "one", err: {} },
          { row: "h1", key: "authorization", value: "two", err: {} },
        ],
        err: {},
      },
      t,
      disabledProviders: ["custom-provider"],
      existingProviderIDs: new Set(["custom-provider"]),
    })

    expect(result.result).toBeUndefined()
    expect(result.err.providerID).toBeUndefined()
    expect(result.models[1]).toEqual({
      id: "provider.custom.error.duplicate",
      name: undefined,
    })
    expect(result.headers[1]).toEqual({
      key: "provider.custom.error.duplicate",
      value: undefined,
    })
  })
})

describe("toProviderConfig", () => {
  const validated = (apiKey: string) =>
    validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: "Custom Provider",
        baseURL: "https://api.example.com",
        apiKey,
        models: [{ row: "m0", id: "model-a", name: "Model A", err: {} }],
        headers: [{ row: "h0", key: "X-Test", value: "enabled", err: {} }],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    }).result!

  test("maps the validated form into the v2 provider document shape", () => {
    expect(toProviderConfig(validated("secret"))).toEqual({
      name: "Custom Provider",
      package: "@ai-sdk/openai-compatible",
      settings: {
        baseURL: "https://api.example.com",
        apiKey: "secret",
        headers: { "X-Test": "enabled" },
      },
      models: { "model-a": { name: "Model A" } },
    })
  })

  test("omits apiKey when the form supplies an env reference", () => {
    const provider = toProviderConfig(validated("{env:CUSTOM_PROVIDER_KEY}"))
    expect(provider.settings.apiKey).toBeUndefined()
    expect(provider.env).toEqual(["CUSTOM_PROVIDER_KEY"])
    expect(provider.settings.baseURL).toBe("https://api.example.com")
  })

  test("declares image input capability when requested", () => {
    const provider = toProviderConfig(validated("secret"), { imageInput: true })
    expect(provider.models).toEqual({
      "model-a": { name: "Model A", capabilities: { input: ["text", "image"] } },
    })
  })
})
