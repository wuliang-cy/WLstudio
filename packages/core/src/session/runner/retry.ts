export * as SessionRunnerRetry from "./retry.js"

import { AIError, isQuotaWindow as isQuotaWindowReason, isRetryable } from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { SessionError } from "@opencode/schema/session-error"
import { Clock, Duration, Effect, Pull, Schedule } from "effect"
import { Bus } from "../../bus.js"
import type { PluginHooks } from "../../plugin/hooks.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"

export { isRetryable }

interface Input {
  readonly cause: AIError
  readonly error: SessionError.Error
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly hook: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  readonly retry: boolean
}

export interface Decision {
  readonly retry: true
  readonly attempt: number
  readonly delay: number
}

/** Bound provider-requested delays so a hostile or buggy retry-after cannot stall a session for hours. */
const RETRY_AFTER_MAX = Duration.toMillis("15 minutes")

const retryAfter = (input: Input) => {
  if (input.cause.reason._tag === "RateLimit" || input.cause.reason._tag === "ProviderInternal")
    return input.cause.reason.retryAfterMs === undefined
      ? undefined
      : Math.min(input.cause.reason.retryAfterMs, RETRY_AFTER_MAX)
  return undefined
}

/**
 * How long a quota window may keep the session waiting before each retry.
 *
 * A windowed plan (a 5-hour or daily cap) typically reopens far sooner than its nominal
 * window, and the provider does not always say when. Polling every couple of minutes
 * catches the reopen promptly without wasting requests, while the cap keeps a genuinely
 * long window from hammering the endpoint.
 */
const QUOTA_WINDOW_GAP = Duration.toMillis("2 minutes")

/** Transient failures poll gently; a long outage should not hammer the provider. */
const TRANSIENT_GAP_MAX = Duration.seconds(60)

const isQuotaWindow = (input: Input) => isQuotaWindowReason(input.cause)

// Exponential from 2s, jittered, and **no attempt limit**.
//
// A session ends when the task completes, when it needs the user, or when the user
// interrupts — never because a transient failure outlasted a fixed allowance. Network
// drops, incomplete streams, provider 5xx, timeouts, and rolling quota windows are exactly
// the cases the user wants to ride out, so the schedule never recurs to a stop.
//
// Deterministic failures (auth, permanent quota exhaustion, content policy, invalid
// request) do not reach the retry path at all: the caller gates every decision through
// `isRetryable`, which rejects them, and `input.retry` is false for those.
const schedule = Schedule.exponential("2 seconds").pipe(
  Schedule.jittered,
  Schedule.setInputType<Input>(),
  Schedule.modifyDelay(({ input, duration: delay }) => {
    // A quota window is a "come back later", not a flaky connection: wait in fixed,
    // generous steps so the reopen is caught quickly instead of creeping up the
    // exponential curve from two seconds.
    const capped = isQuotaWindow(input) ? Duration.millis(QUOTA_WINDOW_GAP) : Duration.min(delay, TRANSIENT_GAP_MAX)
    const minimum = retryAfter(input)
    const duration = minimum === undefined ? capped : Duration.max(capped, Duration.millis(minimum))
    return Effect.succeed(Duration.millis(Math.ceil(Duration.toMillis(duration))))
  }),
)

export const policy = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(schedule)
    let attempt = 1
    return (input: Input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const next = yield* step(now, input).pipe(Pull.catchDone(() => Effect.succeed(undefined)))
        if (!next) return { retry: false as const }
        const [, duration] = next
        attempt++
        const delay = Math.ceil(Duration.toMillis(duration))
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt,
          // `input.retry` already encodes `isRetryable`: transient failures keep retrying
          // for as long as they last; deterministic ones stop here and surface to the user.
          decision: input.retry ? { retry: true, delay } : { retry: false },
        }
        yield* input.hook(event)
        if (!event.decision.retry) return event.decision
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0 ? Math.ceil(event.decision.delay) : delay
        return { retry: true as const, attempt, delay: normalized }
      })
  })

export const make = (bus: Bus.Interface, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const decide = yield* policy(sessionID)
    const wait = (input: {
      readonly decision: Decision
      readonly assistantMessageID: SessionMessage.ID
      readonly error: SessionError.Error
    }) =>
      Effect.gen(function* () {
        const scheduled = yield* Clock.currentTimeMillis
        yield* bus.publish(SessionEvent.RetryScheduled, {
          sessionID,
          assistantMessageID: input.assistantMessageID,
          attempt: input.decision.attempt,
          at: scheduled + input.decision.delay,
          error: input.error,
        })
        const remaining = Math.max(0, scheduled + input.decision.delay - (yield* Clock.currentTimeMillis))
        yield* Effect.sleep(Duration.millis(remaining))
      })
    return { decide, wait }
  })
