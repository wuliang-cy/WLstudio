/**
 * A minimal WebDriver BiDi client over a raw WebSocket, shared by the desktop main process only.
 *
 * Firefox exposes a browser-level BiDi endpoint at `ws://<host>:<port>/session` when started with
 * `--remote-debugging-port`. The wire format is JSON: `{ id, method, params }` out, and
 * `{ type: "success" | "error", id, result | error }` or `{ type: "event", method, params }` back.
 * Node's global `WebSocket` (Electron 44 bundles Node 22) is enough, so no extra dependency ships.
 */

export type BidiEvent = {
  readonly method: string
  readonly params: unknown
}

type Pending = {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

type ServerMessage =
  | { readonly type: "success"; readonly id: number; readonly result: unknown }
  | { readonly type: "error"; readonly id: number; readonly error: unknown }
  | { readonly type: "event"; readonly method: string; readonly params: unknown }

export class BidiClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(event: BidiEvent) => void>()
  private disposed = false

  sessionId = ""
  capabilities: Record<string, unknown> = {}

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (message) => this.receive(message.data))
    const fail = () => this.failAll(new Error("bidi.socket.closed"))
    socket.addEventListener("close", () => {
      this.disposed = true
      fail()
    })
    socket.addEventListener("error", fail)
  }

  /** Opens the browser endpoint, negotiates a session, and returns the ready client. */
  static async connect(url: string, options: { signal?: AbortSignal } = {}): Promise<BidiClient> {
    const socket = await open(url, options.signal)
    const client = new BidiClient(socket)
    try {
      const result = (await client.send("session.new", { capabilities: {} })) as {
        sessionId?: string
        capabilities?: Record<string, unknown>
      }

      if (typeof result?.sessionId !== "string") throw new Error("bidi.session.invalid")
      client.sessionId = result.sessionId
      client.capabilities = result.capabilities ?? {}

      return client
    } catch (error) {
      client.close()
      throw error
    }
  }

  onEvent(listener: (event: BidiEvent) => void) {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  async subscribe(events: readonly string[]): Promise<void> {
    await this.send("session.subscribe", { events })
  }

  send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("bidi.disposed"))
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params })

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.socket.send(payload)
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  close() {
    this.disposed = true
    try {
      this.socket.close()
    } catch {
      // A socket already closing throws on some runtimes; the caller only tears down.
    }
  }

  private receive(raw: unknown) {
    if (typeof raw !== "string") return
    let message: ServerMessage
    try {
      message = JSON.parse(raw) as ServerMessage
    } catch {
      return
    }
    if (message.type === "event") {
      const event = { method: message.method, params: message.params }
      for (const listener of this.listeners) listener(event)

      return
    }
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    if (message.type === "success") entry.resolve(message.result)
    else entry.reject(new BidiError(message.error))
  }

  private failAll(error: Error) {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }
}

export class BidiError extends Error {
  constructor(readonly detail: unknown) {
    super(typeof detail === "string" ? detail : "bidi.error")
    this.name = "BidiError"
  }
}

function open(url: string, signal?: AbortSignal): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("bidi.connect.aborted"))

      return
    }
    const socket = new WebSocket(url)
    const settle = (run: () => void) => {
      signal?.removeEventListener("abort", abort)
      run()
    }
    const abort = () => {
      try {
        socket.close()
      } catch {
        // ignore
      }
      settle(() => reject(new Error("bidi.connect.aborted")))
    }
    socket.addEventListener(
      "open",
      () => settle(() => resolve(socket)),
      { once: true },
    )
    socket.addEventListener("error", () => settle(() => reject(new Error("bidi.connect.failed"))), { once: true })
    signal?.addEventListener("abort", abort, { once: true })
  })
}
