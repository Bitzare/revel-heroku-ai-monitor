// Mapa de secciones: la barra lateral y la cabecera se construyen a partir de aquí.

import type { LucideIcon } from "lucide-react"
import { Activity, ChartNoAxesColumn, GitCommitVertical, ListChecks, Route, Settings2 } from "lucide-react"

export interface RouteMeta {
  path: string
  title: string
  nav?: string
  icon: LucideIcon
  /** La página depende del periodo elegido (muestra el selector). */
  period?: boolean
  group: "main" | "ops"
}

export const ROUTES: RouteMeta[] = [
  { path: "/", title: "Resumen", icon: ChartNoAxesColumn, period: true, group: "main" },
  { path: "/incidencias", title: "Incidencias", icon: ListChecks, period: true, group: "main" },
  { path: "/endpoints", title: "Endpoints", icon: Route, period: true, group: "main" },
  { path: "/deploys", title: "Deploys", icon: GitCommitVertical, group: "main" },
  { path: "/directo", title: "En directo", icon: Activity, group: "ops" },
  { path: "/sistema", title: "Fuentes y ajustes", nav: "Fuentes y ajustes", icon: Settings2, group: "ops" },
]

export function routeFor(pathname: string) {
  if (pathname.startsWith("/incidencias/")) return { ...ROUTES[1], title: "Incidencia", period: false, detail: true }
  return ROUTES.find((r) => r.path === pathname)
}
