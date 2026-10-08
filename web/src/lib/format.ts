// Formato de números, duraciones y fechas (es-ES).

const num0 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0, useGrouping: "always" })

export const number = (n: number | null | undefined) => (n == null ? "—" : num0.format(n))

/** Porcentaje a partir de una fracción (0,0123 → "1,2 %"). Con muy poco, más decimales. */
export function pct(frac: number | null | undefined, digits?: number) {
  if (frac == null || !Number.isFinite(frac)) return "—"
  const v = frac * 100
  const d = digits ?? (v !== 0 && Math.abs(v) < 1 ? 2 : 1)
  return `${v.toLocaleString("es-ES", { minimumFractionDigits: d, maximumFractionDigits: d })} %`
}

/** 480 ms / 1,2 s / 31 s */
export function ms(n: number | null | undefined) {
  if (n == null) return "—"
  if (n < 1000) return `${num0.format(n)} ms`
  return `${(n / 1000).toLocaleString("es-ES", { maximumFractionDigits: n < 10000 ? 1 : 0 })} s`
}

export const plural = (n: number, one: string, many: string) => `${num0.format(n)} ${n === 1 ? one : many}`
export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** "hace 3 min", "hace 2 h", "ayer", "12 oct" */
export function relativeTime(iso: string | null | undefined) {
  if (!iso) return "—"
  const d = new Date(iso)
  const secs = Math.round((Date.now() - d.getTime()) / 1000)
  if (secs < 0) return "ahora"
  if (secs < 60) return `hace ${secs} s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `hace ${mins} min`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `hace ${hours} h`
  const days = Math.round(hours / 24)
  if (days === 1) return "ayer"
  if (days < 7) return `hace ${days} días`
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short" })
}

/** "8 oct, 14:07:04" */
export function dateTime(iso: string | null | undefined, seconds = false) {
  if (!iso) return "—"
  const d = new Date(iso)
  return `${d.toLocaleDateString("es-ES", { day: "numeric", month: "short" })}, ${d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined })}`
}

export const clock = (iso: string, seconds = true) =>
  new Date(iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined })

/** Etiqueta del eje X según el tamaño del tramo. */
export function bucketLabel(iso: string, bucketMinutes: number) {
  const d = new Date(iso)
  if (bucketMinutes >= 720) return d.toLocaleDateString("es-ES", { day: "numeric", month: "short" })
  if (bucketMinutes >= 60) return `${d.toLocaleDateString("es-ES", { day: "numeric", month: "short" })} ${d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`
  return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
}
