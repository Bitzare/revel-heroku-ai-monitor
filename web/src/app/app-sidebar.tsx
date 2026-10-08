import { Moon, Sun } from "lucide-react"
import { NavLink, useLocation } from "react-router"
import { ServiceStatus } from "@/components/dashboard/badges"
import { Button } from "@/components/ui/button"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarHeader, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, useSidebar,
} from "@/components/ui/sidebar"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useI18n, type Lang } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { useApp } from "./app-context"
import { ROUTES, type RouteMeta } from "./routes"

function NavItems({ items }: { items: RouteMeta[] }) {
  const { pathname } = useLocation()
  const { setOpenMobile } = useSidebar()
  const { health } = useApp()
  const { t } = useI18n()
  const openHot = health ? health.criticalOpen + health.highOpen : 0
  return (
    <SidebarMenu>
      {items.map((r) => {
        const active = r.path === "/" ? pathname === "/" : pathname.startsWith(r.path)
        return (
          <SidebarMenuItem key={r.path}>
            <SidebarMenuButton asChild isActive={active} size="lg"
              className="h-10 data-[active=true]:bg-sidebar-primary data-[active=true]:text-sidebar-primary-foreground data-[active=true]:hover:bg-sidebar-primary/90">
              <NavLink to={r.path} onClick={() => setOpenMobile(false)}>
                <r.icon />
                <span>{t(r.nav ?? r.title)}</span>
              </NavLink>
            </SidebarMenuButton>
            {r.path === "/incidencias" && openHot > 0 && (
              <SidebarMenuBadge className={cn("rounded-full px-1.5 tabular", active ? "text-sidebar-primary-foreground" : "bg-bad-soft text-bad")}>{openHot}</SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        )
      })}
    </SidebarMenu>
  )
}

function Wordmark() {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden="true">
        <rect width="32" height="32" rx="8" className="fill-sidebar-primary" />
        <path d="M5 17h5l3-7 4 13 3-9 2 3h5" fill="none" className="stroke-sidebar-primary-foreground" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="flex flex-col leading-tight">
        <span className="text-[15px] font-bold tracking-tight">Revel Guardia</span>
        <span className="text-xs text-muted-foreground">{t("Monitor de producción")}</span>
      </div>
    </div>
  )
}

export function AppSidebar() {
  const { health, theme, toggleTheme } = useApp()
  const { t, lang, setLang } = useI18n()
  const main = ROUTES.filter((r) => r.group === "main")
  const ops = ROUTES.filter((r) => r.group === "ops")
  const ai = health?.ai

  return (
    <Sidebar>
      <SidebarHeader className="px-4 pt-5 pb-3">
        <NavLink to="/"><Wordmark /></NavLink>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent><NavItems items={main} /></SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>{t("Operación")}</SidebarGroupLabel>
          <SidebarGroupContent><NavItems items={ops} /></SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-3 border-t border-sidebar-border p-4">
        <dl className="flex flex-col gap-2 text-[13px]">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{t("Servicio")}</dt>
            <dd><ServiceStatus status={health?.status ?? "unknown"} compact /></dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">App</dt>
            <dd className="font-mono text-xs">{health?.app ?? "—"}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{t("Modelo")}</dt>
            <dd className="flex items-center gap-1.5 font-mono text-xs">
              <span className={cn("size-1.5 rounded-full", !ai?.enabled ? "bg-muted-foreground" : ai.ok ? "bg-good" : "bg-bad")} aria-hidden="true" />
              {ai?.enabled ? ai.model : t("desactivado")}
            </dd>
          </div>
        </dl>
        <div className="flex items-center gap-2">
          <ToggleGroup type="single" variant="outline" size="sm" value={lang} onValueChange={(v) => v && setLang(v as Lang)}
            aria-label={t("Idioma")} className="shrink-0">
            <ToggleGroupItem value="es" className="px-2.5" aria-label="Español" title="Español">ES</ToggleGroupItem>
            <ToggleGroupItem value="en" className="px-2.5" aria-label="English" title="English">EN</ToggleGroupItem>
          </ToggleGroup>
          <Button variant="outline" size="sm" onClick={toggleTheme} className="flex-1 justify-start">
            {theme === "dark" ? <Sun /> : <Moon />}
            {theme === "dark" ? t("Tema claro") : t("Tema oscuro")}
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
