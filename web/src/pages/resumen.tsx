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
import { decimal, ms, number, pct, relativeTime } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { CATEGORY_LABEL, displayTitle, LIMITS, periodLong, SEVERITY_LABEL, sevRank } from "@/lib/labels"
import type { Health, IssueSummary, RouteStat, Stats } from "@/lib/types"
import { cn } from "@/lib/utils"

type T = ReturnType<typeof useI18n>

function headline(stats: Stats, health: Health | null, active: IssueSummary[], { t, tn }: T) {
  const tot = stats.totals
  if (!tot.requests) return t("No ha llegado tráfico en este periodo. Revisa las fuentes si debería haberlo.")
  const crit = active.filter((i) => i.severity === "critical" && !i.expected).length
  const lead = tot.p95 != null
    ? t("{rate} de respuestas 5xx y p95 de {p95}", { rate: pct(tot.err5 / tot.requests), p95: ms(tot.p95) })
    : t("{rate} de respuestas 5xx", { rate: pct(tot.err5 / tot.requests) })
  if (crit) return `${lead}. ${tn(crit, "{n} incidencia crítica abierta", "{n} incidencias críticas abiertas")}: ${t("empieza por «Para revisar».")}`
  if (health?.status === "warning") return `${lead}. ${t("Hay incidencias graves recientes; el servicio responde, pero degradado.")}`
  return `${lead}. ${t("Sin incidencias críticas abiertas.")}`
}

type ReviewItem = { key: string; to: string; tone: string; title: string; detail: string }

function reviewItems(issues: IssueSummary[], health: Health | null, { t, tn, ts }: T): ReviewItem[] {
  const items: ReviewItem[] = []
  for (const s of health?.sources ?? []) {
    if (s.state === "error") items.push({ key: `src-${s.name}`, to: "/sistema", tone: "border-bad", title: t("La fuente «{name}» no recibe logs", { name: ts(s.label) }), detail: ts(s.error ?? "") })
  }
  if (health?.ai.enabled && health.ai.ok === false) items.push({ key: "ollama", to: "/sistema", tone: "border-warn", title: t("Ollama no responde"), detail: t("Las incidencias nuevas se quedan sin diagnóstico hasta que vuelva.") })
  const hot = issues
    .filter((i) => !i.expected && i.state === "open" && (sevRank(i.severity) >= sevRank("high") || i.regression || i.spike))
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || Date.parse(b.last_seen) - Date.parse(a.last_seen))
  const times = (i: IssueSummary) => t("{times}, última {when}", { times: tn(i.count, "{n} vez", "{n} veces"), when: relativeTime(i.last_seen) })
  for (const i of hot) {
    const why = [i.regression && t("regresión"), i.spike && t("pico"), i.after_release && t("tras {v}", { v: i.after_release })].filter(Boolean).join(", ")
    items.push({
      key: `i-${i.id}`, to: `/incidencias/${i.id}`, tone: severityBorder(i.severity),
      title: ts(displayTitle(i)),
      detail: `${t(SEVERITY_LABEL[i.severity])}${why ? ` (${why})` : ""} · ${times(i)}`,
    })
  }
  for (const i of issues.filter((x) => x.has_patch && x.state === "open" && !hot.includes(x))) {
    items.push({ key: `p-${i.id}`, to: `/incidencias/${i.id}`, tone: "border-border", title: t("Parche listo para revisar: {title}", { title: ts(displayTitle(i)) }), detail: times(i) })
  }
  const failed = issues.filter((i) => i.analysis_state === "failed")
  if (failed.length) items.push({ key: "failed", to: "/incidencias", tone: "border-border", title: tn(failed.length, "{n} diagnóstico falló", "{n} diagnósticos fallaron"), detail: t("Ábrelas y pulsa «Volver a analizar».") })
  return items
}

export function ResumenPage() {
  const { period, health, issuesVersion, metricsVersion } = useApp()
  const i18n = useI18n()
  const { t, tn } = i18n
  const navigate = useNavigate()
  const stats = useApi<Stats>(`/api/stats?range=${period}`, metricsVersion)
  const issues = useApi<{ issues: IssueSummary[] }>(`/api/issues?state=active&range=${period}`, issuesVersion)
  const routes = useApi<{ routes: RouteStat[] }>(`/api/routes?range=${period}`, metricsVersion)

  const active = issues.data?.issues ?? []
  const review = useMemo(() => reviewItems(active, health, i18n), [active, health, i18n])
  const cats = useMemo(() => {
    const by = new Map<string, number>()
    for (const i of active) if (i.severity !== "noise") by.set(i.category, (by.get(i.category) ?? 0) + i.count)
    return [...by.entries()].map(([c, n]) => ({ label: t(CATEGORY_LABEL[c] ?? c), n })).sort((a, b) => b.n - a.n).slice(0, 8)
  }, [active, t])
  const topRoutes = useMemo(
    () => (routes.data?.routes ?? []).filter((r) => r.err4 + r.err5 > 0).sort((a, b) => b.err5 - a.err5 || b.err4 + b.err5 - (a.err4 + a.err5)).slice(0, 6),
    [routes.data],
  )
  const routeColumns = useMemo<ColumnDef<RouteStat>[]>(() => [
    {
      id: "endpoint", header: "Endpoint", accessorFn: (r) => r.route,
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-2" title={row.original.route}><MethodBadge method={row.original.method} /><span className="block max-w-[11rem] truncate font-mono text-[12.5px] 2xl:max-w-[16rem]">{row.original.route}</span></span>
      ),
    },
    { accessorKey: "err5", header: "5xx", meta: { numeric: true }, cell: ({ getValue }) => <span className={cn(getValue<number>() > 0 && "font-semibold text-bad")}>{number(getValue<number>())}</span> },
    { accessorKey: "err4", header: "4xx", meta: { numeric: true }, cell: ({ getValue }) => number(getValue<number>()) },
    { accessorKey: "errorRate", header: t("% error"), meta: { numeric: true }, cell: ({ getValue }) => pct(getValue<number>()) },
  ], [t])

  if (stats.error && !stats.data) return <ErrorNote message={stats.error} />
  if (!stats.data || !issues.data) return <PageSkeleton />

  const s = stats.data
  const tot = s.totals
  const rate5 = tot.requests ? tot.err5 / tot.requests : null
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
              <p className="mt-2 mb-2 text-[clamp(2.5rem,5.5vw,3.75rem)] leading-none font-semibold tracking-[-0.03em] tabular">{number(tot.requests)}</p>
              <p className="text-[15px] text-muted-foreground">{t("peticiones en {period}", { period: t(periodLong(period)) })}</p>
              <p className="mt-3 max-w-[60ch] text-[16px]">{headline(s, health, active, i18n)}</p>
            </div>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:flex sm:gap-8">
              <Fact label={t("Errores 5xx")}>{number(tot.err5)}</Fact>
              <Fact label={t("Errores 4xx")}>{number(tot.err4)}</Fact>
              <Fact label={t("Lentas (más de 5 s)")}>{number(tot.slow)}</Fact>
              <Fact label={t("Latencia p50 / p99")}>{ms(tot.p50)} / {ms(tot.p99)}</Fact>
              {lastRelease && <Fact label={t("Último deploy")}><Link to="/deploys" className="underline-offset-4 hover:underline">{lastRelease.version}</Link></Fact>}
            </dl>
          </div>
          <TrafficChart stats={s} className="aspect-auto h-[220px] w-full md:h-[260px]" />
          <Legend items={[
            { label: t("Correctas (2xx/3xx)"), swatch: "size-2.5 rounded-sm bg-chart-1" },
            { label: t("Errores de cliente (4xx)"), swatch: "size-2.5 rounded-sm bg-chart-2" },
            { label: t("Errores de servidor (5xx y Heroku)"), swatch: "size-2.5 rounded-sm bg-chart-3" },
            ...(s.releases.length ? [{ label: "Deploy", swatch: "h-3 border-l-2 border-dashed border-foreground/60" }] : []),
          ]} />
        </CardContent>
      </Card>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label={t("Indicadores del periodo")}>
        <KpiCard label={t("Tasa de errores 5xx")} value={pct(rate5)} sub={t("{a} de {b} peticiones", { a: number(tot.err5), b: number(tot.requests) })}>
          <Meter value={rate5} limit={LIMITS.rate5} label={t("umbral {v}", { v: pct(LIMITS.rate5, 0) })} />
          <ThresholdStatus value={rate5} limit={LIMITS.rate5} />
        </KpiCard>
        <KpiCard label={t("Latencia p95")} value={ms(tot.p95)} sub={tot.avgMs != null ? t("media {v}", { v: ms(tot.avgMs) }) : t("sin datos de latencia")}>
          <Meter value={tot.p95} limit={LIMITS.p95Ms} label={t("umbral {v}", { v: ms(LIMITS.p95Ms) })} />
          <ThresholdStatus value={tot.p95} limit={LIMITS.p95Ms} />
        </KpiCard>
        <KpiCard label="Apdex" value={decimal(tot.apdex)} sub={t("satisfechas ≤ 500 ms, toleradas ≤ 2 s")}>
          <Meter value={tot.apdex} limit={LIMITS.apdex} higherIsBetter label={t("mínimo {v}", { v: decimal(LIMITS.apdex) })} />
          <ThresholdStatus value={tot.apdex} limit={LIMITS.apdex} higherIsBetter />
        </KpiCard>
        <KpiCard label={t("Incidencias activas")} value={number(active.filter((i) => i.severity !== "noise").length)}
          valueClassName={crit ? "text-bad" : undefined}
          sub={crit || high ? t("{a} y {b}", { a: tn(crit, "{n} crítica", "{n} críticas"), b: tn(high, "{n} alta", "{n} altas") }) : t("ninguna crítica ni alta")}>
          <Link to="/incidencias" className="mt-auto pt-3 text-sm font-medium text-primary underline-offset-4 hover:underline">{t("Ver incidencias")}</Link>
        </KpiCard>
      </section>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <div className="flex flex-col gap-1">
                <CardTitle>{t("Latencia")}</CardTitle>
                <CardDescription>{t("p95 y media por tramo, según el router de Heroku.")}</CardDescription>
              </div>
              <Legend items={[
                { label: "p95", swatch: "h-[3px] w-5 rounded bg-chart-5" },
                { label: t("Promedio"), swatch: "h-[3px] w-5 rounded bg-chart-4" },
                { label: t("Umbral ({v})", { v: ms(LIMITS.p95Ms) }), swatch: "w-5 border-t-2 border-dashed border-bad/70" },
              ]} />
            </CardHeader>
            <CardContent><LatencyChart stats={s} threshold={LIMITS.p95Ms} className="aspect-auto h-[200px] w-full" /></CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t("Ocurrencias por categoría")}</CardTitle>
                <CardDescription>{t("Incidencias activas vistas en el periodo, sin ruido.")}</CardDescription>
              </CardHeader>
              <CardContent>
                {cats.length ? <CategoryChart data={cats} className="aspect-auto w-full" />
                  : <p className="text-sm text-muted-foreground">{t("No hay incidencias activas en el periodo.")}</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("Endpoints con más errores")}</CardTitle>
                <CardDescription>{t("Ordenados por 5xx y después por total de errores.")}</CardDescription>
              </CardHeader>
              <CardContent className="px-2 sm:px-4">
                <DataTable columns={routeColumns} data={topRoutes} empty={t("Ningún endpoint ha devuelto errores en el periodo.")}
                  onRowClick={() => navigate("/endpoints")} getRowId={(r) => `${r.method} ${r.route}`} />
              </CardContent>
            </Card>
          </div>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>{t("Para revisar")}</CardTitle>
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
                {review.length > 9 && <li className="pt-1 text-sm text-muted-foreground">{t("Y {n} más en Incidencias.", { n: review.length - 9 })}</li>}
              </ul>
            ) : (
              <p className="flex gap-2.5 text-muted-foreground">
                <CircleCheck className="mt-0.5 size-5 shrink-0 text-good" />
                {t("Nada pendiente: no hay incidencias graves abiertas, regresiones ni fuentes caídas.")}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
