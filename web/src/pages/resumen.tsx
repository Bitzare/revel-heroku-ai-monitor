// Resumen: cómo está el servicio en el periodo elegido, los cuatro indicadores
// que se vigilan (5xx, p95, Apdex, incidencias), el tráfico con los deploys y
// lo que hay que revisar ahora.

import type { ColumnDef } from "@tanstack/react-table"
import { CircleCheck } from "lucide-react"
import { useMemo } from "react"
import { Link, useNavigate } from "react-router"
import { useApp } from "@/app/app-context"
import { MethodBadge, ServiceStatus, severityBorder } from "@/components/dashboard/badges"
import { CategoryChart, LatencyChart, TrafficChart } from "@/components/dashboard/charts"
import { DataTable } from "@/components/dashboard/data-table"
import { ErrorNote, Fact, KpiCard, Legend, Meter, PageSkeleton, ThresholdStatus } from "@/components/dashboard/indicators"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useApi } from "@/lib/api"
import { ms, number, pct, plural, relativeTime } from "@/lib/format"
import { displayTitle, LIMITS, periodLong, SEVERITY_LABEL, sevRank } from "@/lib/labels"
import type { Health, IssueSummary, RouteStat, Stats } from "@/lib/types"
import { cn } from "@/lib/utils"

function headline(stats: Stats, health: Health | null, active: IssueSummary[]) {
  const t = stats.totals
  if (!t.requests) return "No ha llegado tráfico en este periodo. Revisa las fuentes si debería haberlo."
  const crit = active.filter((i) => i.severity === "critical" && !i.expected).length
  const parts = [`${pct(t.requests ? t.err5 / t.requests : 0)} de respuestas 5xx`]
  if (t.p95 != null) parts.push(`p95 de ${ms(t.p95)}`)
  const lead = parts.join(" y ")
  if (crit) return `${lead}. ${plural(crit, "incidencia crítica abierta", "incidencias críticas abiertas")}: empieza por «Para revisar».`
  if (health?.status === "warning") return `${lead}. Hay incidencias graves recientes; el servicio responde, pero degradado.`
  return `${lead}. Sin incidencias críticas abiertas.`
}

type ReviewItem = { key: string; to: string; tone: string; title: string; detail: string }

function reviewItems(issues: IssueSummary[], health: Health | null): ReviewItem[] {
  const items: ReviewItem[] = []
  for (const s of health?.sources ?? []) {
    if (s.state === "error") items.push({ key: `src-${s.name}`, to: "/sistema", tone: "border-bad", title: `La fuente «${s.label}» no recibe logs`, detail: s.error ?? "" })
  }
  if (health?.ai.enabled && health.ai.ok === false) items.push({ key: "ollama", to: "/sistema", tone: "border-warn", title: "Ollama no responde", detail: "Las incidencias nuevas se quedan sin diagnóstico hasta que vuelva." })
  const hot = issues
    .filter((i) => !i.expected && (i.state === "open") && (sevRank(i.severity) >= sevRank("high") || i.regression || i.spike))
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || Date.parse(b.last_seen) - Date.parse(a.last_seen))
  for (const i of hot) {
    const why = [i.regression && "regresión", i.spike && "pico", i.after_release && `tras ${i.after_release}`].filter(Boolean).join(", ")
    items.push({
      key: `i-${i.id}`, to: `/incidencias/${i.id}`, tone: severityBorder(i.severity),
      title: displayTitle(i),
      detail: `${SEVERITY_LABEL[i.severity]}${why ? ` (${why})` : ""} · ${plural(i.count, "vez", "veces")}, última ${relativeTime(i.last_seen)}`,
    })
  }
  for (const i of issues.filter((x) => x.has_patch && x.state === "open" && !hot.includes(x))) {
    items.push({ key: `p-${i.id}`, to: `/incidencias/${i.id}`, tone: "border-border", title: `Parche listo para revisar: ${displayTitle(i)}`, detail: `${plural(i.count, "vez", "veces")}, última ${relativeTime(i.last_seen)}` })
  }
  const failed = issues.filter((i) => i.analysis_state === "failed")
  if (failed.length) items.push({ key: "failed", to: "/incidencias", tone: "border-border", title: `${plural(failed.length, "diagnóstico falló", "diagnósticos fallaron")}`, detail: "Ábrelas y pulsa «Volver a analizar»." })
  return items
}

const routeColumns: ColumnDef<RouteStat>[] = [
  {
    id: "endpoint", header: "Endpoint", accessorFn: (r) => r.route,
    cell: ({ row }) => (
      <span className="flex min-w-0 items-center gap-2"><MethodBadge method={row.original.method} /><span className="truncate font-mono text-[12.5px]">{row.original.route}</span></span>
    ),
  },
  { accessorKey: "err5", header: "5xx", meta: { numeric: true }, cell: ({ getValue }) => <span className={cn(getValue<number>() > 0 && "font-semibold text-bad")}>{number(getValue<number>())}</span> },
  { accessorKey: "err4", header: "4xx", meta: { numeric: true }, cell: ({ getValue }) => number(getValue<number>()) },
  { accessorKey: "errorRate", header: "% error", meta: { numeric: true }, cell: ({ getValue }) => pct(getValue<number>()) },
]

export function ResumenPage() {
  const { period, health, issuesVersion, metricsVersion, meta } = useApp()
  const navigate = useNavigate()
  const stats = useApi<Stats>(`/api/stats?range=${period}`, metricsVersion)
  const issues = useApi<{ issues: IssueSummary[] }>(`/api/issues?state=active&range=${period}`, issuesVersion)
  const routes = useApi<{ routes: RouteStat[] }>(`/api/routes?range=${period}`, metricsVersion)

  const active = issues.data?.issues ?? []
  const review = useMemo(() => reviewItems(active, health), [active, health])
  const cats = useMemo(() => {
    const by = new Map<string, number>()
    for (const i of active) if (i.severity !== "noise") by.set(i.category, (by.get(i.category) ?? 0) + i.count)
    return [...by.entries()].map(([c, n]) => ({ label: meta.categories[c] ?? c, n })).sort((a, b) => b.n - a.n).slice(0, 8)
  }, [active, meta])
  const topRoutes = useMemo(
    () => (routes.data?.routes ?? []).filter((r) => r.err4 + r.err5 > 0).sort((a, b) => b.err5 - a.err5 || b.err4 + b.err5 - (a.err4 + a.err5)).slice(0, 6),
    [routes.data],
  )

  if (stats.error && !stats.data) return <ErrorNote message={stats.error} />
  if (!stats.data || !issues.data) return <PageSkeleton />

  const s = stats.data
  const t = s.totals
  const rate5 = t.requests ? t.err5 / t.requests : null
  const crit = active.filter((i) => i.severity === "critical" && !i.expected).length
  const high = active.filter((i) => i.severity === "high" && !i.expected).length
  const lastRelease = s.releases[s.releases.length - 1]

  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-5 py-7">
        <CardContent className="flex flex-col gap-6 px-6 md:px-8">
          <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
            <div>
              <h2 className="text-[15px] font-medium text-muted-foreground"><ServiceStatus status={health?.status ?? "unknown"} /></h2>
              <p className="mt-2 mb-2 text-[clamp(2.5rem,5.5vw,3.75rem)] leading-none font-semibold tracking-[-0.03em] tabular">{number(t.requests)}</p>
              <p className="text-[15px] text-muted-foreground">peticiones en {periodLong(period)}</p>
              <p className="mt-3 max-w-[60ch] text-[16px]">{headline(s, health, active)}</p>
            </div>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:flex sm:gap-8">
              <Fact label="Errores 5xx">{number(t.err5)}</Fact>
              <Fact label="Errores 4xx">{number(t.err4)}</Fact>
              <Fact label="Lentas (más de 5 s)">{number(t.slow)}</Fact>
              <Fact label="Latencia p50 / p99">{ms(t.p50)} / {ms(t.p99)}</Fact>
              {lastRelease && <Fact label="Último deploy"><Link to="/deploys" className="underline-offset-4 hover:underline">{lastRelease.version}</Link></Fact>}
            </dl>
          </div>
          <TrafficChart stats={s} className="aspect-auto h-[220px] w-full md:h-[260px]" />
          <Legend items={[
            { label: "Correctas (2xx/3xx)", swatch: "size-2.5 rounded-sm bg-chart-1" },
            { label: "Errores de cliente (4xx)", swatch: "size-2.5 rounded-sm bg-chart-2" },
            { label: "Errores de servidor (5xx y Heroku)", swatch: "size-2.5 rounded-sm bg-chart-3" },
            ...(s.releases.length ? [{ label: "Deploy", swatch: "h-3 border-l-2 border-dashed border-foreground/60" }] : []),
          ]} />
        </CardContent>
      </Card>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Indicadores del periodo">
        <KpiCard label="Tasa de errores 5xx" value={pct(rate5)} sub={`${number(t.err5)} de ${number(t.requests)} peticiones`}>
          <Meter value={rate5} limit={LIMITS.rate5} label={`umbral ${pct(LIMITS.rate5, 0)}`} />
          <ThresholdStatus value={rate5} limit={LIMITS.rate5} />
        </KpiCard>
        <KpiCard label="Latencia p95" value={ms(t.p95)} sub={t.avgMs != null ? `media ${ms(t.avgMs)}` : "sin datos de latencia"}>
          <Meter value={t.p95} limit={LIMITS.p95Ms} label={`umbral ${ms(LIMITS.p95Ms)}`} />
          <ThresholdStatus value={t.p95} limit={LIMITS.p95Ms} />
        </KpiCard>
        <KpiCard label="Apdex" value={t.apdex == null ? "—" : t.apdex.toLocaleString("es-ES", { maximumFractionDigits: 2 })}
          sub="satisfechas ≤ 500 ms, toleradas ≤ 2 s">
          <Meter value={t.apdex} limit={LIMITS.apdex} higherIsBetter label={`mínimo ${LIMITS.apdex.toLocaleString("es-ES")}`} />
          <ThresholdStatus value={t.apdex} limit={LIMITS.apdex} higherIsBetter />
        </KpiCard>
        <KpiCard label="Incidencias activas" value={number(active.filter((i) => i.severity !== "noise").length)}
          valueClassName={crit ? "text-bad" : undefined}
          sub={crit || high ? `${plural(crit, "crítica", "críticas")} y ${plural(high, "alta", "altas")}` : "ninguna crítica ni alta"}>
          <Link to="/incidencias" className="mt-auto pt-3 text-sm font-medium text-primary underline-offset-4 hover:underline">Ver incidencias</Link>
        </KpiCard>
      </section>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <div className="flex flex-col gap-1">
                <CardTitle>Latencia</CardTitle>
                <CardDescription>p95 y media por tramo, según el router de Heroku.</CardDescription>
              </div>
              <Legend items={[
                { label: "p95", swatch: "h-[3px] w-5 rounded bg-chart-5" },
                { label: "Media", swatch: "h-[3px] w-5 rounded bg-chart-4" },
                { label: `Umbral (${ms(LIMITS.p95Ms)})`, swatch: "w-5 border-t-2 border-dashed border-bad/70" },
              ]} />
            </CardHeader>
            <CardContent><LatencyChart stats={s} threshold={LIMITS.p95Ms} className="aspect-auto h-[200px] w-full" /></CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Ocurrencias por categoría</CardTitle>
                <CardDescription>Incidencias activas vistas en el periodo, sin ruido.</CardDescription>
              </CardHeader>
              <CardContent>
                {cats.length ? <CategoryChart data={cats} className="aspect-auto w-full" />
                  : <p className="text-sm text-muted-foreground">No hay incidencias activas en el periodo.</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div className="flex flex-col gap-1">
                  <CardTitle>Endpoints con más errores</CardTitle>
                  <CardDescription>Ordenados por 5xx y después por total de errores.</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="px-2 sm:px-4">
                <DataTable columns={routeColumns} data={topRoutes} empty="Ningún endpoint ha devuelto errores en el periodo."
                  onRowClick={() => navigate("/endpoints")} getRowId={(r) => `${r.method} ${r.route}`} />
              </CardContent>
            </Card>
          </div>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Para revisar</CardTitle>
            {review.length > 0 && <Badge variant="secondary" className="bg-warn-soft text-warn tabular">{review.length}</Badge>}
          </CardHeader>
          <CardContent>
            {review.length ? (
              <ul className="flex flex-col gap-1">
                {review.slice(0, 9).map((item) => (
                  <li key={item.key}>
                    <Link to={item.to} className={cn("flex flex-col gap-0.5 rounded-md border-l-[3px] py-2.5 pr-3 pl-3.5 transition-colors hover:bg-muted/70", item.tone)}>
                      <span className="line-clamp-2 text-[14.5px] font-semibold">{item.title}</span>
                      {item.detail && <span className="text-[13px] text-muted-foreground">{item.detail}</span>}
                    </Link>
                  </li>
                ))}
                {review.length > 9 && <li className="pt-1 text-sm text-muted-foreground">Y {review.length - 9} más en Incidencias.</li>}
              </ul>
            ) : (
              <p className="flex gap-2.5 text-muted-foreground">
                <CircleCheck className="mt-0.5 size-5 shrink-0 text-good" />
                Nada pendiente: no hay incidencias graves abiertas, regresiones ni fuentes caídas.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
