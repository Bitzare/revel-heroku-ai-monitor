// Etiquetas de estado. Siempre icono + texto: el color nunca va solo.

import {
  CircleAlert, CircleCheck, CircleDashed, CircleDot, CircleHelp, Eye, EyeOff, Loader2, Minus, OctagonAlert, Stethoscope, TriangleAlert, Info,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useI18n } from "@/lib/i18n"
import { SEVERITY_LABEL, STATE_LABEL } from "@/lib/labels"
import type { AnalysisState, Health, IssueState, Severity } from "@/lib/types"
import { cn } from "@/lib/utils"

const SEV_STYLE: Record<Severity, { cls: string; Icon: typeof Info }> = {
  critical: { cls: "bg-bad-soft text-bad", Icon: OctagonAlert },
  high: { cls: "bg-high-soft text-high", Icon: TriangleAlert },
  medium: { cls: "bg-warn-soft text-warn", Icon: CircleAlert },
  low: { cls: "bg-info-soft text-info", Icon: Info },
  noise: { cls: "bg-muted text-muted-foreground", Icon: Minus },
}

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  const { t } = useI18n()
  const { cls, Icon } = SEV_STYLE[severity]
  return (
    <Badge variant="secondary" className={cn("gap-1 border-0 font-semibold", cls, className)}>
      <Icon className="size-3.5" aria-hidden="true" />{t(SEVERITY_LABEL[severity])}
    </Badge>
  )
}

/** Barra de color a la izquierda de una fila o elemento de lista. */
export const severityBorder = (s: Severity) =>
  ({ critical: "border-bad", high: "border-high", medium: "border-warn", low: "border-info", noise: "border-border" })[s]

const STATE_ICON: Record<IssueState, typeof Info> = { open: CircleDot, ack: Eye, resolved: CircleCheck, ignored: EyeOff }

export function StateBadge({ state }: { state: IssueState }) {
  const { t } = useI18n()
  const Icon = STATE_ICON[state]
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[13px]", state === "resolved" ? "text-good" : state === "open" ? "text-foreground" : "text-muted-foreground")}>
      <Icon className="size-3.5" aria-hidden="true" />{t(STATE_LABEL[state])}
    </span>
  )
}

export function AnalysisBadge({ state, hasPatch }: { state: AnalysisState; hasPatch?: boolean }) {
  const { t } = useI18n()
  if (state === "queued" || state === "running") {
    return <span className="inline-flex items-center gap-1.5 text-[13px] text-warn"><Loader2 className="size-3.5 animate-spin" aria-hidden="true" />{state === "running" ? t("Analizando") : t("En cola")}</span>
  }
  if (state === "done") {
    return <span className="inline-flex items-center gap-1.5 text-[13px] text-good"><Stethoscope className="size-3.5" aria-hidden="true" />{hasPatch ? t("Con parche") : t("Diagnosticada")}</span>
  }
  if (state === "failed") return <span className="inline-flex items-center gap-1.5 text-[13px] text-bad"><CircleAlert className="size-3.5" aria-hidden="true" />{t("Falló")}</span>
  return <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground"><CircleDashed className="size-3.5" aria-hidden="true" />{t("Sin analizar")}</span>
}

export function MethodBadge({ method }: { method: string | null }) {
  if (!method) return null
  return <span className="inline-flex min-w-12 justify-center rounded border bg-muted/60 px-1.5 py-px font-mono text-[11px] font-semibold text-muted-foreground">{method}</span>
}

const SERVICE: Record<Health["status"], { text: string; long: string; cls: string; Icon: typeof Info }> = {
  ok: { text: "Estable", long: "Servicio estable", cls: "text-good", Icon: CircleCheck },
  warning: { text: "Degradado", long: "Servicio degradado", cls: "text-warn", Icon: TriangleAlert },
  critical: { text: "Crítico", long: "Incidencia crítica en curso", cls: "text-bad", Icon: OctagonAlert },
  unknown: { text: "Sin datos", long: "Sin datos recientes", cls: "text-muted-foreground", Icon: CircleHelp },
}

export function ServiceStatus({ status, compact }: { status: Health["status"]; compact?: boolean }) {
  const { t } = useI18n()
  const s = SERVICE[status]
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-semibold", s.cls)}>
      <s.Icon className="size-4" aria-hidden="true" />{t(compact ? s.text : s.long)}
    </span>
  )
}

export function Tag({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "bad" | "warn" | "info" | "good" }) {
  const cls = { neutral: "bg-muted text-muted-foreground", bad: "bg-bad-soft text-bad", warn: "bg-warn-soft text-warn", info: "bg-info-soft text-info", good: "bg-good-soft text-good" }[tone]
  return <span className={cn("inline-flex items-center rounded px-1.5 py-px text-[11.5px] font-semibold", cls)}>{children}</span>
}
