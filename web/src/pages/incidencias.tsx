// Incidencias: todas las huellas agrupadas, con filtros por estado, categoría,
// severidad y texto. Cada fila abre el detalle.

import type { ColumnDef } from "@tanstack/react-table"
import { Search } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router"
import { useApp } from "@/app/app-context"
import { AnalysisBadge, MethodBadge, SeverityBadge, StateBadge, Tag } from "@/components/dashboard/badges"
import { DataTable } from "@/components/dashboard/data-table"
import { ErrorNote, PageSkeleton } from "@/components/dashboard/indicators"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useApi } from "@/lib/api"
import { dateTime, number, relativeTime } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { CATEGORY_LABEL, displayTitle, periodLong, SEVERITY_LABEL, SEVERITY_ORDER, sevRank } from "@/lib/labels"
import type { IssueState, IssueSummary, Severity } from "@/lib/types"

type StateFilter = "active" | IssueState | "all"
const STATE_TABS: { key: StateFilter; label: string }[] = [
  { key: "active", label: "Activas" },
  { key: "open", label: "Abiertas" },
  { key: "ack", label: "Reconocidas" },
  { key: "resolved", label: "Resueltas" },
  { key: "ignored", label: "Ignoradas" },
  { key: "all", label: "Todas" },
]

export function IncidenciasPage() {
  const { period, issuesVersion } = useApp()
  const { t, tn, ts } = useI18n()
  const navigate = useNavigate()
  const [state, setState] = useState<StateFilter>("active")
  const [category, setCategory] = useState("all")
  const [severity, setSeverity] = useState<"all" | Severity>("all")
  const [q, setQ] = useState("")
  const [noise, setNoise] = useState(false)

  const { data, error } = useApi<{ issues: IssueSummary[]; counts: Record<string, number> }>(
    `/api/issues?state=${state}&range=${period}${noise ? "&noise=1" : ""}`, issuesVersion)

  const columns = useMemo<ColumnDef<IssueSummary>[]>(() => [
    {
      id: "severity", header: t("Severidad"), accessorFn: (r) => sevRank(r.severity),
      cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
      meta: { className: "w-28" },
    },
    {
      id: "title", header: t("Incidencia"), accessorFn: (r) => displayTitle(r), enableSorting: false,
      cell: ({ row }) => {
        const i = row.original
        return (
          <div className="flex max-w-[44rem] min-w-[18rem] flex-col gap-1 whitespace-normal">
            <span className="line-clamp-2 font-medium">{ts(displayTitle(i))}</span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {i.route ? <><MethodBadge method={i.method} /><span className="font-mono">{i.route}</span>{i.status_code ? <span className="font-mono">→ {i.status_code}</span> : null}</>
                : i.func ? <span className="font-mono">{i.func}()</span> : null}
              {i.regression && <Tag tone="bad">{t("Regresión")}</Tag>}
              {i.spike && <Tag tone="warn">{t("Pico")}</Tag>}
              {i.after_release && <Tag tone="info">{t("Tras {v}", { v: i.after_release })}</Tag>}
              {i.expected && <Tag>{t("Esperado")}</Tag>}
            </span>
          </div>
        )
      },
    },
    { accessorKey: "category", header: t("Categoría"), cell: ({ getValue }) => t(CATEGORY_LABEL[getValue<string>()] ?? getValue<string>()) },
    { accessorKey: "count", header: t("Ocurrencias"), meta: { numeric: true }, cell: ({ getValue }) => <span className="font-semibold">{number(getValue<number>())}</span> },
    { accessorKey: "users", header: t("Usuarios"), meta: { numeric: true }, cell: ({ getValue }) => (getValue<number>() ? number(getValue<number>()) : "—") },
    {
      id: "last_seen", header: t("Última vez"), sortingFn: "datetime", accessorFn: (r) => new Date(r.last_seen),
      cell: ({ row }) => (
        <Tooltip><TooltipTrigger asChild><span>{relativeTime(row.original.last_seen)}</span></TooltipTrigger><TooltipContent>{dateTime(row.original.last_seen, true)}</TooltipContent></Tooltip>
      ),
    },
    { id: "first_seen", header: t("Primera vez"), accessorFn: (r) => new Date(r.first_seen), sortingFn: "datetime", cell: ({ row }) => <span className="text-muted-foreground">{dateTime(row.original.first_seen)}</span> },
    { accessorKey: "state", header: t("Estado"), cell: ({ getValue }) => <StateBadge state={getValue<IssueState>()} /> },
    { id: "ai", header: t("Diagnóstico"), accessorFn: (r) => r.analysis_state, cell: ({ row }) => <AnalysisBadge state={row.original.analysis_state} hasPatch={row.original.has_patch} /> },
  ], [t, ts])

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    return (data?.issues ?? []).filter((i) =>
      (category === "all" || i.category === category) &&
      (severity === "all" || i.severity === severity) &&
      (!term || [i.title, ts(i.title), i.ai_title, i.route, i.func, i.handler, i.reason].some((v) => v && v.toLowerCase().includes(term))))
  }, [data, category, severity, q, ts])
  const presentCats = useMemo(() => [...new Set((data?.issues ?? []).map((i) => i.category))].sort(), [data])

  if (error && !data) return <ErrorNote message={error} />
  if (!data) return <PageSkeleton />

  const counts = data.counts ?? {}
  const countFor = (k: StateFilter) => k === "all" ? Object.values(counts).reduce((a, b) => a + b, 0)
    : k === "active" ? (counts.open ?? 0) + (counts.ack ?? 0) : counts[k] ?? 0
  const occurrences = rows.reduce((a, i) => a + i.count, 0)

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4">
        <div className="flex w-full flex-wrap items-baseline justify-between gap-2">
          <CardTitle>{t("Incidencias vistas en {period}", { period: t(periodLong(period)) })}</CardTitle>
          <CardDescription>
            {rows.length
              ? t("{a} con {b}.", { a: tn(rows.length, "{n} incidencia", "{n} incidencias"), b: tn(occurrences, "{n} ocurrencia", "{n} ocurrencias") })
              : t("Ninguna incidencia con estos filtros.")}
            {!noise && ` ${t("Sin ruido (bots y 401 habituales).")}`}
          </CardDescription>
        </div>
        <Tabs value={state} onValueChange={(v) => setState(v as StateFilter)}>
          <TabsList className="flex-wrap">
            {STATE_TABS.map((s) => (
              <TabsTrigger key={s.key} value={s.key} className="gap-1.5">
                {t(s.label)}<span className="text-xs text-muted-foreground tabular">{countFor(s.key)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-72 flex-1 sm:max-w-md">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Buscar por ruta, función o error")} className="pl-8" aria-label={t("Buscar")} />
          </div>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-48" aria-label={t("Categoría")}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("Todas las categorías")}</SelectItem>
              {presentCats.map((c) => <SelectItem key={c} value={c}>{t(CATEGORY_LABEL[c] ?? c)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={severity} onValueChange={(v) => setSeverity(v as "all" | Severity)}>
            <SelectTrigger className="w-48" aria-label={t("Severidad")}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("Todas las severidades")}</SelectItem>
              {SEVERITY_ORDER.filter((s) => noise || s !== "noise").map((s) => <SelectItem key={s} value={s}>{t(SEVERITY_LABEL[s])}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2 pl-1">
            <Checkbox id="noise" checked={noise} onCheckedChange={(v) => setNoise(v === true)} />
            <Label htmlFor="noise" className="font-normal">{t("Incluir ruido")}</Label>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-2 sm:px-4">
        <DataTable columns={columns} data={rows} getRowId={(r) => String(r.id)}
          initialSort={[{ id: "severity", desc: true }, { id: "last_seen", desc: true }]}
          onRowClick={(r) => navigate(`/incidencias/${r.id}`)}
          rowClassName={(r) => (r.state === "resolved" || r.state === "ignored" ? "text-muted-foreground" : undefined)}
          empty={state === "active" ? t("No hay incidencias activas en este periodo. Prueba con un periodo más largo o incluye el ruido.") : t("No hay incidencias con estos filtros.")} />
      </CardContent>
    </Card>
  )
}
