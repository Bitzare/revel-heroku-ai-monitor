// Detalle de una incidencia: qué es, desde cuándo, a quién afecta, el
// diagnóstico, las líneas de log que lo prueban, el código y el parche.

import { ArrowLeft, Check, Copy, Eye, EyeOff, GitBranch, RotateCcw, Stethoscope } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { Link, useParams } from "react-router"
import { toast } from "sonner"
import { useApp } from "@/app/app-context"
import { AnalysisBadge, MethodBadge, SeverityBadge, StateBadge, Tag } from "@/components/dashboard/badges"
import { ActivityChart } from "@/components/dashboard/charts"
import { ErrorNote, PageSkeleton } from "@/components/dashboard/indicators"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { apiPost, useApi } from "@/lib/api"
import { clock, dateTime, ms, number, pct, relativeTime } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { CATEGORY_LABEL, displayTitle, FLAG_LABEL, KIND_LABEL } from "@/lib/labels"
import type { Analysis, IssueDetail, IssueFull, IssueState } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Texto del modelo: `código` → <code>. */
function Rich({ text }: { text: string | null | undefined }) {
  if (!text) return null
  const parts = text.split(/(`[^`\n]{1,160}`)/g)
  return <>{parts.map((p, i) => p.startsWith("`") && p.endsWith("`") && p.length > 2
    ? <code key={i} className="rounded border bg-code px-1 py-px font-mono text-[0.85em]">{p.slice(1, -1)}</code>
    : <span key={i}>{p}</span>)}</>
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n()
  const [done, setDone] = useState(false)
  return (
    <Button variant="outline" size="sm" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1800) } catch { toast.error(t("No se pudo copiar al portapapeles")) }
    }}>
      {done ? <Check /> : <Copy />}{done ? t("Copiado") : label ?? t("Copiar")}
    </Button>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9.5rem_1fr] gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function fixSteps(a: Analysis) {
  const parts = String(a.fix || "").split(/(?:^|\s)\d\.\s+/).map((x) => x.trim()).filter(Boolean)
  if (parts.length >= 2) return { intro: null, steps: parts }
  return { intro: a.fix, steps: (a.fix_steps || []).filter((s) => s.length > 3) }
}

function DiagnosisCard({ issue, onAnalyze, busy }: { issue: IssueFull; onAnalyze: () => void; busy: boolean }) {
  const { t, ts } = useI18n()
  const a = issue.analysis
  const state = issue.analysis_state
  let body: ReactNode
  if (state === "queued" || state === "running") {
    body = <p className="text-muted-foreground">{state === "running" ? t("El modelo está leyendo los logs y el código del handler. Suele tardar entre 10 y 40 segundos.") : t("En cola. Se analizan primero las más graves.")}</p>
  } else if (a) {
    const { intro, steps } = fixSteps(a)
    const c = Math.round((a.confidence || 0) * 100)
    body = (
      <div className="flex flex-col gap-5">
        <p className="max-w-[70ch] text-[15.5px] leading-relaxed"><Rich text={a.summary} /></p>
        <section>
          <h4 className="mb-1.5 text-sm font-semibold">{t("Causa")}</h4>
          <p className="max-w-[72ch] border-l-[3px] border-foreground/70 pl-3.5 text-[14.5px] leading-relaxed"><Rich text={a.root_cause} /></p>
        </section>
        <section>
          <h4 className="mb-1.5 text-sm font-semibold">{t("Cómo arreglarlo")}</h4>
          {intro && <p className="max-w-[72ch] text-[14.5px] leading-relaxed"><Rich text={intro} /></p>}
          {steps.length > 0 && (
            <ol className="mt-2 flex max-w-[72ch] list-decimal flex-col gap-1.5 pl-5 text-[14.5px] marker:text-muted-foreground">
              {steps.map((s, i) => <li key={i}><Rich text={s} /></li>)}
            </ol>
          )}
        </section>
        <dl className="grid gap-x-8 gap-y-2 border-t pt-4 text-sm sm:grid-cols-3">
          <div><dt className="text-muted-foreground">{t("Tipo")}</dt><dd className="font-medium">{t(KIND_LABEL[a.kind] ?? a.kind)}</dd></div>
          <div>
            <dt className="text-muted-foreground">{t("Confianza")}</dt>
            <dd className="flex items-center gap-2 font-medium tabular">
              <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <span className={cn("block h-full rounded-full", c >= 75 ? "bg-good" : c >= 45 ? "bg-warn" : "bg-bad")} style={{ width: `${c}%` }} />
              </span>
              {pct(a.confidence || 0, 0)}
            </dd>
          </div>
          <div><dt className="text-muted-foreground">{t("Modelo")}</dt><dd className="font-mono text-[13px]">{a.meta ? `${a.meta.model}, ${ms(a.meta.durationMs)}` : "—"}</dd></div>
        </dl>
        {(a.flags?.length > 0 || issue.analysis_error) && (
          <ul className="flex flex-col gap-1 rounded-md bg-warn-soft px-3.5 py-2.5 text-[13.5px] text-warn">
            {a.flags.map((f) => <li key={f}>{t(FLAG_LABEL[f] ?? f)}</li>)}
            {issue.analysis_error && <li>{ts(issue.analysis_error)}</li>}
          </ul>
        )}
      </div>
    )
  } else if (state === "failed") {
    body = <p className="text-bad">{t("El análisis falló: {error}. Comprueba Ollama en «Fuentes y ajustes» y vuelve a intentarlo.", { error: ts(issue.analysis_error) })}</p>
  } else {
    const why = issue.expected ? t("parece un comportamiento esperado") : issue.severity === "noise" ? t("es ruido") : t("su severidad está por debajo del umbral de análisis automático")
    body = <p className="text-muted-foreground">{t("No se analizó automáticamente porque {why}. Puedes pedir el diagnóstico igualmente.", { why })}</p>
  }
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle>{t("Diagnóstico")}</CardTitle>
          <CardDescription>{issue.analyzed_at
            ? t("Generado {when} con las evidencias y el código del backend.", { when: relativeTime(issue.analyzed_at) })
            : t("Con las evidencias de los logs y el código del backend.")}</CardDescription>
        </div>
        <Button variant={a ? "outline" : "default"} size="sm" onClick={onAnalyze} disabled={busy || state === "queued" || state === "running"}>
          <Stethoscope />{a ? t("Volver a analizar") : t("Analizar ahora")}
        </Button>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  )
}

function Evidence({ text, highlight }: { text: string; highlight?: string | null }) {
  const lines = text.split("\n")
  return (
    <pre className="max-h-96 overflow-auto rounded-lg border bg-code p-3.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
      {lines.map((l, i) => {
        if (highlight && highlight.length > 4 && l.includes(highlight)) {
          const [a, ...rest] = l.split(highlight)
          return <div key={i}>{a}<mark className="rounded bg-bad-soft px-0.5 text-bad">{highlight}</mark>{rest.join(highlight)}</div>
        }
        return <div key={i}>{l}</div>
      })}
    </pre>
  )
}

function Diff({ patch }: { patch: string }) {
  const { ts } = useI18n()
  const lines = patch.split("\n")
  const notes = lines.filter((l) => l.startsWith("# ")).map((l) => l.slice(2).replace(/^Imports añadidos:/, ts("Imports añadidos:")))
  const body = lines.filter((l) => !l.startsWith("# "))
  return (
    <div className="flex flex-col gap-3">
      {notes.length > 0 && <div className="max-w-[72ch] text-[14px] leading-relaxed text-muted-foreground">{notes.map((n, i) => <p key={i}><Rich text={n} /></p>)}</div>}
      <pre className="max-h-[28rem] overflow-auto rounded-lg border bg-code py-2 font-mono text-[12.5px] leading-relaxed">
        {body.map((l, i) => (
          <div key={i} className={cn("px-3.5 whitespace-pre",
            l.startsWith("+++") || l.startsWith("---") ? "font-semibold" :
            l.startsWith("@@") ? "text-info" :
            l.startsWith("+") ? "bg-good-soft text-good" :
            l.startsWith("-") ? "bg-bad-soft text-bad" : "")}>{l || " "}</div>
        ))}
      </pre>
    </div>
  )
}

export function IncidenciaPage() {
  const { id } = useParams()
  const { issuesVersion, onIssue } = useApp()
  const { t, tn, ts } = useI18n()
  const [tick, setTick] = useState(0)
  const { data, error, reload } = useApi<IssueDetail>(`/api/issues/${id}`, `${issuesVersion}-${tick}`)
  const [busy, setBusy] = useState(false)

  // Esta incidencia cambió (nueva ocurrencia, diagnóstico listo): recarga en cuanto llega.
  useEffect(() => onIssue((i) => { if (String(i.id) === id) setTick((x) => x + 1) }), [id, onIssue])

  if (error && !data) return <ErrorNote message={error} />
  if (!data) return <PageSkeleton />
  const { issue, events, histogram } = data
  const a = issue.analysis
  const ev = events[0]

  const setState = async (state: IssueState) => {
    setBusy(true)
    try {
      await apiPost(`/api/issues/${issue.id}/state`, { state })
      toast.success(t({ ack: "Incidencia reconocida", resolved: "Incidencia marcada como resuelta", ignored: "Incidencia ignorada", open: "Incidencia reabierta" }[state]))
      await reload()
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }
  const analyze = async () => {
    setBusy(true)
    try { await apiPost(`/api/issues/${issue.id}/analyze`); toast.success(t("Enviada al análisis")); await reload() } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }
  const patchBody = issue.patch ? issue.patch.split("\n").filter((l) => !l.startsWith("# ")).join("\n") : ""

  return (
    <div className="flex flex-col gap-4">
      <Link to="/incidencias" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />{t("Incidencias")}
      </Link>

      <Card className="gap-5 py-6">
        <CardContent className="flex flex-col gap-5 px-6">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={issue.severity} />
            <span className="text-sm text-muted-foreground">{t(CATEGORY_LABEL[issue.category] ?? issue.category)}</span>
            <span className="text-muted-foreground/50" aria-hidden="true">|</span>
            <StateBadge state={issue.state} />
            <span className="text-muted-foreground/50" aria-hidden="true">|</span>
            <AnalysisBadge state={issue.analysis_state} hasPatch={!!issue.patch} />
            {!!issue.regression && <Tag tone="bad">{t("Regresión")}</Tag>}
            {!!issue.spike && <Tag tone="warn">{t("Pico")}</Tag>}
            {issue.after_release && <Tag tone="info">{t("Apareció tras {v}", { v: issue.after_release })}</Tag>}
            {!!issue.expected && <Tag>{t("Esperado")}</Tag>}
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="max-w-[60ch] text-[1.6rem] leading-tight font-semibold tracking-tight"><Rich text={ts(displayTitle({ ...issue, ai_title: a?.title }))} /></h2>
            {a?.title && <p className="max-w-[90ch] text-[13.5px] text-muted-foreground">{t("Detectada como:")} <span className="font-mono">{ts(issue.title)}</span></p>}
            {issue.route && (
              <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <MethodBadge method={issue.method} /><span className="font-mono">{issue.route}</span>
                {issue.status_code && <span className="font-mono">→ {issue.status_code}</span>}
                {issue.handler && <span>· handler <span className="font-mono">{issue.handler}</span>{issue.handler_dir && <> {t("en")} <span className="font-mono">{issue.handler_dir}</span></>}</span>}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {issue.state === "open" && <Button variant="outline" disabled={busy} onClick={() => setState("ack")}><Eye />{t("Reconocer")}</Button>}
            {issue.state !== "resolved" && <Button disabled={busy} onClick={() => setState("resolved")}><Check />{t("Marcar resuelta")}</Button>}
            {issue.state !== "ignored" && <Button variant="outline" disabled={busy} onClick={() => setState("ignored")}><EyeOff />{t("Ignorar")}</Button>}
            {(issue.state === "resolved" || issue.state === "ignored") && <Button variant="outline" disabled={busy} onClick={() => setState("open")}><RotateCcw />{t("Reabrir")}</Button>}
          </div>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-4 border-t pt-5 sm:grid-cols-3 lg:grid-cols-5">
            {[
              [t("Ocurrencias"), number(issue.count)],
              [t("Usuarios afectados"), issue.user_ids.length ? number(issue.user_ids.length) : "—"],
              [t("Primera vez"), dateTime(issue.first_seen)],
              [t("Última vez"), relativeTime(issue.last_seen)],
              [t("Avisada por n8n"), issue.alerted_at ? relativeTime(issue.alerted_at) : t("No")],
            ].map(([k, v]) => (
              <div key={k} className="flex flex-col-reverse gap-0.5"><dt className="text-[13px] text-muted-foreground">{k}</dt><dd className="text-lg font-semibold tabular">{v}</dd></div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <DiagnosisCard issue={issue} onAnalyze={analyze} busy={busy} />

          {ev && (
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <div className="flex flex-col gap-1">
                  <CardTitle>{t("Líneas de log de la última ocurrencia")}</CardTitle>
                  <CardDescription>{dateTime(ev.ts, true)}{ev.dyno ? ` ${t("en")} ${ev.dyno}` : ""}{ev.request_id ? `, request ${ev.request_id}` : ""}</CardDescription>
                </div>
                <CopyButton text={ev.evidence || ev.message || ""} />
              </CardHeader>
              <CardContent><Evidence text={ev.evidence || ev.message || ""} highlight={a?.grounded ? a.exact_error : null} /></CardContent>
            </Card>
          )}

          {issue.patch && (
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <div className="flex flex-col gap-1">
                  <CardTitle>{t("Parche propuesto")}</CardTitle>
                  <CardDescription>{t("Verificado con gofmt y git apply. Revísalo y compílalo antes de aplicarlo.")}</CardDescription>
                </div>
                <CopyButton text={patchBody} label={t("Copiar diff")} />
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {issue.patch_branch && (
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
                    {t("También está en la rama")} <code className="rounded border bg-code px-1.5 py-px font-mono text-[13px]">{issue.patch_branch}</code>{t(", creada sin tocar tu working tree.")}
                  </p>
                )}
                <Diff patch={issue.patch} />
              </CardContent>
            </Card>
          )}

          {events.length > 1 && (
            <Card>
              <CardHeader>
                <CardTitle>{t("Ocurrencias recientes")}</CardTitle>
                <CardDescription>{t("Las {a} últimas guardadas de {b} en total.", { a: events.length, b: tn(issue.count, "{n} ocurrencia", "{n} ocurrencias") })}</CardDescription>
              </CardHeader>
              <CardContent className="px-2 sm:px-4">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      {[t("Hora"), "Dyno", t("Petición"), t("Estado"), t("Duración"), t("Usuario")].map((h, i) => (
                        <TableHead key={h} className={cn("text-xs font-medium text-muted-foreground", i >= 3 && i <= 4 && "text-right")}>{h}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="tabular">{dateTime(e.ts, true)}</TableCell>
                        <TableCell className="font-mono text-xs">{e.dyno ?? "—"}</TableCell>
                        <TableCell className="max-w-[22rem] truncate font-mono text-xs" title={e.path ?? e.message ?? ""}>{e.path ? `${e.method ?? ""} ${e.path}` : (e.message ?? "").slice(0, 90)}</TableCell>
                        <TableCell className="text-right tabular">{e.status_code ?? "—"}</TableCell>
                        <TableCell className="text-right tabular">{ms(e.service_ms)}</TableCell>
                        <TableCell className="font-mono text-xs">{e.user_id ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("Actividad en las últimas 24 horas")}</CardTitle>
              <CardDescription>{t("Ocurrencias por media hora.")}</CardDescription>
            </CardHeader>
            <CardContent><ActivityChart histogram={histogram} className="aspect-auto h-[150px] w-full" /></CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t("Código")}</CardTitle></CardHeader>
            <CardContent>
              <dl className="divide-y">
                {a?.location ? (
                  <Row label={t("Ubicación")}>
                    <span className="font-mono text-[13px]">{a.location.file}{a.location.line ? `:${a.location.line}` : ""}</span>
                    {a.location.inferred && <span className="block text-xs text-muted-foreground">{t("Deducida de la ruta")}</span>}
                  </Row>
                ) : issue.code_file ? <Row label={t("Ubicación")}><span className="font-mono text-[13px]">{issue.code_file}:{issue.code_line}</span></Row> : null}
                {(a?.location?.function || issue.func) && <Row label={t("Función")}><span className="font-mono text-[13px]">{a?.location?.function || issue.func}</span></Row>}
                {issue.handler && <Row label={t("Handler de la ruta")}><span className="font-mono text-[13px]">{issue.handler}</span></Row>}
                {issue.blame ? (
                  <Row label={t("Último cambio")}>
                    {issue.blame.author}, {issue.blame.date}
                    <span className="block font-mono text-xs text-muted-foreground">{issue.blame.sha} «{issue.blame.summary}»</span>
                  </Row>
                ) : <Row label={t("Último cambio")}><span className="text-muted-foreground">{t("Sin datos de git blame")}</span></Row>}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("Usuarios afectados")}</CardTitle>
              <CardDescription>{issue.user_ids.length ? t("IDs que aparecen como user_id en los logs.") : t("Los logs de esta incidencia no incluyen user_id.")}</CardDescription>
            </CardHeader>
            {issue.user_ids.length > 0 && (
              <CardContent className="flex flex-wrap gap-1.5">
                {issue.user_ids.map((u) => <span key={u} className="rounded border bg-muted/60 px-1.5 py-0.5 font-mono text-xs">{u}</span>)}
              </CardContent>
            )}
          </Card>

          <Card>
            <CardHeader><CardTitle>{t("Clasificación")}</CardTitle></CardHeader>
            <CardContent>
              <dl className="divide-y">
                <Row label={t("Motivo")}>{ts(issue.reason) || "—"}</Row>
                <Row label={t("Huella")}><span className="font-mono text-[13px]">{issue.fingerprint}</span></Row>
                {issue.state_changed_at && <Row label={t("Estado cambiado")}>{dateTime(issue.state_changed_at)}</Row>}
                {ev && <Row label={t("Última línea")}>{clock(ev.ts)}</Row>}
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
