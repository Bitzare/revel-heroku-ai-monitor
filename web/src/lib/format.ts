// Formato de números, duraciones y fechas en el idioma elegido (es-ES / en-GB).

import { getLang, getLocale, translate, translatePlural } from "./i18n"

const nf = () => new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 0, useGrouping: "always" })

export const number = (n: number | null | undefined) => (n == null ? "—" : nf().format(n))

/** Porcentaje a partir de una fracción (0,0123 → "1,2 %" / "1.2%"). Con muy poco, más decimales. */
export function pct(frac: number | null | undefined, digits?: number) {
  if (frac == null || !Number.isFinite(frac)) return "—"
  const v = frac * 100
  const d = digits ?? (v !== 0 && Math.abs(v) < 1 ? 2 : 1)
  const s = v.toLocaleString(getLocale(), { minimumFractionDigits: d, maximumFractionDigits: d })
  return getLang() === "en" ? `${s}%` : `${s} %`
}

/** 480 ms / 1,2 s / 31 s */
export function ms(n: number | null | undefined) {
  if (n == null) return "—"
  if (n < 1000) return `${nf().format(n)} ms`
  return `${(n / 1000).toLocaleString(getLocale(), { maximumFractionDigits: n < 10000 ? 1 : 0 })} s`
}

export const decimal = (n: number | null | undefined, digits = 2) =>
  n == null ? "—" : n.toLocaleString(getLocale(), { maximumFractionDigits: digits })

/** Texto con número: plural("{n} incidencia", "{n} incidencias") ya traducido. */
export const plural = (n: number, one: string, many: string) => translatePlural(n, one, many)

/** "hace 3 min" / "3 min ago", "ayer" / "yesterday", "12 oct" */
export function relativeTime(iso: string | null | undefined) {
  if (!iso) return "—"
  const d = new Date(iso)
  const secs = Math.round((Date.now() - d.getTime()) / 1000)
  if (secs < 0) return translate("ahora")
  if (secs < 60) return translate("hace {n} s", { n: secs })
  const mins = Math.round(secs / 60)
  if (mins < 60) return translate("hace {n} min", { n: mins })
  const hours = Math.round(mins / 60)
  if (hours < 24) return translate("hace {n} h", { n: hours })
  const days = Math.round(hours / 24)
  if (days === 1) return translate("ayer")
  if (days < 7) return translate("hace {n} días", { n: days })
  return d.toLocaleDateString(getLocale(), { day: "numeric", month: "short" })
}

/** "8 oct, 14:07" / "8 Oct, 14:07" */
export function dateTime(iso: string | null | undefined, seconds = false) {
  if (!iso) return "—"
  const d = new Date(iso)
  return `${d.toLocaleDateString(getLocale(), { day: "numeric", month: "short" })}, ${d.toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined })}`
}

export const clock = (iso: string, seconds = true) =>
  new Date(iso).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined })

/** Etiqueta del eje X según el tamaño del tramo. */
export function bucketLabel(iso: string, bucketMinutes: number) {
  const d = new Date(iso)
  const loc = getLocale()
  if (bucketMinutes >= 720) return d.toLocaleDateString(loc, { day: "numeric", month: "short" })
  if (bucketMinutes >= 60) return `${d.toLocaleDateString(loc, { day: "numeric", month: "short" })} ${d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" })}`
  return d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" })
}
