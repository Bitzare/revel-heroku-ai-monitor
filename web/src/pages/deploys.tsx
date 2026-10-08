// Deploys: cada release de Heroku con el tráfico de los 30 minutos anteriores y
// posteriores, y las incidencias que aparecieron justo después.

import { ArrowRight } from "lucide-react"
import { Link } from "react-router"
import { useApp } from "@/app/app-context"
import { MethodBadge, SeverityBadge } from "@/components/dashboard/badges"
import { ErrorNote, PageSkeleton } from "@/components/dashboard/indicators"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useApi } from "@/lib/api"
import { dateTime, ms, number, pct, relativeTime } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { displayTitle } from "@/lib/labels"
import type { Release } from "@/lib/types"
import { cn } from "@/lib/utils"

function verdict(r: Release, { t, tn }: ReturnType<typeof useI18n>) {
  const b = r.before, a = r.after
  if (!a.requests) return { tone: "text-muted-foreground", text: r.complete ? t("Sin tráfico después del deploy.") : t("Aún no hay tráfico después del deploy.") }
  const worse5 = (a.rate5 ?? 0) > Math.max(0.005, (b.rate5 ?? 0) * 2)
  const slower = a.p95 != null && b.p95 != null && a.p95 > b.p95 * 1.5 && a.p95 > 500
  const nNew = tn(r.newIssues, "{n} incidencia nueva", "{n} incidencias nuevas")
  if (r.newIssues && worse5) return { tone: "text-bad", text: t("Empeoró: más 5xx y {n}.", { n: nNew }) }
  if (worse5) return { tone: "text-bad", text: t("La tasa de 5xx subió tras el deploy.") }
  if (slower) return { tone: "text-warn", text: t("La latencia p95 subió tras el deploy.") }
  if (r.newIssues) return { tone: "text-warn", text: t("{n} tras el deploy.", { n: nNew }) }
  return { tone: "text-good", text: r.complete ? t("Sin cambios relevantes.") : t("Sin cambios relevantes por ahora (ventana en curso).") }
}

function Compare({ label, before, after, fmt, worseWhenUp = true }: {
  label: string; before: number | null; after: number | null; fmt: (v: number | null) => string; worseWhenUp?: boolean
}) {
  const worse = before != null && after != null && (worseWhenUp ? after > before * 1.2 : after < before * 0.8) && after !== before
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-1.5 font-semibold tabular">
        <span className="text-muted-foreground">{fmt(before)}</span>
        <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className={cn(worse && "text-bad")}>{fmt(after)}</span>
      </dd>
    </div>
  )
}

export function DeploysPage() {
  const { metricsVersion } = useApp()
  const i18n = useI18n()
  const { t, tn, ts } = i18n
  const { data, error } = useApi<{ releases: Release[] }>(`/api/releases?range=30d`, metricsVersion)

  if (error && !data) return <ErrorNote message={error} />
  if (!data) return <PageSkeleton />

  if (!data.releases.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("Todavía no hay deploys registrados")}</CardTitle>
          <CardDescription>
            {t("Aparecen en cuanto llega a los logs una línea de Heroku del tipo «Release v812 created by …». Cada uno se compara con los 30 minutos anteriores y posteriores: tasa de 5xx, latencia p95 y las incidencias que surgieron justo después.")}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[80ch] text-[15px] text-muted-foreground">
        {t("Últimos 30 días. Cada deploy se compara con los 30 minutos anteriores; una incidencia cuenta como «tras el deploy» si apareció por primera vez en esa media hora.")}
      </p>
      {data.releases.map((r) => {
        const v = verdict(r, i18n)
        const desc = r.description.replace(/^Release v\d+\s*/, "")
        return (
          <Card key={r.id}>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <CardTitle className="flex items-center gap-2 text-lg"><span className="font-mono">{r.version}</span></CardTitle>
                <CardDescription>{dateTime(r.ts)} ({relativeTime(r.ts)}) · {desc || t("sin descripción")}</CardDescription>
              </div>
              <span className={cn("text-sm font-semibold", v.tone)}>{v.text}</span>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <dl className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
                <Compare label={t("Peticiones (30 min)")} before={r.before.requests} after={r.after.requests} fmt={(x) => number(x)} worseWhenUp={false} />
                <Compare label={t("Tasa de 5xx")} before={r.before.rate5} after={r.after.rate5} fmt={(x) => pct(x)} />
                <Compare label={t("Errores 4xx")} before={r.before.err4} after={r.after.err4} fmt={(x) => number(x)} />
                <Compare label={t("Latencia p95")} before={r.before.p95} after={r.after.p95} fmt={(x) => ms(x)} />
              </dl>
              {r.issues.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <h4 className="text-sm font-semibold">{t("Incidencias nuevas tras el deploy")}</h4>
                  <ul className="flex flex-col gap-1">
                    {r.issues.map((i) => (
                      <li key={i.id}>
                        <Link to={`/incidencias/${i.id}`} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/70">
                          <SeverityBadge severity={i.severity} />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-[14px] font-medium">{ts(displayTitle(i))}</span>
                            {i.route && <span className="flex items-center gap-2 text-xs text-muted-foreground"><MethodBadge method={i.method} /><span className="truncate font-mono">{i.route}</span></span>}
                          </span>
                          <span className="text-sm text-muted-foreground tabular">{tn(i.count, "{n} vez", "{n} veces")}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                  {r.newIssues > r.issues.length && <p className="text-sm text-muted-foreground">{t("Y {n} más.", { n: r.newIssues - r.issues.length })}</p>}
                </div>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
