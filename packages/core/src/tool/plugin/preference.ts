export * as PreferenceTool from "./preference.js"

/**
 * Session preference pool: non-universal rules tagged by task domain.
 *
 * A rule that only matters for some kinds of work has two bad homes today. In the
 * always-on preference files it is re-sent on every request for the rest of the
 * session; in the experience tree it dilutes documents that are supposed to be
 * reusable methods. This keeps them in `instruction_entry` instead, next to the
 * note and under the same storage rules.
 *
 * Naming is the whole tag system: `pref.<domain>.<name>`. The domain is a fixed
 * list so lookups stay a prefix match on an indexed key, and a new domain is added
 * deliberately rather than invented per session. No separate tree, no directory
 * walk: one indexed table read, which is what makes it cheap enough to switch on
 * during compaction.
 *
 * Visibility is `removed`. The kernel renders only rows with `removed = false`, so
 * enabling a set of preferences is the same upsert a session note already uses.
 */

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Effect, Schema } from "effect"
import { InstructionEntry } from "../../session/instruction-entry.js"

export const name = "preference"

/** Domains a preference can belong to. Adding one here is what makes it matchable. */
export const Domains = [
  "ctf",
  "bounty",
  "packaging",
  "report",
  "image",
  "answer",
  "android",
  "proxy",
  "global",
] as const
export type Domain = (typeof Domains)[number]

const Prefix = "pref."
const MaxTextBytes = 6 * 1024

export const Input = Schema.Struct({
  action: Schema.Literals(["list", "add", "remove"]).annotate({
    description:
      "list shows the stored preferences with their domains; add writes or replaces one; remove hides it from future requests.",
  }),
  domain: Schema.optionalKey(Schema.Literals(Domains)).annotate({
    description:
      "Task domain this preference belongs to. Pick the closest match from the list. A rule that must always apply belongs in the preference files, not here.",
  }),
  name: Schema.optionalKey(Schema.String).annotate({
    description: "Short kebab-case identifier, for example `vpn-required` or `flag-format`.",
  }),
  text: Schema.optionalKey(Schema.String).annotate({
    description: "The rule itself, written as a direct instruction.",
  }),
})

export const Output = Schema.Struct({
  action: Schema.Literals(["list", "add", "remove"]),
  domains: Schema.Array(Schema.String),
  entries: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      domain: Schema.String,
      visible: Schema.Boolean,
    }),
  ),
})

export type Output = typeof Output.Type

const keyFor = (domain: Domain, id: string) => `${Prefix}${domain}.${id}`

const normalize = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60)

export const Plugin = {
  id: "opencode.preference",
  effect: Effect.fn("PreferenceTool")(function* (ctx: Context) {
    const entries = yield* InstructionEntry.Service

    const describe = (key: string) => {
      const rest = key.slice(Prefix.length)
      const dot = rest.indexOf(".")
      return { domain: dot < 0 ? "global" : rest.slice(0, dot) }
    }

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name,
        description: [
          "Manage this session's pool of task-specific preferences.",
          "",
          "Use this for rules that only apply to some kinds of work and that a later turn in this session would need to follow: `pref.ctf.flag-format`, `pref.bounty.vpn-required`, `pref.packaging.nsis-encoding`.",
          "",
          `Pick the closest domain from: ${Domains.join(", ")}. When a new kind of task has no suitable domain, pick the closest existing one and say so in the text rather than inventing a domain, because matching works on that fixed list.`,
          "",
          "Rules that apply to every session do not belong here: they belong in the always-on preference files, where they are re-sent anyway.",
          "",
          "Stored preferences are switched on automatically after each compaction, based on what the summarized work is about.",
        ].join("\n"),
        input: Input,
        output: Output,
        execute: (input: Schema.Schema.Type<typeof Input>, toolContext: any) =>
          Effect.gen(function* () {
            const sessionID = toolContext.sessionID
            const all = yield* entries.list(sessionID)
            const prefs = all.filter((entry) => entry.key.startsWith(Prefix))

            if (input.action === "list") {
              return {
                output: {
                  action: input.action,
                  domains: Domains as unknown as string[],
                  entries: prefs.map((entry) => ({
                    key: entry.key,
                    domain: describe(entry.key).domain,
                    visible: true,
                  })),
                },
                content:
                  prefs.length === 0
                    ? "No task-specific preferences stored for this session."
                    : prefs
                        .map((entry) => {
                          const value = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value)
                          return `${entry.key}\n  ${value}`
                        })
                        .join("\n\n"),
              }
            }

            const id = normalize(input.name ?? "")
            if (!id) return yield* new ToolFailure({ message: "Provide a kebab-case `name`." })

            const domain = (input.domain ?? "global") as Domain
            const key = keyFor(domain, id)

            if (input.action === "remove") {
              yield* entries.remove({ sessionID, key: InstructionEntry.Key.make(key) })
              return {
                output: { action: input.action, domains: Domains as unknown as string[], entries: [] },
                content: `Removed ${key} from this session's preferences.`,
              }
            }

            const text = (input.text ?? "").trim()
            if (!text) return yield* new ToolFailure({ message: "Provide `text` with the rule itself." })
            const bytes = Buffer.byteLength(text, "utf8")
            if (bytes > MaxTextBytes)
              return yield* new ToolFailure({
                message: `That preference is ${bytes} bytes; keep a single rule under ${MaxTextBytes}. Split unrelated rules into separate entries.`,
              })

            yield* entries.put({ sessionID, key: InstructionEntry.Key.make(key), value: text })

            return {
              output: {
                action: input.action,
                domains: Domains as unknown as string[],
                entries: [{ key, domain, visible: true }],
              },
              content: [
                `Saved ${key} (${bytes} bytes). It becomes part of this session's context after the next compaction that matches domain "${domain}".`,
                `If it must apply to every session instead, move it to the always-on preference files.`,
              ].join(" "),
            }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof ToolFailure
                ? error
                : new ToolFailure({ message: `Unable to ${input.action} the preference`, error }),
            ),
          ),
      }),
    )
  }),
}
