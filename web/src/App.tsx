import { lazy, Suspense, type ComponentType } from "react"
import { BrowserRouter, Navigate, Route, Routes } from "react-router"
import { AppProvider } from "@/app/app-context"
import { AppLayout } from "@/app/app-layout"
import { PageSkeleton } from "@/components/dashboard/indicators"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { I18nProvider } from "@/lib/i18n"

// Cada página en su propio chunk.
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(async () => ({ default: (await load())[name] }))
const ResumenPage = page(() => import("@/pages/resumen"), "ResumenPage")
const IncidenciasPage = page(() => import("@/pages/incidencias"), "IncidenciasPage")
const IncidenciaPage = page(() => import("@/pages/incidencia"), "IncidenciaPage")
const EndpointsPage = page(() => import("@/pages/endpoints"), "EndpointsPage")
const DeploysPage = page(() => import("@/pages/deploys"), "DeploysPage")
const DirectoPage = page(() => import("@/pages/directo"), "DirectoPage")
const SistemaPage = page(() => import("@/pages/sistema"), "SistemaPage")

const wrap = (el: React.ReactNode) => <Suspense fallback={<PageSkeleton />}>{el}</Suspense>

export default function App() {
  return (
    <I18nProvider>
    <TooltipProvider>
      <AppProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/" element={wrap(<ResumenPage />)} />
              <Route path="/incidencias" element={wrap(<IncidenciasPage />)} />
              <Route path="/incidencias/:id" element={wrap(<IncidenciaPage />)} />
              <Route path="/endpoints" element={wrap(<EndpointsPage />)} />
              <Route path="/deploys" element={wrap(<DeploysPage />)} />
              <Route path="/directo" element={wrap(<DirectoPage />)} />
              <Route path="/sistema" element={wrap(<SistemaPage />)} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AppProvider>
      <Toaster position="bottom-center" />
    </TooltipProvider>
    </I18nProvider>
  )
}
