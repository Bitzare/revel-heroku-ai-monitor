// En directo: errores, peticiones fallidas, eventos de plataforma y deploys
// según llegan. Las peticiones correctas no se listan (van a las métricas).

import { Pause, Play, Search } from "lucide-react"
import { useMemo, useState } from "react"
import { useApp } from "@/app/app-context"
import { Tag } from "@/components/dashboard/badges"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { clock } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import type { TailLine } from "@/lib/types"

const LEVEL: Record<TailLine["level"], { label: string; tone: "bad" | "warn" | "info" | "neutral" }> = {
  error: { label: "Error", tone: "bad" },
  warn: { label: "4xx", tone: "warn" },
  platform: { label: "Plataforma", tone: "bad" },
  release: { label: "Deploy", tone: "info" },
}

type Filter = "all" | "error" | "warn" | "platform"

export function DirectoPage() {
  const { tail, paused, setPaused } = useApp()
  const { t, tn } = useI18n()
  const [q, setQ] = useState("")
  const [filter, setFilter] = useState<Filter>("all")

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    return tail
      .filter((l) => (filter === "all" || (filter === "platform" ? l.level === "platform" || l.level === "release" : l.level === filter)) && (!term || l.text.toLowerCase().includes(term)))
      .slice(-300)
      .reverse()
  }, [tail, q, filter])

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4">
        <div className="flex w-full flex-wrap items-baseline justify-between gap-2">
          <CardTitle>{t("Eventos según llegan")}</CardTitle>
          <CardDescription>
            {paused ? t("En pausa: los eventos nuevos no se añaden a la lista.") : t("{n} en pantalla, los más recientes arriba.", { n: tn(rows.length, "{n} evento", "{n} eventos") })}
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-60 flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Filtrar por texto")} className="pl-8" aria-label={t("Filtrar")} />
          </div>
          <ToggleGroup type="single" variant="outline" size="sm" value={filter} onValueChange={(v) => v && setFilter(v as Filter)} aria-label={t("Tipo")}>
            <ToggleGroupItem value="all" className="px-3">{t("Todo")}</ToggleGroupItem>
            <ToggleGroupItem value="error" className="px-3">{t("Errores")}</ToggleGroupItem>
            <ToggleGroupItem value="warn" className="px-3">4xx</ToggleGroupItem>
            <ToggleGroupItem value="platform" className="px-3">{t("Plataforma y deploys")}</ToggleGroupItem>
          </ToggleGroup>
          <Button variant="outline" size="sm" onClick={() => setPaused(!paused)} className="ml-auto">
            {paused ? <Play /> : <Pause />}{paused ? t("Reanudar") : t("Pausar")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-2 sm:px-4">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-24 text-xs font-medium text-muted-foreground">{t("Hora")}</TableHead>
              <TableHead className="w-20 text-xs font-medium text-muted-foreground">Dyno</TableHead>
              <TableHead className="w-28 text-xs font-medium text-muted-foreground">{t("Tipo")}</TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground">{t("Mensaje")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? rows.map((l, i) => (
              <TableRow key={`${l.ts}-${i}`}>
                <TableCell className="align-top font-mono text-xs tabular">{clock(l.ts)}</TableCell>
                <TableCell className="align-top font-mono text-xs text-muted-foreground">{l.dyno}</TableCell>
                <TableCell className="align-top"><Tag tone={LEVEL[l.level].tone}>{t(LEVEL[l.level].label)}</Tag></TableCell>
                <TableCell className="font-mono text-[12.5px] break-all whitespace-normal">{l.text}</TableCell>
              </TableRow>
            )) : (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="py-10 text-center whitespace-normal text-muted-foreground">
                  {tail.length ? t("Ningún evento coincide con el filtro.") : t("Sin eventos todavía. Aparecerán aquí en cuanto llegue un error, una petición fallida o un deploy.")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
