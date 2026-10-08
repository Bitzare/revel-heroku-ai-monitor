// Traducciones (español / inglés). El texto en español es la clave: si falta
// una traducción se ve en español, nunca una clave vacía. El idioma se guarda
// en localStorage y se aplica también a fechas y números.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { EN } from "./i18n-en"

export type Lang = "es" | "en"

let current: Lang = (() => {
  try {
    const saved = localStorage.getItem("guardia-lang")
    if (saved === "es" || saved === "en") return saved
  } catch { /* sin storage */ }
  return navigator.language?.toLowerCase().startsWith("es") ? "es" : "en"
})()

export const getLang = () => current
export const getLocale = () => (current === "en" ? "en-GB" : "es-ES")

type Vars = Record<string, string | number | null | undefined>

function interpolate(s: string, vars?: Vars) {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])))
}

/** Traduce un texto de la interfaz. Úsalo fuera de React solo si no necesitas re-render. */
export function translate(es: string, vars?: Vars) {
  return interpolate(current === "en" ? (EN[es] ?? es) : es, vars)
}

/** Singular o plural según `n`; `{n}` se sustituye con el número formateado. */
export function translatePlural(n: number, one: string, many: string, vars?: Vars) {
  const nf = new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 0, useGrouping: "always" }).format(n)
  return translate(n === 1 ? one : many, { n: nf, ...vars })
}

// ── Textos que genera el servidor (clasificación y títulos automáticos) ──
// Se traducen por patrón; lo que no encaja (mensajes de error de Go) se deja tal cual.
const SERVER_PATTERNS: [RegExp, string][] = [
  [/^Sondeos automáticos de bots \(rutas tipo \.env, wp-admin, \/blog\.\.\.\)$/, "Automated bot probes (.env, wp-admin, /blog... style paths)"],
  [/Sesión ausente o caducada \(habitual\)/g, "Missing or expired session (common)"],
  [/Endpoint inexistente: ¿cliente desactualizado o ruta mal escrita\?/g, "Unknown endpoint: outdated client or mistyped route?"],
  [/Ruta fuera de la API \(sondeo\)/g, "Path outside the API (probe)"],
  [/Ruta típica de escáner automático/g, "Typical scanner path"],
  [/App caída \((H10)\)/g, "App crashed ($1)"],
  [/Timeout de petición \((H12)\)/g, "Request timeout ($1)"],
  [/Conexión cerrada sin respuesta \((H13)\)/g, "Connection closed without response ($1)"],
  [/Sin dynos web \((H14)\)/g, "No web dynos ($1)"],
  [/Conexión inactiva \((H15)\)/g, "Idle connection ($1)"],
  [/Petición interrumpida \((H18)\)/g, "Request interrupted ($1)"],
  [/Timeout de arranque de conexión \((H19)\)/g, "Backend connection timeout ($1)"],
  [/Timeout de arranque de app \((H20)\)/g, "App boot timeout ($1)"],
  [/El cliente cortó la petición \((H27)\)/g, "Client cancelled the request ($1)"],
  [/El cliente cortó la conexión \((H28)\)/g, "Client closed the connection ($1)"],
  [/Modo mantenimiento \((H80)\)/g, "Maintenance mode ($1)"],
  [/App en blanco \((H81)\)/g, "Blank app ($1)"],
  [/Memoria superada \((R14)\)/g, "Memory quota exceeded ($1)"],
  [/Memoria muy superada, dyno reiniciado \((R15)\)/g, "Memory quota vastly exceeded, dyno restarted ($1)"],
  [/Timeout de arranque \((R10)\)/g, "Boot timeout ($1)"],
  [/Timeout de salida \((R12)\)/g, "Exit timeout ($1)"],
  [/Panic en el proceso Go/g, "Panic in the Go process"],
  [/^Panic en (\w+):/, "Panic in $1:"],
  [/El dyno se ha caído/g, "The dyno crashed"],
  [/Evento de plataforma/g, "Platform event"],
  [/Saldo insuficiente \(esperado\)/g, "Insufficient balance (expected)"],
  [/Fallo de red o de servicio externo/g, "Network or external service failure"],
  [/Webhook de Stripe con firma inválida/g, "Stripe webhook with invalid signature"],
  [/Error en un flujo de pago/g, "Error in a payment flow"],
  [/Error de base de datos con 5xx/g, "Database error with 5xx"],
  [/Error de SQL/g, "SQL error"],
  [/Fallo de autenticación/g, "Authentication failure"],
  [/Recurso no encontrado/g, "Resource not found"],
  [/Petición rechazada por datos inválidos/g, "Request rejected due to invalid data"],
  [/El cliente cerró la conexión/g, "Client closed the connection"],
  [/Petición lenta \((\d+) ms\)/g, "Slow request ($1 ms)"],
  [/Error en segundo plano/g, "Background error"],
  [/^Respuesta (\d{3})$/g, "Response $1"],
  [/· Respuesta (\d{3})/g, "· Response $1"],
  // Fuentes
  [/^Fichero (.+)$/, "File $1"],
  [/^Drain de Logplex$/, "Logplex drain"],
  [/^Webhook de n8n$/, "n8n webhook"],
  [/^Ingesta manual$/, "Manual ingest"],
  [/La sesión de logs terminó/g, "The log session ended"],
  [/Token de Heroku inválido o sin permisos sobre la app/g, "Invalid Heroku token or no access to the app"],
  [/La Heroku CLI no tiene sesión: ejecuta "heroku login"/g, "The Heroku CLI is not logged in: run \"heroku login\""],
  [/heroku logs terminó \(código (\d+)\)/g, "heroku logs exited (code $1)"],
  [/Ollama no responde en (\S+):/g, "Ollama is not responding at $1:"],
  [/El modelo (\S+) no está descargado/g, "The model $1 is not downloaded"],
  [/Parche descartado: /g, "Patch discarded: "],
  [/^Imports añadidos:/, "Added imports:"],
  [/el modelo cambió la firma de la función/g, "the model changed the function signature"],
  [/el modelo no devolvió una función/g, "the model did not return a function"],
  [/el modelo devolvió la función sin cambios/g, "the model returned the function unchanged"],
  [/el parche no compila sintácticamente/g, "the patch does not parse"],
  [/la función tiene cambios sin commitear; solo se genera el diff/g, "the function has uncommitted changes; only the diff is generated"],
]

export function translateServer(text: string | null | undefined) {
  if (!text) return text ?? ""
  if (current === "es") return text
  let out = text
  for (const [re, rep] of SERVER_PATTERNS) out = out.replace(re, rep)
  return out
}

interface I18nState {
  lang: Lang
  setLang: (l: Lang) => void
  t: typeof translate
  tn: typeof translatePlural
  ts: typeof translateServer
}

const Ctx = createContext<I18nState | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current)
  const setLang = useCallback((l: Lang) => {
    current = l
    try { localStorage.setItem("guardia-lang", l) } catch { /* sin storage */ }
    document.documentElement.lang = l
    setLangState(l)
  }, [])
  // Las funciones cambian de identidad con el idioma para que los useMemo que dependen de ellas se recalculen.
  const value = useMemo<I18nState>(() => ({
    lang, setLang,
    t: (es, vars) => translate(es, vars),
    tn: (n, one, many, vars) => translatePlural(n, one, many, vars),
    ts: (text) => translateServer(text),
  }), [lang, setLang])
  document.documentElement.lang = lang
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useI18n() {
  const v = useContext(Ctx)
  if (!v) throw new Error("useI18n fuera de I18nProvider")
  return v
}
