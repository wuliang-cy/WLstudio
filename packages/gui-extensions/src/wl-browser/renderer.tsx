import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Tooltip } from "@opencode/ui/tooltip"
import { createEffect, createSignal, For, Show } from "solid-js"
import { Panel, Slot, type PanelTab, type Setup } from "../sdk"
import type { BrowserMode, ControllerState } from "./ipc"
import type definition from "./index"

const setup: Setup<typeof definition> = (ctx) => {
  const key = `${ctx.id}:main`
  const bridge = ctx.uses.bridge

  const [snapshot, setSnapshot] = createSignal<ControllerState>()
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const live = () => {
    const value = bridge()
    return value.status === "active" ? value.value : undefined
  }

  createEffect(() => {
    const client = live()
    if (!client) return
    const read = client.state()
    if (read) setSnapshot(read)
  })

  createEffect(() => {
    const client = live()
    if (!client) return
    client.on("changed", (state) => setSnapshot(state))
  })

  const run = <T,>(action: (client: NonNullable<ReturnType<typeof live>>) => Promise<T>) => {
    const client = live()
    if (!client || busy()) return
    setBusy(true)
    setError(undefined)
    void action(client)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  const tab: PanelTab = {
    id: "main",
    get title() {
      return ctx.t("tab.title")
    },
    closable: "compact",
  }

  const PanelView = () => {
    const state = () => snapshot()
    const [keywords, setKeywords] = createSignal<string>()

    createEffect(() => {
      const value = state()
      if (value && keywords() === undefined) setKeywords(value.keywords.join(", "))
    })

    const modes: BrowserMode[] = ["auto", "bridge", "builtin"]

    const upstream = () => {
      const value = state()?.upstream
      if (value === "attached") return ctx.t("panel.upstream.attached")
      if (value === "managed") return ctx.t("panel.upstream.managed")
      return ctx.t("panel.upstream.none")
    }

    return (
      <div style={panelStyle}>
        <div style={rowStyle}>
          <span style={labelStyle}>{ctx.t("panel.listening")}</span>
          <span style={state()?.listening ? okStyle : mutedStyle}>
            {state()?.listening ? ctx.t("panel.yes") : ctx.t("panel.no")}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>{ctx.t("panel.bridge")}</span>
          <span style={state()?.ready ? okStyle : mutedStyle}>
            {state()?.ready ? upstream() : ctx.t("panel.upstream.none")}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>{ctx.t("panel.callers")}</span>
          <span style={mutedStyle}>
            {state()?.callers ?? 0} / {ctx.t("panel.tabs")} {state()?.tabs?.length ?? 0}
          </span>
        </div>
        <Show when={state()?.error ?? error()}>
          <div style={errorStyle}>{state()?.error ?? error()}</div>
        </Show>

        <div style={sectionStyle}>{ctx.t("panel.mode")}</div>
        <div style={modeListStyle}>
          <For each={modes}>
            {(mode) => (
              <label style={modeRowStyle}>
                <input
                  type="radio"
                  name={`${ctx.id}-mode`}
                  checked={(state()?.mode ?? "auto") === mode}
                  disabled={busy()}
                  onChange={() => run((client) => client.setMode({ mode }).then(setSnapshot))}
                />
                <span>{ctx.t(`panel.mode.${mode}`)}</span>
              </label>
            )}
          </For>
        </div>
        <div style={hintStyle}>{ctx.t("panel.modeHint")}</div>

        <div style={sectionStyle}>{ctx.t("panel.keywords")}</div>
        <div style={inputRowStyle}>
          <input
            style={inputStyle}
            placeholder={ctx.t("panel.keywordsPlaceholder")}
            value={keywords() ?? ""}
            onInput={(event) => setKeywords(event.currentTarget.value)}
          />
          <button
            style={buttonStyle}
            disabled={busy()}
            onClick={() =>
              run((client) =>
                client
                  .setKeywords({
                    keywords: (keywords() ?? "")
                      .split(",")
                      .map((value) => value.trim())
                      .filter((value) => value.length > 0),
                  })
                  .then(setSnapshot),
              )
            }
          >
            {ctx.t("panel.save")}
          </button>
        </div>

        <div style={buttonRowStyle}>
          <Show
            when={state()?.owned}
            fallback={
              <button
                style={buttonStyle}
                disabled={busy() || state()?.listening}
                onClick={() => run((client) => client.launch().then(setSnapshot))}
              >
                {state()?.launching ? ctx.t("status.starting") : ctx.t("panel.launch")}
              </button>
            }
          >
            <button style={buttonStyle} disabled={busy()} onClick={() => run((client) => client.stop().then(setSnapshot))}>
              {ctx.t("panel.stop")}
            </button>
          </Show>
          <button style={buttonStyle} disabled={busy()} onClick={() => run((client) => client.refresh().then(setSnapshot))}>
            {ctx.t("panel.refresh")}
          </button>
          <button
            style={buttonStyle}
            disabled={busy() || !state()?.listening}
            onClick={() => run((client) => client.reconnect().then(setSnapshot))}
          >
            {ctx.t("panel.reconnect")}
          </button>
        </div>
      </div>
    )
  }

  ctx.add(Panel, {
    id: "main",
    region: "side",
    list: (input) => (input.open.includes("main") ? [tab] : []),
    render: () => <PanelView />,
  })

  ctx.add(Slot, {
    at: "session.header",
    order: 30,
    render: (input) => (
      <Tooltip placement="bottom" value={ctx.t("tooltip")}>
        <IconButton
          icon={<Icon name="globe" />}
          variant="ghost-muted"
          size="large"
          aria-label={ctx.t("tooltip")}
          onClick={() => ctx.layout.toggle(key, input.session)}
        />
      </Tooltip>
    ),
  })
}

const panelStyle = {
  width: "100%",
  padding: "12px",
  display: "flex",
  "flex-direction": "column",
  gap: "8px",
  "font-size": "12px",
  color: "var(--text-base)",
  "box-sizing": "border-box",
} as const

const rowStyle = { display: "flex", "align-items": "center", "justify-content": "space-between", gap: "8px" } as const

const sectionStyle = { color: "var(--text-weak)", "margin-top": "4px" } as const

const hintStyle = { color: "var(--text-weak)", "font-size": "11px", "line-height": "1.4" } as const

const labelStyle = { color: "var(--text-weak)" } as const

const okStyle = { color: "var(--text-strong)", "font-weight": "600" } as const

const mutedStyle = { color: "var(--text-weak)" } as const

const errorStyle = { color: "var(--text-destructive, #f87171)", "word-break": "break-word" } as const

const modeListStyle = { display: "flex", "flex-direction": "column", gap: "4px" } as const

const modeRowStyle = { display: "flex", "align-items": "center", gap: "6px", cursor: "pointer" } as const

const buttonRowStyle = { display: "flex", "flex-wrap": "wrap", gap: "6px", "margin-top": "4px" } as const

const inputRowStyle = { display: "flex", gap: "6px", "align-items": "center" } as const

const inputStyle = {
  flex: "1",
  "min-width": "0",
  padding: "4px 8px",
  "border-radius": "4px",
  border: "1px solid var(--border-weak-base)",
  background: "var(--surface-raised-base-hover)",
  color: "var(--text-base)",
  "font-size": "12px",
} as const

const buttonStyle = {
  padding: "4px 10px",
  "border-radius": "4px",
  border: "1px solid var(--border-weak-base)",
  background: "var(--surface-raised-base-hover)",
  color: "var(--text-base)",
  cursor: "pointer",
  "font-size": "12px",
} as const

export default setup
