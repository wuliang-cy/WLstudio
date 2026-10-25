import { type Accessor, createMemo } from "solid-js"
import { useLocal } from "@/providers/models/selection"

/**
 * Per-session chat background. Some deployments want a visible marker for a model family, so a
 * session whose current model id or display name contains `deepseek` gets an illustration behind
 * the transcript. The check is a plain substring on the resolved model, which means it follows the
 * per-session selection automatically: switching the model switches the background, and two
 * sessions can show two different backgrounds at the same time.
 */
const MATCH = "deepseek"

/** The picture lives in `packages/app/public`, so vite copies it next to the renderer bundle. */
const SOURCE = "./deepseek-easter-egg.jpg"

/** Kept low so text stays readable over the illustration. */
const OPACITY = 0.2

export function createModelBackdrop(): Accessor<string | undefined> {
  const local = useLocal()

  const matches = createMemo(() => {
    const model = local.model.current()

    if (!model) return false
    const haystack = `${model.id} ${model.name}`.toLowerCase()

    return haystack.includes(MATCH)
  })

  return createMemo(() => (matches() ? SOURCE : undefined))
}

export const modelBackdropOpacity = OPACITY
