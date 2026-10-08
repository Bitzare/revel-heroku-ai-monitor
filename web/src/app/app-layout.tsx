import { useEffect, useState } from "react"
import { Outlet, useLocation } from "react-router"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { relativeTime } from "@/lib/format"
import { PERIODS, type PeriodKey } from "@/lib/labels"
import { cn } from "@/lib/utils"
import { useApp } from "./app-context"
import { AppSidebar } from "./app-sidebar"
import { routeFor } from "./routes"

function PeriodPicker() {
  const { period, setPeriod } = useApp()
  return (
    <>
      {/* En móvil, desplegable: los seis botones no caben a 390 px */}
      <Select value={period} onValueChange={(v) => setPeriod(v as PeriodKey)}>
        <SelectTrigger className="w-44 bg-card sm:hidden" aria-label="Periodo"><SelectValue /></SelectTrigger>
        <SelectContent>{PERIODS.map((p) => <SelectItem key={p.key} value={p.key}>{p.menu}</SelectItem>)}</SelectContent>
      </Select>
      <ToggleGroup type="single" variant="outline" size="sm" value={period} onValueChange={(v) => v && setPeriod(v as PeriodKey)}
        aria-label="Periodo" className="hidden bg-card sm:flex">
        {PERIODS.map((p) => <ToggleGroupItem key={p.key} value={p.key} className="px-3">{p.label}</ToggleGroupItem>)}
      </ToggleGroup>
    </>
  )
}

function LiveIndicator() {
  const { connected, lastEventAt } = useApp()
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 5000); return () => clearInterval(t) }, [])
  const text = !connected ? "Sin conexión con el monitor" : lastEventAt ? `En vivo, último dato ${relativeTime(new Date(lastEventAt).toISOString())}` : "En vivo, esperando datos"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-[13px] text-muted-foreground" role="status">
          <span className={cn("size-2 rounded-full", connected ? "bg-good" : "bg-bad")} aria-hidden="true" />
          {connected ? "En vivo" : "Desconectado"}
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}

export function AppLayout() {
  const { pathname } = useLocation()
  const route = routeFor(pathname)
  const title = route?.title ?? ""
  const { health } = useApp()

  useEffect(() => {
    const crit = health?.criticalOpen ?? 0
    document.title = `${crit ? `(${crit}) ` : ""}${title ? `${title} · ` : ""}Revel Guardia`
  }, [title, health?.criticalOpen])
  useEffect(() => { window.scrollTo({ top: 0 }) }, [pathname])

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-3 border-b bg-background/90 px-4 py-4 backdrop-blur md:px-8">
          <SidebarTrigger className="-ml-1 md:hidden" />
          <h1 className="mr-auto text-[1.6rem] leading-tight font-semibold tracking-tight">{title}</h1>
          <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto">
            {route?.period && <PeriodPicker />}
            <LiveIndicator />
          </div>
        </header>
        <main className="flex-1 px-4 pt-5 pb-14 md:px-8">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
