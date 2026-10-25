export * as InstructionBuiltIns from "./builtins.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Global } from "@opencode/util/global"
import { Location } from "../location.js"
import { Instructions } from "./index.js"

export interface Interface {
  readonly load: () => Effect.Effect<Instructions.List>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstructionBuiltIns") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const location = yield* Location.Service
    return Service.of({
      load: () =>
        Effect.succeed(
          Instructions.combine([
            Instructions.make({
              key: Instructions.Key.make("core/date"),
              codec: Schema.toCodecJson(Schema.String),
              read: DateTime.nowAsDate.pipe(Effect.map((date) => date.toDateString())),
              render: {
                initial: (date) => `今天的日期：${date}`,
                changed: (_previous, date) => `今天的日期已变为：${date}`,
              },
            }),
            Instructions.make({
              key: Instructions.Key.make("core/environment"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.sync(() =>
                [
                  "<env>",
                  `  工作目录: ${location.directory}`,
                  `  工作区根目录: ${location.project.directory}`,
                  `  是否为 git 仓库: ${location.vcs?.type === "git" ? "是" : "否"}`,
                  `  平台: ${process.platform}`,
                  `  临时目录请优先使用 ${global.tmp}，而不是 /tmp 这类通用系统临时目录；它已预先创建并获准用于外部访问。`,
                  "</env>",
                ].join("\n"),
              ),
              render: {
                initial: (environment) =>
                  ["以下是你当前运行环境的一些信息：", environment].join("\n"),
                changed: (_previous, environment) => ["你当前运行的环境已变为：", environment].join("\n"),
              },
            }),
          ]),
        ),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Global.node, Location.node] })
