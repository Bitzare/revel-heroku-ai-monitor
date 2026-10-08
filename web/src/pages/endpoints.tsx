// Endpoints: tráfico, errores y latencia de cada ruta de routes*.go en el periodo.

import type { ColumnDef } from "@tanstack/react-table"
import { Search } from "lucide-react"
import { useMemo, useState } from "react"
import { Link } from "react-router"
import { useApp } from "@/app/app-context"
import { MethodBadge, SeverityBadge } from "@/components/dashboard/badges"
import { DataTable } from "@/components/dashboard/data-table"
import { ErrorNote, PageSkeleton } from "@/components/dashboard/indicators"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useApi } from "@/lib/api"
import { ms, number, pct } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { LIMITS, periodLong } from "@/lib/labels"
import type { RouteStat } from "@/lib/types"
import { cn } from "@/lib/utils"

export function EndpointsPage() {
  const { period, metricsVersion } = useApp()
  const { t, tn } = useI18n()
  const { data, error } = useApi<{ routes: RouteStat[] }>(`/api/routes?range=${period}`, metricsVersion)
  const [q, setQ] = useState("")
  const [only, setOnly] = useState<"all" | "errors" | "slow">("all")

  const columns = useMemo<ColumnDef<RouteStat>[]>(() => [
    {
      id: "endpoint", header: "Endpoint", accessorFn: (r) => r.route,
      cell: ({ row }) => (
        <div className="flex min-w-[18rem] flex-col gap-0.5">
          <span className="flex items-center gap-2"><MethodBadge method={row.original.method} /><span className="font-mono text-[12.5px]">{row.original.route}</span></span>
          {row.original.handler
            ? <span className="pl-14 font-mono text-[11.5px] text-muted-foreground">{row.original.handler}</span>
            : <span className="pl-14 text-[11.5px] text-warn">{t("No existe en routes*.go")}</span>}
        </div>
      ),
    },
    { accessorKey: "requests", header: t("Peticiones"), meta: { numeric: true }, cell: ({ getValue }) => number(getValue<number>()) },
    {
      accessorKey: "err5", header: "5xx", meta: { numeric: true },
      cell: ({ row }) => <span className={cn(row.original.err5 > 0 && "font-semibold text-bad")}>{number(row.original.err5)}</span>,
    },
    { accessorKey: "err4", header: "4xx", meta: { numeric: true }, cell: ({ getValue }) => number(getValue<number>()) },
    {
      accessorKey: "errorRate", header: t("% error"), meta: { numeric: true },
      cell: ({ getValue }) => { const v = getValue<number>(); return <span className={cn(v >= 0.2 && "font-semibold text-warn")}>{pct(v)}</span> },
    },
    { accessorKey: "p50", header: "p50", meta: { numeric: true }, cell: ({ getValue }) => ms(getValue<number | null>()) },
    {
      accessorKey: "p95", header: "p95", meta: { numeric: true },
      cell: ({ getValue }) => { const v = getValue<number | null>(); return <span className={cn(v != null && v > LIMITS.p95Ms && "font-semibold text-warn")}>{ms(v)}</span> },
    },
    { accessorKey: "slow", header: t("Lentas"), meta: { numeric: true }, cell: ({ getValue }) => (getValue<number>() ? number(getValue<number>()) : "—") },
    {
      accessorKey: "openIssues", header: t("Incidencias"), meta: { numeric: true },
      cell: ({ row }) => row.original.openIssues
        ? <span className="inline-flex items-center justify-end gap-2">{row.original.worstSeverity && <SeverityBadge severity={row.original.worstSeverity} />}<span className="font-semibold">{row.original.openIssues}</span></span>
        : "—",
    },
  ], [t])

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    return (data?.routes ?? []).filter((r) =>
      (!term || r.route.toLowerCase().includes(term) || (r.handler ?? "").toLowerCase().includes(term)) &&
      (only === "all" || (only === "errors" ? r.err4 + r.err5 > 0 : (r.p95 ?? 0) > LIMITS.p95Ms || r.slow > 0)))
  }, [data, q, only])

  if (error && !data) return <ErrorNote message={error} />
  if (!data) return <PageSkeleton />

  const all = data.routes
  const total = all.reduce((a, r) => a + r.requests, 0)
  const unknown = all.filter((r) => !r.handler).length

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-col gap-4">
          <div className="flex w-full flex-wrap items-baseline justify-between gap-2">
            <CardTitle>{t("Endpoints con tráfico en {period}", { period: t(periodLong(period)) })}</CardTitle>
            <CardDescription>
              {t("{a} y {b}.", { a: tn(all.length, "{n} endpoint", "{n} endpoints"), b: tn(total, "{n} petición", "{n} peticiones") })}
              {unknown > 0 && ` ${tn(unknown, "{n} ruta llamada no existe en routes*.go.", "{n} rutas llamadas no existen en routes*.go.")}`}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-60 flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Buscar ruta o handler")} className="pl-8" aria-label={t("Buscar")} />
            </div>
            <ToggleGroup type="single" variant="outline" size="sm" value={only} onValueChange={(v) => v && setOnly(v as typeof only)} aria-label={t("Filtro")}>
              <ToggleGroupItem value="all" className="px-3">{t("Todos")}</ToggleGroupItem>
              <ToggleGroupItem value="errors" className="px-3">{t("Con errores")}</ToggleGroupItem>
              <ToggleGroupItem value="slow" className="px-3">{t("Lentos")}</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </CardHeader>
        <CardContent className="px-2 sm:px-4">
          <DataTable columns={columns} data={rows} getRowId={(r) => `${r.method} ${r.route}`}
            initialSort={[{ id: "err5", desc: true }, { id: "requests", desc: true }]}
            empty={all.length ? t("Ningún endpoint con estos filtros.") : t("Todavía no hay tráfico registrado en este periodo.")} />
        </CardContent>
      </Card>
      <p className="text-[13px] text-muted-foreground">
        {t("Las latencias salen del campo service del router de Heroku; p50 y p95 son aproximados por tramos.")}{" "}
        {t("Las incidencias activas de cada endpoint se ven en")} <Link to="/incidencias" className="text-primary underline-offset-4 hover:underline">{t("Incidencias")}</Link>.
      </p>
    </div>
  )
}
