export * as ReferenceInstructions from "./instructions.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Reference } from "../reference.js"
import { Instructions } from "../instructions/index.js"

const Summary = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  description: Schema.String.pipe(Schema.optional),
})

const entries = (references: ReadonlyArray<typeof Summary.Type>) =>
  references.flatMap((reference) => [
    "  <reference>",
    `    <name>${reference.name}</name>`,
    `    <path>${reference.path}</path>`,
    ...(reference.description === undefined ? [] : [`    <description>${reference.description}</description>`]),
    "  </reference>",
  ])

const render = (references: ReadonlyArray<typeof Summary.Type>) =>
  [
    "项目引用（Project references）提供了在相关时可以访问的附加目录。",
    "<available_references>",
    ...entries(references),
    "</available_references>",
  ].join("\n")

const update = (previous: ReadonlyArray<typeof Summary.Type>, current: ReadonlyArray<typeof Summary.Type>) => {
  const diff = Instructions.diffByKey(
    previous,
    current,
    (reference) => reference.name,
    (before, after) => before.path !== after.path || before.description !== after.description,
  )
  // Additions and removals render as small deltas; anything else restates the full list.
  if (diff.changed.length > 0 || (diff.added.length === 0 && diff.removed.length === 0))
    return [
      "可用的项目引用已发生变化。此列表取代之前的引用列表。",
      render(current),
    ].join("\n")
  return [
    ...(diff.added.length === 0
      ? []
      : ["除了之前列出的之外，还有新的项目引用可用：", ...entries(diff.added)]),
    ...(diff.removed.length === 0
      ? []
      : [
          `以下项目引用已不再可用，禁止使用：${diff.removed.map((reference) => reference.name).join(", ")}.`,
        ]),
  ].join("\n")
}

export interface Interface {
  readonly load: () => Effect.Effect<Instructions.List>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ReferenceInstructions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const references = yield* Reference.Service

    return Service.of({
      load: Effect.fn("ReferenceInstructions.load")(function* () {
        const available = (yield* references.list())
          .filter((reference) => reference.description !== undefined)
          .map((reference) => ({
            name: reference.name,
            path: reference.path,
            description: reference.description,
          }))
          .toSorted((a, b) => a.name.localeCompare(b.name))
        return Instructions.make<ReadonlyArray<typeof Summary.Type>>({
          key: Instructions.Key.make("core/reference-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          read: Effect.succeed(available.length === 0 ? Instructions.removed : available),
          render: {
            initial: render,
            changed: update,
            removed: () =>
              "项目引用指引已不再可用。不要使用之前列出的引用。",
          },
        })
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Reference.node] })
