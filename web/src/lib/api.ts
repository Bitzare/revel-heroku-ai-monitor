// Cliente de la API del monitor. Las acciones llevan la cabecera X-AIMON que
// exige el servidor (un formulario de otra web no puede mandarla sin preflight).

import { useCallback, useEffect, useRef, useState } from "react"

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`)
  return data as T
}

export async function apiPost<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIMON": "1" },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`)
  return data as T
}

/**
 * Carga `path` y lo vuelve a pedir cuando cambia el path o `refreshKey`
 * (los eventos en vivo lo incrementan). Mantiene los datos anteriores mientras recarga.
 */
export function useApi<T>(path: string | null, refreshKey: unknown = 0) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)

  const load = useCallback(async () => {
    if (!path) return
    const id = ++seq.current
    try {
      const d = await apiGet<T>(path)
      if (id === seq.current) { setData(d); setError(null) }
    } catch (e) {
      if (id === seq.current) setError((e as Error).message)
    } finally {
      if (id === seq.current) setLoading(false)
    }
  }, [path])

  useEffect(() => { setLoading(true); void load() }, [load])
  useEffect(() => { if (refreshKey) void load() }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return { data, error, loading, reload: load }
}
