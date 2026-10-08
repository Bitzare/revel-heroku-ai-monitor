// Gráficos sobre los componentes de shadcn (Recharts). Colores de tráfico:
// chart-1 correctas, chart-2 4xx, chart-3 5xx (validados para daltonismo en
// claro y oscuro). Todas las series llevan leyenda en la tarjeta y tooltip.

import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { bucketLabel, dateTime, ms, number } from "@/lib/format"
import type { Stats } from "@/lib/types"

const axis = { tickLine: false, axisLine: false, tickMargin: 8 } as const

function niceTicks(max: number, count = 4, integer = true) {
  if (max <= 0) return [0, 1]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw)!
  if (integer) step = Math.max(1, Math.ceil(step))
  const ticks: number[] = []
  for (let v = 0; v < max + step; v += step) ticks.push(Math.round(v * 1000) / 1000)
  return ticks
}

/** Rellena los tramos vacíos para que el eje temporal sea continuo. */
function continuous(stats: Stats) {
  const step = stats.bucketMinutes * 60000
  const byT = new Map(stats.timeline.map((p) => [Date.parse(p.t), p]))
  const first = stats.timeline.length ? Date.parse(stats.timeline[0].t) : Date.now()
  const start = Math.max(Math.floor(Date.parse(stats.since) / step) * step, stats.since === "0000" ? first : 0) || first
  const end = Math.floor(Math.max(Date.now(), stats.latestTs ? Date.parse(stats.latestTs) : 0) / step) * step
  const out = []
  for (let t = start; t <= end && out.length < 400; t += step) {
    const p = byT.get(t)
    const req = p?.requests ?? 0, e4 = p?.err4 ?? 0, e5 = p?.err5 ?? 0
    out.push({ t, ok: Math.max(0, req - e4 - e5), err4: e4, err5: e5, requests: req, p95: p?.p95 ?? null, avgMs: p?.avgMs ?? null })
  }
  return out
}

function releaseMarks(stats: Stats) {
  const step = stats.bucketMinutes * 60000
  return stats.releases.map((r) => ({ t: Math.floor(Date.parse(r.ts) / step) * step, version: r.version }))
}

// ── Tráfico por tramo (apilado) ─────────────────────────────────────
const trafficConfig = {
  ok: { label: "Correctas (2xx/3xx)", color: "var(--chart-1)" },
  err4: { label: "Errores de cliente (4xx)", color: "var(--chart-2)" },
  err5: { label: "Errores de servidor (5xx y Heroku)", color: "var(--chart-3)" },
} satisfies ChartConfig

export function TrafficChart({ stats, className }: { stats: Stats; className?: string }) {
  const data = continuous(stats)
  const ticks = niceTicks(Math.max(1, ...data.map((d) => d.requests)))
  return (
    <ChartContainer config={trafficConfig} className={className}>
      <BarChart data={data} margin={{ top: 18, right: 8, left: 0, bottom: 0 }} barCategoryGap="12%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" type="category" tickFormatter={(t) => bucketLabel(new Date(t).toISOString(), stats.bucketMinutes)} minTickGap={36} {...axis} />
        <YAxis width={44} ticks={ticks} domain={[0, ticks[ticks.length - 1]]} tickFormatter={(v) => number(v)} {...axis} />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", opacity: 0.6 }}
          content={<ChartTooltipContent valueFormatter={(v) => number(v)} className="min-w-56"
            labelFormatter={(_, payload) => {
              const p = payload?.[0]?.payload
              return p ? `${dateTime(new Date(p.t).toISOString())} · ${number(p.requests)} peticiones` : ""
            }} />}
        />
        {/* 1px del color de la tarjeta separa los segmentos apilados */}
        <Bar dataKey="ok" stackId="r" fill="var(--color-ok)" stroke="var(--card)" strokeWidth={1} maxBarSize={18} isAnimationActive={false} />
        <Bar dataKey="err4" stackId="r" fill="var(--color-err4)" stroke="var(--card)" strokeWidth={1} maxBarSize={18} isAnimationActive={false} />
        <Bar dataKey="err5" stackId="r" fill="var(--color-err5)" stroke="var(--card)" strokeWidth={1} radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
        {releaseMarks(stats).map((r) => (
          <ReferenceLine key={r.version} x={r.t} stroke="var(--foreground)" strokeOpacity={0.6} strokeDasharray="4 4"
            label={{ value: r.version, position: "top", fontSize: 11, fill: "var(--muted-foreground)" }} />
        ))}
      </BarChart>
    </ChartContainer>
  )
}

// Punto solo donde el valor no tiene vecinos (la línea no se vería).
function isolatedDot(data: { p95: number | null; avgMs: number | null }[], key: "p95" | "avgMs", color: string) {
  return (props: { cx?: number; cy?: number; index?: number }) => {
    const i = props.index ?? 0
    const has = (j: number) => data[j] != null && data[j][key] != null
    if (!has(i) || has(i - 1) || has(i + 1) || props.cx == null || props.cy == null) return <g key={`d${i}`} />
    return <circle key={`d${i}`} cx={props.cx} cy={props.cy} r={3} fill={color} stroke="var(--card)" strokeWidth={1.5} />
  }
}

// ── Latencia (p95 y media) ──────────────────────────────────────────
const latencyConfig = {
  p95: { label: "p95", color: "var(--chart-5)" },
  avgMs: { label: "Media", color: "var(--chart-4)" },
} satisfies ChartConfig

export function LatencyChart({ stats, threshold, className }: { stats: Stats; threshold: number; className?: string }) {
  const data = continuous(stats)
  const max = Math.max(threshold * 1.1, ...data.map((d) => d.p95 ?? 0))
  const ticks = niceTicks(max)
  return (
    <ChartContainer config={latencyConfig} className={className}>
      <LineChart data={data} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" type="category" tickFormatter={(t) => bucketLabel(new Date(t).toISOString(), stats.bucketMinutes)} minTickGap={36} {...axis} />
        <YAxis width={56} ticks={ticks} domain={[0, ticks[ticks.length - 1]]} tickFormatter={(v) => ms(v)} {...axis} />
        <ChartTooltip cursor={{ strokeDasharray: "3 3" }}
          content={<ChartTooltipContent indicator="line" valueFormatter={(v) => ms(v)}
            labelFormatter={(_, payload) => payload?.[0] ? dateTime(new Date(payload[0].payload.t).toISOString()) : ""} />} />
        <ReferenceLine y={threshold} stroke="var(--bad)" strokeOpacity={0.7} strokeDasharray="4 4" />
        {/* Sin unir tramos vacíos (una diagonal sobre horas sin tráfico engaña); los puntos aislados se marcan. */}
        <Line dataKey="avgMs" stroke="var(--color-avgMs)" strokeWidth={2} dot={isolatedDot(data, "avgMs", "var(--color-avgMs)")} isAnimationActive={false} />
        <Line dataKey="p95" stroke="var(--color-p95)" strokeWidth={2} dot={isolatedDot(data, "p95", "var(--color-p95)")} isAnimationActive={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }} />
      </LineChart>
    </ChartContainer>
  )
}

// ── Ocurrencias por categoría (barras horizontales, una serie) ─────
const catConfig = { n: { label: "Ocurrencias", color: "var(--chart-5)" } } satisfies ChartConfig

export function CategoryChart({ data, className }: { data: { label: string; n: number }[]; className?: string }) {
  return (
    <ChartContainer config={catConfig} className={className} style={{ height: Math.max(80, data.length * 34) }}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }} barCategoryGap="28%">
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="label" width={128} {...axis} />
        <ChartTooltip cursor={{ fill: "var(--muted)", opacity: 0.6 }} content={<ChartTooltipContent hideIndicator valueFormatter={(v) => number(v)} />} />
        <Bar dataKey="n" fill="var(--color-n)" radius={[0, 4, 4, 0]} maxBarSize={18} isAnimationActive={false}
          label={{ position: "right", fontSize: 12, fontWeight: 600, fill: "var(--foreground)", formatter: (v: unknown) => number(Number(v)) }} />
      </BarChart>
    </ChartContainer>
  )
}

// ── Actividad de una incidencia (barras por media hora) ────────────
const actConfig = { n: { label: "Ocurrencias", color: "var(--chart-2)" } } satisfies ChartConfig

export function ActivityChart({ histogram, className }: { histogram: Record<string, number>; className?: string }) {
  const step = 30 * 60000
  const end = Math.floor(Date.now() / step) * step
  const data = Array.from({ length: 48 }, (_, i) => {
    const t = end - (47 - i) * step
    return { t, n: histogram[new Date(t).toISOString()] || 0 }
  })
  const ticks = niceTicks(Math.max(1, ...data.map((d) => d.n)), 3)
  return (
    <ChartContainer config={actConfig} className={className}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap="14%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" tickFormatter={(t) => bucketLabel(new Date(t).toISOString(), 30)} minTickGap={40} {...axis} />
        <YAxis width={32} ticks={ticks} domain={[0, ticks[ticks.length - 1]]} allowDecimals={false} {...axis} />
        <ChartTooltip cursor={{ fill: "var(--muted)", opacity: 0.6 }}
          content={<ChartTooltipContent hideIndicator valueFormatter={(v) => number(v)}
            labelFormatter={(_, payload) => payload?.[0] ? dateTime(new Date(payload[0].payload.t).toISOString()) : ""} />} />
        <Bar dataKey="n" fill="var(--color-n)" radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  )
}
