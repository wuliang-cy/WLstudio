/**
 * The browser action surface, mirroring the old Python bridge's command names but executed straight
 * on WebDriver BiDi. Most page actions are small script evaluations; navigation, history, cookies,
 * tabs and screenshots use the BiDi modules directly.
 *
 * Actions BiDi cannot express without a privileged extension (bookmarks, downloads history, request
 * rewriting, full history listing, geolocation, clipboard) are reported as unsupported rather than
 * silently ignored, so a caller learns the boundary.
 */

export type ActionTab = {
  readonly context: string
  readonly url: string
  readonly title: string
  readonly active: boolean
}

/** What an action needs from the bridge; kept structural so `session.ts` can pass itself in. */
export type BrowserActionContext = {
  send(method: string, params: Record<string, unknown>): Promise<unknown>
  evaluate(context: string, expression: string): Promise<unknown>
  navigate(context: string, url: string): Promise<string>
  createTab(url?: string): Promise<string>
  closeTab(context: string): Promise<void>
  activateTab(context: string): Promise<void>
  list(): readonly ActionTab[]
  activeContext(): string
}

const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback)
const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback)
const bool = (value: unknown) => value === true

const q = (value: string) => JSON.stringify(value)
const element = (selector: string) => `document.querySelector(${q(selector)})`
const all = (selector: string) => `Array.from(document.querySelectorAll(${q(selector)}))`

// Page scripts return JSON strings so the value crosses BiDi as a primitive, not a remote object.
async function evalJson(ctx: BrowserActionContext, context: string, expression: string): Promise<unknown> {
  const value = await ctx.evaluate(context, `JSON.stringify(${expression})`)
  return typeof value === "string" ? JSON.parse(value) : value
}

async function runElement(
  ctx: BrowserActionContext,
  context: string,
  selector: string,
  body: string,
): Promise<unknown> {
  const result = await ctx.evaluate(
    context,
    `(() => { const el = ${element(selector)}; if (!el) return { __missing: true }; ${body} })()`,
  )
  if (result && typeof result === "object" && "__missing" in result) throw new Error("browser.selector.notFound")
  return result
}

const KEYS: Record<string, string> = {
  Enter: "\uE007",
  Tab: "\uE004",
  Escape: "\uE00C",
  Backspace: "\uE003",
  Delete: "\uE017",
  ArrowUp: "\uE013",
  ArrowDown: "\uE015",
  ArrowLeft: "\uE012",
  ArrowRight: "\uE014",
  Home: "\uE011",
  End: "\uE010",
  PageUp: "\uE00E",
  PageDown: "\uE00F",
}

const STORAGE = { local: "localStorage", session: "sessionStorage" } as const

/** Runs one action. Unknown or unsupported actions throw a stable `browser.action.*` code. */
export async function runBrowserAction(
  action: string,
  params: Record<string, unknown>,
  ctx: BrowserActionContext,
): Promise<unknown> {
  const context = text(params.context) || ctx.activeContext()
  const selector = text(params.selector)

  switch (action) {
    // Navigation and history.
    case "navigate":
    case "page.navigate":
      return await ctx.navigate(context, text(params.url))
    case "back":
    case "goBack":
      await ctx.send("browsingContext.traverseHistory", { context, delta: -1 })
      return true
    case "forward":
    case "goForward":
      await ctx.send("browsingContext.traverseHistory", { context, delta: 1 })
      return true
    case "reload":
      await ctx.send("browsingContext.reload", { context, wait: "complete" })
      return true

    // Page reads.
    case "url":
    case "getURL":
      return await ctx.evaluate(context, "location.href")
    case "title":
    case "getTitle":
      return await ctx.evaluate(context, "document.title")
    case "source":
    case "getSource":
      return await ctx.evaluate(context, "document.documentElement ? document.documentElement.outerHTML : ''")
    case "source.raw":
    case "page.source":
      return await ctx.evaluate(context, "document.documentElement ? document.documentElement.outerHTML : ''")
    case "text":
    case "getText":
      return selector
        ? await runElement(ctx, context, selector, "return el.innerText")
        : await ctx.evaluate(context, "document.body ? document.body.innerText : ''")
    case "getTexts":
      return await evalJson(ctx, context, `${all(selector)}.map((el) => el.innerText)`)
    case "html":
    case "getHTML":
      return selector
        ? await runElement(ctx, context, selector, "return el.outerHTML")
        : await ctx.evaluate(context, "document.documentElement ? document.documentElement.outerHTML : ''")
    case "getAttribute":
      return await runElement(ctx, context, selector, `return el.getAttribute(${q(text(params.name))})`)
    case "setAttribute":
      return await runElement(
        ctx,
        context,
        selector,
        `el.setAttribute(${q(text(params.name))}, ${q(text(params.value))}); return true`,
      )
    case "getElementInfo":
      return await evalJson(
        ctx,
        context,
        `(() => { const el = ${element(selector)}; if (!el) return null; const r = el.getBoundingClientRect(); return { tag: el.tagName, id: el.id, className: el.className, text: el.innerText, x: r.x, y: r.y, width: r.width, height: r.height } })()`,
      )
    case "getLinks":
      return await evalJson(
        ctx,
        context,
        `${all("a[href]")}.map((a) => ({ href: a.href, text: a.innerText }))`,
      )
    case "getImages":
      return await evalJson(
        ctx,
        context,
        `${all("img")}.map((img) => ({ src: img.currentSrc || img.src, alt: img.alt, width: img.naturalWidth, height: img.naturalHeight }))`,
      )
    case "getForms":
      return await evalJson(
        ctx,
        context,
        `${all("form")}.map((form) => ({ action: form.action, method: form.method, fields: Array.from(form.elements).map((el) => ({ tag: el.tagName, name: el.name, type: el.type, value: el.value })) }))`,
      )
    case "getMeta":
      return await evalJson(
        ctx,
        context,
        `Object.fromEntries(${all("meta")}.map((m) => [m.getAttribute("name") || m.getAttribute("property") || m.getAttribute("charset") || "", m.getAttribute("content") ?? ""]))`,
      )

    // Page actions.
    case "click":
      return await runElement(ctx, context, selector, "el.click(); return true")
    case "clickAll":
      return await ctx.evaluate(
        context,
        `(() => { let n = 0; for (const el of ${all(selector)}) { el.click(); n++ } return n })()`,
      )
    case "fill":
      return await runElement(
        ctx,
        context,
        selector,
        `el.focus(); el.value = ${q(text(params.value))}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return el.value`,
      )
    case "type":
      return await runElement(
        ctx,
        context,
        selector,
        `el.focus(); el.value = (el.value ?? "") + ${q(text(params.text ?? params.value))}; el.dispatchEvent(new Event("input", { bubbles: true })); return el.value`,
      )
    case "focus":
      return await runElement(ctx, context, selector, "el.focus(); return true")
    case "hover":
      return await runElement(
        ctx,
        context,
        selector,
        `for (const type of ["mouseover", "mouseenter", "mousemove"]) el.dispatchEvent(new MouseEvent(type, { bubbles: true })); return true`,
      )
    case "select":
      return await runElement(
        ctx,
        context,
        selector,
        `el.value = ${q(text(params.value))}; el.dispatchEvent(new Event("change", { bubbles: true })); return el.value`,
      )
    case "removeElement":
      return await runElement(ctx, context, selector, "el.remove(); return true")
    case "scrollIntoView":
      return await runElement(ctx, context, selector, "el.scrollIntoView({ block: 'center' }); return true")
    case "scroll":
      await ctx.evaluate(context, `window.scrollTo(${num(params.x)}, ${num(params.y)})`)
      return true
    case "scrollBy":
      await ctx.evaluate(context, `window.scrollBy(${num(params.x)}, ${num(params.y)})`)
      return true
    case "injectCSS":
      await ctx.evaluate(
        context,
        `(() => { const id = "__wl_style"; let el = document.getElementById(id); if (!el) { el = document.createElement("style"); el.id = id; document.documentElement.appendChild(el) } el.textContent = ${q(text(params.css))}; return true })()`,
      )
      return true
    case "evaluate":
    case "eval":
    case "exec":
    case "execute":
      return await evalJson(ctx, context, `(${text(params.expression)})`)
    case "pressKey": {
      const key = text(params.key)
      const value = key.length === 1 ? key : (KEYS[key] ?? key)
      await ctx.send("input.performActions", {
        context,
        actions: [{ type: "key", id: "kb", actions: [{ type: "keyDown", value }, { type: "keyUp", value }] }],
      })
      return true
    }
    case "wait":
      await new Promise((resolve) => setTimeout(resolve, num(params.ms, num(params.timeout, 0))))
      return true
    case "waitFor": {
      const timeout = num(params.timeout, 10_000)
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const found = await ctx.evaluate(context, `Boolean(${element(selector)})`)
        if (bool(found)) return true
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      throw new Error("browser.waitFor.timeout")
    }
    case "screenshot": {
      const result = (await ctx.send("browsingContext.captureScreenshot", { context })) as { data?: string }
      return result.data ?? null
    }
    case "safeMode":
      return true

    // Cookies (BiDi storage module).
    case "getCookies":
    case "cookies.getAll": {
      const result = (await ctx.send("storage.getCookies", {})) as { cookies?: unknown[] }
      return result.cookies ?? []
    }
    case "getCookie":
    case "cookies.get": {
      const result = (await ctx.send("storage.getCookies", {})) as { cookies?: Array<{ name?: string }> }
      return (result.cookies ?? []).find((cookie) => cookie.name === text(params.name)) ?? null
    }
    case "setCookie":
    case "cookies.set": {
      await ctx.send("storage.setCookie", {
        cookie: {
          name: text(params.name),
          value: { type: "string", value: text(params.value) },
          ...(text(params.domain) ? { domain: text(params.domain) } : {}),
          ...(text(params.path) ? { path: text(params.path) } : {}),
        },
      })
      return true
    }
    case "deleteCookie":
    case "cookies.delete":
      await ctx.send("storage.deleteCookies", { filter: { name: text(params.name) } })
      return true
    case "clearCookies":
    case "cookies.clear":
      await ctx.send("storage.deleteCookies", { filter: {} })
      return true

    // Local/session storage (page script).
    case "storage.get": {
      const area = STORAGE[text(params.area, "local") as keyof typeof STORAGE] ?? STORAGE.local
      return await ctx.evaluate(context, `${area}.getItem(${q(text(params.key))})`)
    }
    case "storage.set": {
      const area = STORAGE[text(params.area, "local") as keyof typeof STORAGE] ?? STORAGE.local
      await ctx.evaluate(context, `${area}.setItem(${q(text(params.key))}, ${q(text(params.value))})`)
      return true
    }
    case "storage.remove": {
      const area = STORAGE[text(params.area, "local") as keyof typeof STORAGE] ?? STORAGE.local
      await ctx.evaluate(context, `${area}.removeItem(${q(text(params.key))})`)
      return true
    }
    case "storage.clear": {
      const area = STORAGE[text(params.area, "local") as keyof typeof STORAGE] ?? STORAGE.local
      await ctx.evaluate(context, `${area}.clear()`)
      return true
    }

    // Tabs.
    case "tabs.list":
    case "listTabs":
      return [...ctx.list()]
    case "tabs.create":
    case "createTab":
      return await ctx.createTab(text(params.url) || undefined)
    case "tabs.close":
    case "closeTab":
      await ctx.closeTab(context)
      return true
    case "tabs.activate":
    case "activateTab":
      await ctx.activateTab(context)
      return true
    case "tabs.get":
      return ctx.list().find((tab) => tab.context === context) ?? null

    // Beyond BiDi without a privileged extension.
    case "bookmarks.create":
    case "bookmarks.remove":
    case "bookmarks.search":
    case "bookmarks.tree":
    case "downloads.search":
    case "downloads.cancel":
    case "downloads.erase":
    case "downloads.download":
    case "history.search":
    case "history.addUrl":
    case "history.deleteUrl":
    case "history.deleteAll":
    case "requests.block":
    case "requests.unblock":
    case "requests.fetch":
    case "requests.modifyHeaders":
    case "requests.clearHeaderMods":
    case "sessions.recentlyClosed":
    case "sessions.restore":
    case "clipboard.read":
    case "clipboard.write":
    case "geolocation.get":
    case "print":
    case "saveAsPDF":
    case "zoom":
      throw new Error(`browser.action.unsupported:${action}`)

    default:
      throw new Error(`browser.action.unknown:${action}`)
  }
}
