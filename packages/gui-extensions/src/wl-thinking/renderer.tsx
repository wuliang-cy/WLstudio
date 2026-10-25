import { Popover } from "@kobalte/core/popover"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Switch } from "@opencode/ui/switch"
import { Tooltip } from "@opencode/ui/tooltip"
import { createEffect, createSignal, Show } from "solid-js"
import { Command, Slot, type Setup } from "../sdk"
import type definition from "./index"

const setup: Setup<typeof definition> = (ctx) => {
  const monitor = ctx.uses.monitor

  // The overlay is owned by main; the panel mirrors what main reports so a second window stays in sync.
  const [shown, setShown] = createSignal(false)
  const [windowOpacity, setWindowOpacity] = createSignal(86)
  const [textOpacity, setTextOpacity] = createSignal(100)
  const [open, setOpen] = createSignal(false)

  const live = () => {
    const value = monitor()
    return value.status === "active" ? value.value : undefined
  }

  createEffect(() => {
    const client = live()
    if (!client) return
    const read = client.state()
    if (read) {
      setShown(read.shown)
      setWindowOpacity(read.window)
      setTextOpacity(read.text)
    }
  })

  const toggle = (session: string) => {
    const client = live()
    if (!client) return
    void client.toggle({ session }).then(setShown)
  }

  const applyOpacity = (next: { window?: number; text?: number }) => {
    const client = live()
    if (!client) return
    const value = { window: next.window ?? windowOpacity(), text: next.text ?? textOpacity() }
    void client.setOpacity(value).then((result) => {
      setWindowOpacity(result.window)
      setTextOpacity(result.text)
    })
  }

  const Panel = (props: { session: string }) => (
    <div class="wl-thinking-panel" style={panelStyle}>
      <div style={rowStyle}>
        <span style={labelStyle}>{ctx.t("panel.title")}</span>
        <Switch
          checked={shown()}
          onChange={(checked) => {
            const client = live()
            if (!client) return
            if (checked) void client.toggle({ session: props.session }).then(setShown)
            else void client.hide().then(() => setShown(false))
          }}
        >
          <span style={switchLabelStyle}>{shown() ? ctx.t("panel.hide") : ctx.t("panel.show")}</span>
        </Switch>
      </div>
      <label style={rowStyle}>
        <span style={labelStyle}>{ctx.t("panel.windowOpacity")}</span>
        <span style={valueStyle}>{windowOpacity()}%</span>
      </label>
      <input
        type="range"
        min="0"
        max="100"
        value={windowOpacity()}
        style={sliderStyle}
        onInput={(event) => applyOpacity({ window: Number(event.currentTarget.value) })}
      />
      <label style={rowStyle}>
        <span style={labelStyle}>{ctx.t("panel.textOpacity")}</span>
        <span style={valueStyle}>{textOpacity()}%</span>
      </label>
      <input
        type="range"
        min="0"
        max="100"
        value={textOpacity()}
        style={sliderStyle}
        onInput={(event) => applyOpacity({ text: Number(event.currentTarget.value) })}
      />
    </div>
  )

  ctx.add(Slot, {
    at: "session.header",
    order: 40,
    render: (input) => (
      <Show when={input.active}>
        <Popover open={open()} placement="bottom-end" gutter={8} overflowPadding={16} onOpenChange={setOpen}>
          <Popover.Anchor class="pointer-events-none absolute end-3 top-2.5 h-7 w-0" aria-hidden="true" />
          <Tooltip placement="bottom" value={ctx.t("tooltip")}>
            <Popover.Trigger
              as={IconButton}
              icon={<Icon name="brain" />}
              variant="ghost-muted"
              size="large"
              state={shown() ? "pressed" : undefined}
              aria-label={ctx.t("tooltip")}
              aria-expanded={open()}
            />
          </Tooltip>
          <Popover.Portal>
            <Popover.Content class="z-50 outline-none" aria-label={ctx.t("panel.title")}>
              <Panel session={input.session.id} />
            </Popover.Content>
          </Popover.Portal>
        </Popover>
      </Show>
    ),
  })

  ctx.add(Command, {
    id: "toggle",
    get title() {
      return ctx.t("command.toggle")
    },
    run: () => {
      const session = ctx.sessions.current()
      if (session) toggle(session.id)
    },
  })
}

const panelStyle = {
  width: "240px",
  padding: "12px",
  "border-radius": "12px",
  background: "rgba(18,20,28,.96)",
  border: "1px solid rgba(255,255,255,.10)",
  color: "#e7e9ee",
  display: "flex",
  "flex-direction": "column",
  gap: "6px",
  "font-size": "12px",
} as const

const rowStyle = { display: "flex", "align-items": "center", "justify-content": "space-between", gap: "8px" } as const

const labelStyle = { color: "#b9c0d0" } as const

const valueStyle = { color: "#8b92a6", "font-variant-numeric": "tabular-nums" } as const

const switchLabelStyle = { color: "#c9cfdd" } as const

const sliderStyle = { width: "100%", accentColor: "#60a5fa" } as const

export default setup
