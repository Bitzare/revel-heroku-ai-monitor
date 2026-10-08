// Textos de la interfaz para los valores que devuelve el monitor.

import type { IssueState, Severity } from "./types"

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Crítica", high: "Alta", medium: "Media", low: "Baja", noise: "Ruido",
}
export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "noise"]
export const sevRank = (s: Severity) => SEVERITY_ORDER.length - SEVERITY_ORDER.indexOf(s)

export const STATE_LABEL: Record<IssueState, string> = {
  open: "Abierta", ack: "Reconocida", resolved: "Resuelta", ignored: "Ignorada",
}

export const KIND_LABEL: Record<string, string> = {
  backend_bug: "Bug del backend",
  client_error: "Error del cliente",
  expected: "Comportamiento esperado",
  infrastructure: "Infraestructura",
  data: "Datos inconsistentes",
  configuration: "Configuración",
  attack: "Ataque o abuso",
}

export const FLAG_LABEL: Record<string, string> = {
  error_no_literal: "El error que cita el diagnóstico no aparece literalmente en los logs.",
  fichero_inventado: "El diagnóstico menciona un fichero que no existe en el backend.",
  funcion_no_encontrada: "La función mencionada no está en el índice de código.",
}

export const SOURCE_STATE_LABEL: Record<string, string> = {
  live: "Recibiendo", connecting: "Conectando", reconnecting: "Reconectando", error: "Error",
  idle: "En espera", done: "Terminada", stopped: "Parada",
}

export const PERIODS = [
  { key: "15m", label: "15 min", menu: "Últimos 15 min", long: "los últimos 15 minutos" },
  { key: "1h", label: "1 h", menu: "Última hora", long: "la última hora" },
  { key: "6h", label: "6 h", menu: "Últimas 6 horas", long: "las últimas 6 horas" },
  { key: "24h", label: "24 h", menu: "Últimas 24 horas", long: "las últimas 24 horas" },
  { key: "7d", label: "7 días", menu: "Últimos 7 días", long: "los últimos 7 días" },
  { key: "30d", label: "30 días", menu: "Últimos 30 días", long: "los últimos 30 días" },
] as const
export type PeriodKey = (typeof PERIODS)[number]["key"]
export const periodLong = (k: PeriodKey) => PERIODS.find((p) => p.key === k)?.long ?? ""

// Umbrales de los indicadores del resumen
export const LIMITS = { rate5: 0.01, p95Ms: 1000, apdex: 0.85 }

/**
 * Título para mostrar: el del diagnóstico si lo hay; si no, el automático sin
 * el prefijo "MÉTODO /ruta → status · ", que ya se enseña aparte.
 */
export function displayTitle(i: { title: string; ai_title?: string | null; route?: string | null; method?: string | null }) {
  if (i.ai_title) return i.ai_title
  if (i.route && i.title.startsWith(`${i.method} ${i.route}`)) {
    const rest = i.title.split(" · ").slice(1).join(" · ")
    if (rest) return rest.charAt(0).toUpperCase() + rest.slice(1)
  }
  return i.title
}
