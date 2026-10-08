// Piezas de los indicadores: tarjeta de KPI, medidor contra un umbral, estado
// del umbral (icono + texto) y datos sueltos con etiqueta.

import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

type Tone = "good" | "warn" | "bad"

/** Tono de un valor frente a su umbral. `higherIsBetter` para métricas como Apdex. */
export function toneFor(value: number | null, limit: number, higherIsBetter = false): Tone {
  if (value == null) return "good"
  if (higherIsBetter) return value < limit ? "bad" : value < limit + (1 - limit) * 0.4 ? "warn" : "good"
  return value > limit ? "bad" : value > limit * 0.7 ? "warn" : "good"
}

/** Barra del valor con la marca del umbral. La escala llega a 1,5 veces el umbral. */
export function Meter({ value, limit, label, higherIsBetter = false }: { value: number | null; limit: number; label: string; higherIsBetter?: boolean }) {
  const scale = higherIsBetter ? 1 : limit * 1.5
  const t = toneFor(value, limit, higherIsBetter)
  return (
    <div className="relative mt-4 mb-6" role="img" aria-label={value == null ? "Sin datos" : label}>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        {value != null && (
          <div className={cn("h-full rounded-full transition-[width] duration-500", t === "bad" ? "bg-bad" : t === "warn" ? "bg-warn" : "bg-good")}
            style={{ width: `${Math.max(2, Math.min(100, (value / scale) * 100))}%` }} />
        )}
      </div>
      <div className="absolute -top-1 h-4 border-l-2 border-foreground" style={{ left: `${(limit / scale) * 100}%` }}>
        <span className="absolute top-5 left-0 -translate-x-1/2 text-[11px] whitespace-nowrap text-muted-foreground">{label}</span>
      </div>
    </div>
  )
}

export function ThresholdStatus({ value, limit, higherIsBetter = false, texts }: {
  value: number | null; limit: number; higherIsBetter?: boolean; texts?: Partial<Record<Tone, string>>
}) {
  if (value == null) return <span className="mt-auto text-sm text-muted-foreground">Sin tráfico en el periodo</span>
  const t = toneFor(value, limit, higherIsBetter)
  const Icon = t === "bad" ? CircleAlert : t === "warn" ? TriangleAlert : CircleCheck
  const text = texts?.[t] ?? (t === "bad" ? "Fuera del umbral" : t === "warn" ? "Cerca del umbral" : "Dentro del umbral")
  return (
    <span className={cn("mt-auto inline-flex items-center gap-1.5 text-sm font-semibold", t === "bad" ? "text-bad" : t === "warn" ? "text-warn" : "text-good")}>
      <Icon className="size-4" aria-hidden="true" />{text}
    </span>
  )
}

export function KpiCard({ label, value, valueClassName, sub, children }: {
  label: string; value: ReactNode; valueClassName?: string; sub?: ReactNode; children?: ReactNode
}) {
  return (
    <Card className="gap-0 py-5">
      <CardContent className="flex h-full flex-col gap-1 px-5">
        <h3 className="text-sm font-medium text-muted-foreground">{label}</h3>
        <p className={cn("text-[1.85rem] leading-tight font-semibold tracking-tight tabular", valueClassName)}>{value}</p>
        {sub && <p className="text-[13px] text-muted-foreground">{sub}</p>}
        {children}
      </CardContent>
    </Card>
  )
}

export function Fact({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col-reverse gap-0.5", className)}>
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="truncate text-lg font-semibold tabular">{children}</dd>
    </div>
  )
}

export function Legend({ items }: { items: { label: string; swatch: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-muted-foreground">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-2"><span className={i.swatch} aria-hidden="true" />{i.label}</li>
      ))}
    </ul>
  )
}

export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Cargando">
      <Skeleton className="h-80 rounded-xl" />
      <div className="grid gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  )
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-bad/30 bg-bad-soft px-4 py-3 text-sm text-bad">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>No se pudieron cargar los datos: {message}. Comprueba que el monitor sigue en marcha.</span>
    </div>
  )
}
