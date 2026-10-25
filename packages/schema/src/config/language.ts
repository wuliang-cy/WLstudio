export * as ConfigLanguage from "./language.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

/**
 * Languages the system prompt can instruct the model to think and answer in.
 *
 * This is deliberately a short, spoken-language list rather than every UI locale:
 * the value decides what language the model *thinks* in, and the point of the
 * setting is that the model uses the same language as the person typing. UI
 * locales that only change menu labels have no business steering the prompt.
 */
export const LANGUAGES = [
  "en",
  "zh",
  "zht",
  "ja",
  "ko",
  "de",
  "fr",
  "es",
  "pt",
  "ru",
  "it",
  "nl",
  "pl",
  "tr",
  "uk",
  "vi",
  "th",
  "id",
  "hi",
  "ar",
] as const

export type Language = (typeof LANGUAGES)[number]

export const Language = Schema.Literals(LANGUAGES)

/** Native name of each language, used when the prompt names the language back to the model. */
export const NATIVE_NAMES: Record<Language, string> = {
  en: "English",
  zh: "简体中文",
  zht: "繁體中文",
  ja: "日本語",
  ko: "한국어",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  pt: "Português",
  ru: "Русский",
  it: "Italiano",
  nl: "Nederlands",
  pl: "Polski",
  tr: "Türkçe",
  uk: "Українська",
  vi: "Tiếng Việt",
  th: "ไทย",
  id: "Bahasa Indonesia",
  hi: "हिन्दी",
  ar: "العربية",
}

export const Info = Schema.Union([
  // `false` means "no language steering at all" — the prompt keeps no language
  // section, so the model follows the user's own wording without being told to.
  Schema.Literal(false),
  Language,
]).pipe(optional)

export type Info = typeof Info.Type

/**
 * Maps a UI locale onto a prompt language.
 *
 * The app ships far more UI locales than the prompt supports; anything without a
 * dedicated entry falls back to English rather than inventing a half-translated
 * instruction the model would have to guess at.
 */
export function fromLocale(locale: string): Language {
  const normalized = locale.toLowerCase()
  if (normalized === "zh" || normalized.startsWith("zh-hans") || normalized === "zh-cn") return "zh"
  if (normalized === "zht" || normalized.startsWith("zh-hant") || normalized === "zh-tw" || normalized === "zh-hk")
    return "zht"
  if (normalized === "br" || normalized.startsWith("pt")) return "pt"
  const base = normalized.split(/[-_]/)[0]
  return (LANGUAGES as readonly string[]).includes(base) ? (base as Language) : "en"
}
