// Estado global: salud del monitor, periodo elegido, metadatos y la conexión
// en vivo (SSE). Las páginas se suscriben a `issuesVersion` / `metricsVersion`
// para recargar sus datos cuando llega algo nuevo.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { apiGet } from "@/lib/api"
import type { PeriodKey } from "@/lib/labels"
import type { Health, IssueSummary, Meta, TailLine } from "@/lib/types"

interface AppState {
  health: Health | null
  meta: Meta
  period: PeriodKey
  setPeriod: (p: PeriodKey) => void
  connected: boolean
  lastEventAt: number | null
  issuesVersion: number
  metricsVersion: number
  tail: TailLine[]
  paused: boolean
  setPaused: (v: boolean) => void
  theme: "light" | "dark"
  toggleTheme: () => void
  onIssue: (fn: (i: IssueSummary, isNew: boolean) => void) => () => void
}

const Ctx = createContext<AppState | null>(null)

const readLS = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const writeLS = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* sin storage */ } }

export function AppProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null)
  const [meta, setMeta] = useState<Meta>({ categories: {}, severities: [], app: "revel", model: "", autofixMode: "" })
  const [period, setPeriodState] = useState<PeriodKey>(() => (readLS("guardia-period") as PeriodKey) || "24h")
  const [connected, setConnected] = useState(false)
  const [lastEventAt, setLastEventAt] = useState<number | null>(null)
  const [issuesVersion, setIssuesVersion] = useState(0)
  const [metricsVersion, setMetricsVersion] = useState(0)
  const [tail, setTail] = useState<TailLine[]>([])
  const [paused, setPaused] = useState(false)
  const [theme, setTheme] = useState<"light" | "dark">(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"))
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const issueListeners = useRef(new Set<(i: IssueSummary, isNew: boolean) => void>())

  const setPeriod = useCallback((p: PeriodKey) => { setPeriodState(p); writeLS("guardia-period", p) }, [])
  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark"
      document.documentElement.classList.toggle("dark", next === "dark")
      writeLS("guardia-theme", next)
      return next
    })
  }, [])
  const onIssue = useCallback((fn: (i: IssueSummary, isNew: boolean) => void) => {
    issueListeners.current.add(fn)
    return () => { issueListeners.current.delete(fn) }
  }, [])

  useEffect(() => {
    apiGet<Meta>("/api/meta").then(setMeta).catch(() => {})
    apiGet<Health>("/api/health").then(setHealth).catch(() => {})
    apiGet<{ tail: TailLine[] }>("/api/tail").then((d) => setTail(d.tail)).catch(() => {})
  }, [])

  // Recargas agrupadas: muchos eventos seguidos producen una sola recarga.
  const bump = useRef<{ issues?: number; metrics?: number }>({})
  const schedule = useCallback((kind: "issues" | "metrics") => {
    if (bump.current[kind]) return
    bump.current[kind] = window.setTimeout(() => {
      bump.current[kind] = undefined
      if (kind === "issues") setIssuesVersion((v) => v + 1)
      else setMetricsVersion((v) => v + 1)
    }, kind === "issues" ? 1200 : 4000)
  }, [])

  useEffect(() => {
    const es = new EventSource("/api/stream")
    const touch = () => setLastEventAt(Date.now())
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.addEventListener("hello", (e) => { setHealth(JSON.parse((e as MessageEvent).data).health); setConnected(true) })
    es.addEventListener("health", (e) => { setHealth(JSON.parse((e as MessageEvent).data)); touch() })
    es.addEventListener("req", () => { touch(); schedule("metrics") })
    es.addEventListener("release", () => { touch(); schedule("metrics") })
    es.addEventListener("issue", (e) => {
      const { issue, isNew } = JSON.parse((e as MessageEvent).data) as { issue: IssueSummary; isNew?: boolean }
      touch()
      issueListeners.current.forEach((fn) => fn(issue, !!isNew))
      schedule("issues")
    })
    es.addEventListener("tail", (e) => {
      touch()
      if (pausedRef.current) return
      const line = JSON.parse((e as MessageEvent).data) as TailLine
      setTail((t) => (t.length > 800 ? [...t.slice(-600), line] : [...t, line]))
    })
    return () => es.close()
  }, [schedule])

  const value = useMemo<AppState>(() => ({
    health, meta, period, setPeriod, connected, lastEventAt, issuesVersion, metricsVersion, tail, paused, setPaused, theme, toggleTheme, onIssue,
  }), [health, meta, period, setPeriod, connected, lastEventAt, issuesVersion, metricsVersion, tail, paused, theme, toggleTheme, onIssue])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useApp() {
  const v = useContext(Ctx)
  if (!v) throw new Error("useApp fuera de AppProvider")
  return v
}
