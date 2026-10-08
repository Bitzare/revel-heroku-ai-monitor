// Fuentes y ajustes: de dónde llegan los logs y en qué estado, la IA, las
// alertas y la configuración efectiva (sin secretos).

import { CircleAlert, CircleCheck, CircleHelp, Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import { useApp } from "@/app/app-context"
import { ErrorNote, PageSkeleton } from "@/components/dashboard/indicators"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useApi } from "@/lib/api"
import { dateTime, ms, number, relativeTime } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { SEVERITY_LABEL, SOURCE_STATE_LABEL } from "@/lib/labels"
import type { PublicConfig, Severity, SourceStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

function Status({ tone, children }: { tone: "good" | "warn" | "bad" | "muted"; children: ReactNode }) {
  const Icon = tone === "good" ? CircleCheck : tone === "bad" ? CircleAlert : tone === "warn" ? Loader2 : CircleHelp
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-semibold",
      tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-muted-foreground")}>
      <Icon className={cn("size-4", tone === "warn" && "animate-spin")} aria-hidden="true" />{children}
    </span>
  )
}

const srcTone = (s: SourceStatus) => (s.state === "live" || s.state === "done" ? "good" : s.state === "error" ? "bad" : s.state === "idle" || s.state === "stopped" ? "muted" : "warn")

function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[minmax(9rem,40%)_1fr] gap-3 py-2">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words tabular">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

const mono = (v: ReactNode) => <span className="font-mono text-[13px]">{v}</span>

function Snippet({ children }: { children: string }) {
  return <pre className="overflow-auto rounded-lg border bg-code px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed">{children}</pre>
}

export function SistemaPage() {
  const { health } = useApp()
  const { t, ts, lang } = useI18n()
  const cfg = useApi<PublicConfig>("/api/config")

  if (cfg.error && !cfg.data) return <ErrorNote message={cfg.error} />
  if (!cfg.data || !health) return <PageSkeleton />
  const c = cfg.data
  const ai = health.ai
  const n = health.notifier
  const origin = window.location.origin
  const yes = (b: boolean, on = t("Configurado"), off = t("No configurado")) => <span className={b ? "" : "text-muted-foreground"}>{b ? on : off}</span>
  const sev = (s: Severity) => t(SEVERITY_LABEL[s] ?? s)
  const autofix = c.autofix.mode === "off" ? t("Desactivados") : c.autofix.mode === "branch" ? t("Diff y rama ai-fix/*") : t("Solo diff")

  return (
    <div className="flex flex-col gap-4">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label={t("Fuentes de logs")}>
        {health.sources.length ? health.sources.map((s) => (
          <Card key={s.name} className="gap-3">
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div className="flex flex-col gap-1">
                <CardTitle>{ts(s.label)}</CardTitle>
                <CardDescription className="font-mono text-xs">{s.name}</CardDescription>
              </div>
              <Status tone={srcTone(s)}>{t(SOURCE_STATE_LABEL[s.state] ?? s.state)}</Status>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <KV rows={[
                [t("Líneas recibidas"), number(s.lines)],
                [t("Última línea"), s.lastLine ? relativeTime(s.lastLine) : "—"],
                [t("En este estado desde"), dateTime(s.since)],
                [t("Reconexiones"), number(s.reconnects)],
              ]} />
              {s.error && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{ts(s.error)}</p>}
            </CardContent>
          </Card>
        )) : (
          <Card><CardHeader><CardTitle>{t("Sin fuentes activas")}</CardTitle><CardDescription>{t("Configura LOG_SOURCES o envía logs por /api/ingest.")}</CardDescription></CardHeader></Card>
        )}
      </section>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <CardTitle>{t("Diagnóstico con IA")}</CardTitle>
              <CardDescription>{t("Ollama en local; ningún log ni código sale de esta máquina.")}</CardDescription>
            </div>
            <Status tone={!ai.enabled ? "muted" : ai.ok ? "good" : ai.ok === false ? "bad" : "warn"}>
              {!ai.enabled ? t("Desactivado") : ai.ok ? t("Disponible") : ai.ok === false ? t("No responde") : t("Comprobando")}
            </Status>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <KV rows={[
              [t("Modelo"), mono(c.ai.model)],
              [t("Servidor"), mono(c.ai.url)],
              [t("Contexto"), t("{n} tokens", { n: number(c.ai.numCtx) })],
              [t("Timeout por llamada"), ms(c.ai.timeoutMs)],
              [t("Idioma de los diagnósticos"), c.ai.language === "en" ? "English" : "Español"],
              [t("Análisis automático desde"), sev(c.ai.analyzeMinSeverity)],
              [t("Cola"), t("{q} en espera{running} (máximo {max})", { q: number(ai.queue.queued), running: ai.queue.running ? t(", #{id} en curso", { id: ai.queue.running }) : "", max: number(c.ai.maxQueue) })],
              [t("Analizadas / fallidas"), t("{a} / {b} desde {since}", { a: number(ai.queue.processed), b: number(ai.queue.failed), since: dateTime(health.startedAt) })],
              [t("Parches"), t("{mode} · confianza mínima {c} % · gofmt {g}", { mode: autofix, c: Math.round(c.autofix.minConfidence * 100), g: c.autofix.gofmt ? t("disponible") : t("no encontrado") })],
            ]} />
            {ai.error && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{ts(ai.error)}</p>}
            {c.ai.language !== lang && (
              <p className="text-[13px] text-muted-foreground">{t("Los diagnósticos se generan en el idioma de AI_LANGUAGE (.env); los ya generados no cambian al cambiar el idioma de la interfaz.")}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <CardTitle>{t("Alertas a Slack por n8n")}</CardTitle>
              <CardDescription>{t("Workflow n8n/monitor-to-slack.json en la VM revel-test-db.")}</CardDescription>
            </div>
            <Status tone={!n.enabled ? "muted" : n.lastError ? "bad" : "good"}>{!n.enabled ? t("Sin configurar") : n.lastError ? t("Último envío fallido") : t("Activas")}</Status>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <KV rows={[
              ["Webhook", yes(c.alerts.n8nConfigured)],
              [t("Token compartido"), yes(c.alerts.tokenConfigured)],
              [t("Avisa desde"), sev(n.minSeverity)],
              [t("Enviadas / fallidas"), `${number(n.sent)} / ${number(n.failed)}`],
              [t("Cuándo avisa"), t("Crítica, regresión o pico al momento; el resto al terminar el diagnóstico. Máximo una vez cada 30 min por incidencia.")],
            ]} />
            {n.lastError && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{n.lastError}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("Backend y procesado")}</CardTitle>
            <CardDescription>{t("Código que se usa para resolver rutas y dar contexto al diagnóstico.")}</CardDescription>
          </CardHeader>
          <CardContent>
            <KV rows={[
              [t("Ruta del backend"), mono(c.backendPath)],
              [t("Estado"), c.backendFound
                ? t("{r} rutas y {f} funciones Go indexadas", { r: number(c.routes), f: number(c.functions) })
                : <span className="text-bad">{t("No encontrado: revisa BACKEND_PATH")}</span>],
              [t("Líneas procesadas"), t("{n} ({d} duplicadas descartadas)", { n: number(health.pipeline.lines), d: number(health.pipeline.dupes) })],
              [t("Peticiones / ocurrencias"), `${number(health.pipeline.requests)} / ${number(health.pipeline.incidents)}`],
              [t("Base de datos"), mono(c.dbFile)],
              [t("Retención"), t("{n} días", { n: c.thresholds.retentionDays })],
            ]} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("Umbrales e ingesta")}</CardTitle>
            <CardDescription>{t("Se cambian en el fichero .env (ver .env.example).")}</CardDescription>
          </CardHeader>
          <CardContent>
            <KV rows={[
              [t("Petición lenta"), t("más de {v}", { v: ms(c.thresholds.slowRequestMs) })],
              ["Apdex T", ms(c.thresholds.apdexTargetMs)],
              [t("Ventana de correlación"), ms(c.thresholds.correlationWindowMs)],
              [t("Fuentes configuradas"), mono(c.sources.join(", "))],
              [t("Token de la API de Heroku"), yes(c.ingest.herokuApiTokenConfigured)],
              [t("Token de ingesta"), yes(c.ingest.tokenConfigured, t("Configurado"), t("Sin token: solo se acepta ingesta desde esta máquina"))],
              [t("Escucha en"), mono(`${c.host}:${c.port}`)],
            ]} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("Conectar fuentes de logs")}</CardTitle>
          <CardDescription>{t("Se pueden usar varias a la vez: las líneas repetidas se descartan.")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-3">
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">{t("API de Heroku (recomendada)")}</h4>
            <p className="text-[13.5px] text-muted-foreground">{t("Streaming con reconexión, sin depender de la CLI. Token de solo lectura en .env.")}</p>
            <Snippet>{`heroku authorizations:create \\\n  -d "revel-guardia" --scope read\n\nHEROKU_API_TOKEN=...\nLOG_SOURCES=heroku-api`}</Snippet>
          </div>
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">n8n</h4>
            <p className="text-[13.5px] text-muted-foreground">{t("Workflow n8n/heroku-logs-to-monitor.json: cada minuto lee los logs y los envía aquí.")}</p>
            <Snippet>{`POST ${origin}/api/ingest/n8n\nX-Monitor-Token: <INGEST_TOKEN>\n\n{"lines": ["..."]}`}</Snippet>
          </div>
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">{t("Drain de Logplex")}</h4>
            <p className="text-[13.5px] text-muted-foreground">{t("Necesita una URL pública (por ejemplo, un túnel) y el token de ingesta.")}</p>
            <Snippet>{`heroku drains:add \\\n  "https://TU-TUNEL/api/ingest?token=<INGEST_TOKEN>" \\\n  -a ${c.app}`}</Snippet>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
