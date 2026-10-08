// Fuentes y ajustes: de dónde llegan los logs y en qué estado, la IA, las
// alertas y la configuración efectiva (sin secretos).

import { CircleAlert, CircleCheck, CircleHelp, Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import { useApp } from "@/app/app-context"
import { ErrorNote, PageSkeleton } from "@/components/dashboard/indicators"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useApi } from "@/lib/api"
import { dateTime, ms, number, relativeTime } from "@/lib/format"
import { SEVERITY_LABEL, SOURCE_STATE_LABEL } from "@/lib/labels"
import type { PublicConfig, SourceStatus } from "@/lib/types"
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

const yes = (b: boolean, on = "Configurado", off = "No configurado") => <span className={b ? "" : "text-muted-foreground"}>{b ? on : off}</span>
const mono = (v: ReactNode) => <span className="font-mono text-[13px]">{v}</span>

function Snippet({ children }: { children: string }) {
  return <pre className="overflow-auto rounded-lg border bg-code px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed">{children}</pre>
}

export function SistemaPage() {
  const { health } = useApp()
  const cfg = useApi<PublicConfig>("/api/config")

  if (cfg.error && !cfg.data) return <ErrorNote message={cfg.error} />
  if (!cfg.data || !health) return <PageSkeleton />
  const c = cfg.data
  const ai = health.ai
  const n = health.notifier
  const origin = window.location.origin

  return (
    <div className="flex flex-col gap-4">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Fuentes de logs">
        {health.sources.length ? health.sources.map((s) => (
          <Card key={s.name} className="gap-3">
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div className="flex flex-col gap-1">
                <CardTitle>{s.label}</CardTitle>
                <CardDescription className="font-mono text-xs">{s.name}</CardDescription>
              </div>
              <Status tone={srcTone(s)}>{SOURCE_STATE_LABEL[s.state] ?? s.state}</Status>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <KV rows={[
                ["Líneas recibidas", number(s.lines)],
                ["Última línea", s.lastLine ? relativeTime(s.lastLine) : "—"],
                ["En este estado desde", dateTime(s.since)],
                ["Reconexiones", number(s.reconnects)],
              ]} />
              {s.error && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{s.error}</p>}
            </CardContent>
          </Card>
        )) : (
          <Card><CardHeader><CardTitle>Sin fuentes activas</CardTitle><CardDescription>Configura LOG_SOURCES o envía logs por /api/ingest.</CardDescription></CardHeader></Card>
        )}
      </section>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <CardTitle>Diagnóstico con IA</CardTitle>
              <CardDescription>Ollama en local; ningún log ni código sale de esta máquina.</CardDescription>
            </div>
            <Status tone={!ai.enabled ? "muted" : ai.ok ? "good" : ai.ok === false ? "bad" : "warn"}>
              {!ai.enabled ? "Desactivado" : ai.ok ? "Disponible" : ai.ok === false ? "No responde" : "Comprobando"}
            </Status>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <KV rows={[
              ["Modelo", mono(c.ai.model)],
              ["Servidor", mono(c.ai.url)],
              ["Contexto", `${number(c.ai.numCtx)} tokens`],
              ["Timeout por llamada", ms(c.ai.timeoutMs)],
              ["Análisis automático desde", SEVERITY_LABEL[c.ai.analyzeMinSeverity] ?? c.ai.analyzeMinSeverity],
              ["Cola", `${number(ai.queue.queued)} en espera${ai.queue.running ? `, #${ai.queue.running} en curso` : ""} (máximo ${number(c.ai.maxQueue)})`],
              ["Analizadas / fallidas", `${number(ai.queue.processed)} / ${number(ai.queue.failed)} desde ${dateTime(health.startedAt)}`],
              ["Parches", `${c.autofix.mode === "off" ? "Desactivados" : c.autofix.mode === "branch" ? "Diff y rama ai-fix/*" : "Solo diff"} · confianza mínima ${Math.round(c.autofix.minConfidence * 100)} % · gofmt ${c.autofix.gofmt ? "disponible" : "no encontrado"}`],
            ]} />
            {ai.error && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{ai.error}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <CardTitle>Alertas a Slack por n8n</CardTitle>
              <CardDescription>Workflow n8n/monitor-to-slack.json en la VM revel-test-db.</CardDescription>
            </div>
            <Status tone={!n.enabled ? "muted" : n.lastError ? "bad" : "good"}>{!n.enabled ? "Sin configurar" : n.lastError ? "Último envío fallido" : "Activas"}</Status>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <KV rows={[
              ["Webhook", yes(c.alerts.n8nConfigured)],
              ["Token compartido", yes(c.alerts.tokenConfigured)],
              ["Avisa desde", SEVERITY_LABEL[n.minSeverity] ?? n.minSeverity],
              ["Enviadas / fallidas", `${number(n.sent)} / ${number(n.failed)}`],
              ["Cuándo avisa", "Crítica, regresión o pico al momento; el resto al terminar el diagnóstico. Máximo una vez cada 30 min por incidencia."],
            ]} />
            {n.lastError && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{n.lastError}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Backend y procesado</CardTitle>
            <CardDescription>Código que se usa para resolver rutas y dar contexto al diagnóstico.</CardDescription>
          </CardHeader>
          <CardContent>
            <KV rows={[
              ["Ruta del backend", mono(c.backendPath)],
              ["Estado", c.backendFound ? `${number(c.routes)} rutas y ${number(c.functions)} funciones Go indexadas` : <span className="text-bad">No encontrado: revisa BACKEND_PATH</span>],
              ["Líneas procesadas", `${number(health.pipeline.lines)} (${number(health.pipeline.dupes)} duplicadas descartadas)`],
              ["Peticiones / ocurrencias", `${number(health.pipeline.requests)} / ${number(health.pipeline.incidents)}`],
              ["Base de datos", mono(c.dbFile)],
              ["Retención", `${c.thresholds.retentionDays} días`],
            ]} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Umbrales e ingesta</CardTitle>
            <CardDescription>Se cambian en el fichero .env (ver .env.example).</CardDescription>
          </CardHeader>
          <CardContent>
            <KV rows={[
              ["Petición lenta", `más de ${ms(c.thresholds.slowRequestMs)}`],
              ["Apdex T", ms(c.thresholds.apdexTargetMs)],
              ["Ventana de correlación", ms(c.thresholds.correlationWindowMs)],
              ["Fuentes configuradas", mono(c.sources.join(", "))],
              ["Token de la API de Heroku", yes(c.ingest.herokuApiTokenConfigured)],
              ["Token de ingesta", yes(c.ingest.tokenConfigured, "Configurado", "Sin token: solo se acepta ingesta desde esta máquina")],
              ["Escucha en", mono(`${c.host}:${c.port}`)],
            ]} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Conectar fuentes de logs</CardTitle>
          <CardDescription>Se pueden usar varias a la vez: las líneas repetidas se descartan.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-3">
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">API de Heroku (recomendada)</h4>
            <p className="text-[13.5px] text-muted-foreground">Streaming con reconexión, sin depender de la CLI. Token de solo lectura en .env.</p>
            <Snippet>{`heroku authorizations:create \\\n  -d "revel-guardia" --scope read\n\nHEROKU_API_TOKEN=...\nLOG_SOURCES=heroku-api`}</Snippet>
          </div>
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">n8n</h4>
            <p className="text-[13.5px] text-muted-foreground">Workflow n8n/heroku-logs-to-monitor.json: cada minuto lee los logs y los envía aquí.</p>
            <Snippet>{`POST ${origin}/api/ingest/n8n\nX-Monitor-Token: <INGEST_TOKEN>\n\n{"lines": ["..."]}`}</Snippet>
          </div>
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">Drain de Logplex</h4>
            <p className="text-[13.5px] text-muted-foreground">Necesita una URL pública (por ejemplo, un túnel) y el token de ingesta.</p>
            <Snippet>{`heroku drains:add \\\n  "https://TU-TUNEL/api/ingest?token=<INGEST_TOKEN>" \\\n  -a ${c.app}`}</Snippet>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
