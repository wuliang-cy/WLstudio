/**
 * A minimal WebDriver BiDi client over a raw WebSocket, used by the desktop main process.
 *
 * Firefox allows **one** WebDriver BiDi session per instance, and closing the socket without sending
 * `session.end` leaks that single slot permanently (a reload or a crash then refuses every later
 * attach with `Maximum number of active sessions`). The desktop shell is the bridge's single owner,
 * so this client is created once per app and released with `end()` — never with a bare `close()`.
 *
 * Only Node built-ins are used: the global `WebSocket` (Node 22+) with a structurally typed fallback,
 * so the code needs neither a DOM lib nor a third-party dependency.
 */

type WebSocketEvent = { readonly data?: unknown }

type WebSocketLike = {
  addEventListener(type: string, listener: (event: WebSocketEvent) => void): void
  send(data: string): void
  close(): void
  readonly readyState: number
}

type WebSocketConstructor = new (url: string) => WebSocketLike

function webSocket(): WebSocketConstructor | undefined {
  return (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket
}

export type BidiEvent = { readonly method: string; readonly params?: Record<string, unknown> }

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }
export class BidiClient {
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(event: BidiEvent) => void>()
  private readonly socket: WebSocketLike
  private nextId = 1
  private shut = false
  sessionId: string
  capabilities: Record<string, unknown>

  private constructor(socket: WebSocketLike, sessionId: string, capabilities: Record<string, unknown>) {
    this.socket = socket
    this.sessionId = sessionId
    this.capabilities = capabilities
    socket.addEventListener("message", (event) => this.receive(event.data))
    const fail = () => this.failAll(new Error("firefox.socketClosed"))
    socket.addEventListener("close", () => {
      this.shut = true
      fail()
    })
    socket.addEventListener("error", fail)
  }

  /** Opens a socket and starts the session; a refused session still releases the socket. */
  static async connect(url: string): Promise<BidiClient> {
    const Ctor = webSocket()
    if (!Ctor) throw new Error("firefox.noWebSocket")
    const socket = await new Promise<WebSocketLike>((resolve, reject) => {
      const ws = new Ctor(url)
      let settled = false
      const once = (run: () => void) => {
        if (settled) return
        settled = true
        run()
      }
      ws.addEventListener("open", () => once(() => resolve(ws)))
      ws.addEventListener("error", () => once(() => reject(new Error("firefox.connectFailed"))))
      setTimeout(
        () =>
          once(() => {
            try {
              ws.close()
            } catch {
              /* the socket may never have opened */
            }
            reject(new Error("firefox.connectTimeout"))
          }),
        10_000,
      )
    })
    const client = new BidiClient(socket, "", {})
    let result: { sessionId?: unknown; capabilities?: unknown }
    try {
      result = (await client.send("session.new", { capabilities: {} })) as typeof result
    } catch (error) {
      client.close()
      throw error
    }
    if (!result || typeof result.sessionId !== "string") {
      client.close()
      throw new Error("firefox.sessionInvalid")
    }
    client.sessionId = result.sessionId
    client.capabilities = (result.capabilities as Record<string, unknown> | undefined) ?? {}
    return client
  }

  get closed(): boolean {
    return this.shut
  }

  onEvent(listener: (event: BidiEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async subscribe(events: readonly string[]): Promise<void> {
    await this.send("session.subscribe", { events: [...events] })
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.shut) return Promise.reject(new Error("firefox.disposed"))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private receive(raw: unknown): void {
    if (typeof raw !== "string") return
    let message: {
      type?: string
      id?: number
      result?: unknown
      error?: unknown
      message?: unknown
      method?: string
      params?: Record<string, unknown>
    }
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.type === "event") {
      if (typeof message.method !== "string") return
      const event: BidiEvent = { method: message.method, ...(message.params ? { params: message.params } : {}) }
      for (const listener of this.listeners) {
        try {
          listener(event)
        } catch {
          /* a listener error stays contained */
        }
      }
      return
    }
    if (typeof message.id !== "number") return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.type === "success") pending.resolve(message.result)
    else {
      // BiDi reports failures as `{ error: "session not created", message: "..." }`; either field may
      // carry the useful part, so keep both instead of collapsing to "unknown".
      const raw = message as { error?: unknown; message?: unknown }
      const detail =
        (typeof raw.message === "string" && raw.message) ||
        (typeof raw.error === "string" && raw.error) ||
        (raw.error && typeof raw.error === "object" && typeof (raw.error as { message?: unknown }).message === "string"
          ? String((raw.error as { message: string }).message)
          : "unknown")
      pending.reject(new Error(`firefox.commandFailed:${detail}`))
    }
  }

  private failAll(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
  }

  close(): void {
    this.shut = true
    try {
      this.socket.close()
    } catch {
      /* already gone */
    }
  }

  /**
   * Release the session before dropping the socket. Firefox only frees its single session slot on
   * `session.end`; a bare `close()` leaks it and every later attach is refused.
   */
  async end(): Promise<void> {
    if (this.sessionId && !this.shut) {
      try {
        await this.send("session.end", {})
      } catch {
        /* the session may already be gone; closing below is what matters */
      }
    }
    this.close()
  }
}
