# Revel Guardia (revel-heroku-ai-monitor v5)

Monitor de producción del backend Go de Revel en Heroku. Lee los logs en tiempo real, correlaciona cada error con su petición, los agrupa en **incidencias** (como Sentry), los clasifica de forma determinista y usa un modelo local (Ollama, `qwen3.5:9b` por defecto) para diagnosticar las importantes con el **código exacto del handler**. Ningún log ni código sale de tu máquina.

```
Heroku ──► heroku-api / heroku-cli / drain Logplex / n8n ──► pipeline ──► SQLite
                                                              │            │
                         routes*.go + índice Go + git blame ──┤            ├─► dashboard (SSE)
                                                              ▼            │
                                                   Ollama (1 vez por huella)└─► n8n ─► Slack
```

## Puesta en marcha

Requisitos: **Node ≥ 22.13** (usa `node:sqlite`; el monitor no tiene dependencias ni necesita `npm install`), [Ollama](https://ollama.com) con el modelo descargado y, opcionalmente, la Heroku CLI.

```bash
ollama pull qwen3.5:9b
cp .env.example .env        # ajusta HEROKU_API_TOKEN o deja la CLI
npm start                   # http://127.0.0.1:3333
```

Funciona igual en Linux y Windows: el backend se busca en `~/revel_backend`, `~/GolandProjects/revel_backend` o `~/revel-backend`, o donde diga `BACKEND_PATH`.

Otros modos:

```bash
npm run replay -- heroku.log              # reproduce un fichero (logs de Heroku o logs/log-*.log del backend)
node src/index.js --replay f.log --exit   # reproduce, espera a la IA y sale
node src/index.js --no-ai                 # sin Ollama
npm test                                  # 41 tests, sin red ni Ollama
```

## Fuentes de logs

| Fuente | Cómo | Cuándo usarla |
|---|---|---|
| `heroku-api` | Log-session con `tail=true` contra la Platform API. Solo necesita `HEROKU_API_TOKEN` (scope `read`). Reconexión con backoff y relleno de hueco (`lines=200`). | **Recomendada.** No depende de la CLI ni de su sesión. |
| `heroku-cli` | `heroku logs --tail`, ahora con reconexión (la CLI corta la sesión cada cierto tiempo y antes el monitor se quedaba mudo). | Si no quieres crear token. |
| Drain de Logplex | `heroku drains:add "https://TU-TUNEL/api/ingest?token=..." -a revel`. Parser de tramas por **bytes**, no por caracteres. | Si expones el monitor con un túnel. |
| n8n | `POST /api/ingest/n8n` con `X-Monitor-Token`. Acepta `{lines:[...]}`, `{logs:"..."}`, items de n8n o texto. | Para reutilizar la n8n de la VM `revel-test-db`. |
| Texto | `POST /api/ingest/raw`, una línea por renglón. | Pruebas. |

Todas las fuentes pasan por el mismo pipeline y se **deduplican por contenido**, así que puedes tener varias a la vez sin contar doble.

Sin `INGEST_TOKEN`, los endpoints de ingesta solo aceptan peticiones desde la propia máquina.

## Qué hace el pipeline

1. **Parseo** (`src/pipeline/parse.js`): router de Heroku (método, ruta, status, `service`, `request_id`, códigos `H12`/`H10`…), `[EndPoint] … (401)` con colores ANSI (también si alguien se comió el ESC), líneas `[Func] Failed to …`, `fichero.go:línea`, `user_id=`, panics multilínea, eventos de dyno (`R14`, `crashed`) y deploys (`Release vNNN`).
2. **Correlación** (`src/pipeline/pipeline.js`): en Heroku el orden real es *causa → `[EndPoint]` → router*. Las líneas de error se guardan por dyno y se asignan a la petición que termina dentro de su duración, prefiriendo las del **handler de esa ruta** según `routes*.go`. `[EndPoint]` y router se fusionan en una sola petición. Lo que no pertenece a ninguna petición (Redis, cron) es una incidencia en segundo plano.
3. **Clasificación** (`src/pipeline/classify.js`): categoría (pagos, panic, infraestructura, timeout, base de datos, validación, autenticación, no encontrado, lentitud, bots…), severidad (`noise` → `critical`) y si es **esperado** (401 por token ausente, "insufficient coins"…). Los patrones de pago vienen del workflow de n8n de alertas de pagos.
4. **Agrupación**: cada incidencia tiene una huella estable (ruta normalizada + función + mensaje sin IDs, emails, importes ni `pm_…`). Todos los bots van en una sola incidencia. Si una incidencia resuelta reaparece, se **reabre como regresión**. Diez ocurrencias en 5 min marcan un **pico** y suben la severidad un nivel. Si aparece en los 30 min siguientes a un deploy, queda marcada con su versión.
5. **Métricas** por minuto: peticiones, 4xx, 5xx, lentas, Apdex y latencia media.

## IA

- **Una llamada por incidencia nueva** (o reabierta, o con pico), nunca por cada ocurrencia. La cola va por prioridad (severidad y regresión), tiene tope (`AI_MAX_QUEUE`) y lo que estaba a medias se retoma al reiniciar.
- **No se gasta IA** en ruido, bots ni en lo esperado de baja severidad. Umbral: `ANALYZE_MIN_SEVERITY`. Desde el dashboard puedes forzar el análisis de cualquier incidencia.
- **Contexto exacto**: evidencias reales, clasificación automática, el handler de la ruta, la función que registró el error y la función de `fichero.go:línea`, más `git blame`, que ignora las líneas `log.Printf` del refactor masivo para no señalar siempre ese commit.
- **Salida estructurada** con JSON Schema de Ollama (`think: false`, timeout real y reintentos) y **verificación**: si el `exact_error` no aparece literalmente en los logs, o el modelo cita un fichero o una función que no existen, la confianza baja y se marca en la UI.
- **Parches** (`AUTOFIX_MODE`):
  - `suggest` (por defecto): solo si el diagnóstico es `backend_bug`, está verificado y tiene confianza ≥ 0,7. Se pide la función corregida, se rechaza si cambia la firma, se añaden los imports que falten (`errors`, `database/sql`…), se valida con `gofmt -e` y se muestra como diff que pasa `git apply`.
  - `branch`: además crea `ai-fix/<id>-<fecha>` con *git plumbing* (`hash-object` + índice temporal + `commit-tree` + `update-ref`), partiendo de `HEAD`. **No hace checkout, no toca tu working tree ni tus cambios sin commitear.** Si la función tiene cambios sin commitear, solo genera el diff.

## Alertas con n8n

`n8n/monitor-to-slack.json` es un workflow para la n8n de la VM `revel-test-db`: Webhook → validar token → buscar en `Users` los afectados (misma credencial MySQL que el monitor de pagos) → mensaje → Slack. El monitor avisa:

- al instante, si la incidencia es crítica, una regresión o un pico;
- en el resto de severidades ≥ `ALERT_MIN_SEVERITY`, cuando termina el diagnóstico, para que el aviso ya lleve causa y arreglo;
- como mucho una vez cada 30 min por incidencia, nunca de lo esperado ni de lo ignorado.

```bash
# .env, con el túnel SSH de "n8n VM.bat" abierto (-L 5678:localhost:5678)
N8N_WEBHOOK_URL=http://localhost:5678/webhook/revel-guardia
N8N_WEBHOOK_TOKEN=<lo mismo que REVEL_GUARDIA_TOKEN en /opt/n8n/n8n.env>
```

En la VM: añade `REVEL_GUARDIA_TOKEN` (y, si quieres otro canal, `SLACK_WEBHOOK_URL_GUARDIA`) a `/opt/n8n/n8n.env`, recrea el contenedor, importa el workflow, asígnale la credencial MySQL y publícalo (`n8n publish:workflow`). Recuerda que tras `import:workflow` queda desactivado.

`n8n/heroku-logs-to-monitor.json` hace lo contrario: n8n lee los logs cada minuto (ventana fija, sin `staticData`, igual que el arreglo del 22-09 del workflow de pagos) y los manda a `REVEL_GUARDIA_URL/api/ingest/n8n`. Solo tiene sentido si el monitor es accesible desde la VM, por ejemplo con un túnel inverso. Con `heroku-api` en local no hace falta.

Mientras el monitor no esté probado en producción, deja activo el workflow de pagos actual: los dos pueden avisar del mismo error de Stripe.

## Dashboard

React con Vite, Tailwind y shadcn/ui, con la misma base que la intranet de Brisa Coffee: sidebar, tarjetas de indicadores con umbral, tablas ordenables y gráficos de Recharts. El código está en `web/` y se compila a `public/`, que va commiteado, así que `npm start` no necesita compilar nada.

| Sección | Qué muestra |
|---|---|
| **Resumen** | Estado del servicio con una frase que lo interpreta, peticiones del periodo y tráfico por tramo (correctas, 4xx y 5xx) con los deploys marcados. Cuatro indicadores con su umbral: 5xx < 1 %, p95 < 1 s, Apdex ≥ 0,85 e incidencias activas. Debajo, latencia p95 y media, ocurrencias por categoría, endpoints con más errores y **Para revisar**: críticas, regresiones, picos, parches listos, diagnósticos fallidos y fuentes caídas. |
| **Incidencias** | Tabla ordenable con severidad, ruta, categoría, ocurrencias, usuarios, última y primera vez, estado y diagnóstico. Pestañas por estado (con recuento), búsqueda, filtros de categoría y severidad, y la opción de incluir el ruido. |
| **Incidencia** | Cabecera con etiquetas y acciones (reconocer, resolver, ignorar, reabrir). Diagnóstico con causa, pasos, tipo, confianza y avisos de verificación. Líneas de log con el error resaltado, parche con el diff coloreado, ocurrencias recientes, actividad en 24 h, código y último cambio, usuarios afectados y clasificación. |
| **Endpoints** | Cada ruta con peticiones, 5xx, 4xx, % de error, p50, p95, peticiones lentas e incidencias abiertas. Marca las rutas llamadas que no existen en `routes*.go`. |
| **Deploys** | Cada release comparada con los 30 min anteriores (peticiones, 5xx, 4xx, p95), con un veredicto y las incidencias que aparecieron justo después. |
| **En directo** | Errores, 4xx, eventos de plataforma y deploys según llegan, con filtro y pausa. |
| **Fuentes y ajustes** | Estado de cada fuente, de la IA (cola, analizadas y fallidas) y de las alertas de n8n, más la configuración efectiva sin secretos y cómo conectar más fuentes. |

El periodo (15 min a 30 días) se elige arriba y se recuerda. Todo se actualiza en vivo por SSE. Tiene tema claro y oscuro y se adapta a móvil.

Los colores de tráfico están validados para daltonismo en los dos temas, y cada serie lleva leyenda y tooltip. Los estados siempre van con icono y texto, nunca solo con color.

Para desarrollar la interfaz:

```bash
cd web && npm install
npm run dev      # http://localhost:5174, proxifica /api al monitor en :3333
npm run build    # compila a ../public (commitea el resultado)
```

## API

| Método | Ruta | |
|---|---|---|
| GET | `/api/health` | Estado global, fuentes, IA y alertas |
| GET | `/api/stats?range=15m\|1h\|6h\|24h\|7d\|30d\|all[&anchor=latest]` | Serie temporal, totales y percentiles de latencia |
| GET | `/api/issues?state=active\|open\|ack\|resolved\|ignored\|all&range=&q=&noise=1` | Lista |
| GET | `/api/issues/:id` | Detalle con ocurrencias e histograma |
| GET | `/api/routes?range=` | Tráfico, errores y latencia (p50/p95) por endpoint |
| GET | `/api/releases?range=` | Deploys con métricas antes/después e incidencias nuevas |
| GET | `/api/config` | Configuración efectiva sin secretos |
| POST | `/api/issues/:id/state` `{state}` | Requiere cabecera `X-AIMON: 1` |
| POST | `/api/issues/:id/analyze` | Requiere `X-AIMON: 1` |
| GET | `/api/stream` | Server-Sent Events: `issue`, `req`, `tail`, `health`, `release` |
| POST | `/api/ingest`, `/api/ingest/n8n`, `/api/ingest/raw` | Ingesta |

## Herramienta: `tools/add-error-logs.js`

Es la versión mantenida del antiguo `refactor_logs.js` (ver `docs/2026-06-error-logging-refactor.md`). Busca `if err != nil {` sin log y propone un `log.Printf("[Func] Failed to …: %v\n", err)`. Por defecto solo informa; con `--apply` escribe. Revisa el diff y compila tú.

```bash
node tools/add-error-logs.js --dir services --limit 20
```

## Qué se arregló respecto a la v4

**Harness**
- Se llamaba al modelo **dos veces por cada ocurrencia** y otra más para regenerar la checklist con cada log guardado, bots incluidos. La cola crecía sin límite. Ahora es una llamada por incidencia, con prioridad y tope.
- No había timeout en las llamadas a Ollama: una petición colgada bloqueaba la cola para siempre.
- `format: 'json'` sin esquema, errores tragados en `catch {}` vacíos, y confianza "HIGH" si el texto medía más de 5 caracteres. Ahora hay JSON Schema y verificación contra logs y código.
- **Auto-fix peligroso**: hacía `git checkout -b`/`checkout` en el repo del backend en caliente (con GoLand abierto) y sustituía por números de línea indexados al arrancar, que podían estar desfasados y corromper el fichero. Lo hacía solo. Ahora genera diffs verificados y ramas sin checkout.

**Lógica e ingesta**
- Correlacionaba por "mismo segundo HH:MM:SS" en todos los dynos y sin fecha, y mandaba al modelo todo lo que ocurriera en ese segundo. Ahora correlaciona por dyno, duración de la petición y handler.
- No reconocía las líneas `[EndPoint]` (URL completa con colores ANSI). Si no sabía el status, ponía 400 por defecto, y el método GET.
- El parser de Logplex medía en caracteres: se rompía con tildes o emoji. Además, `/api/ingest` no tenía autenticación.
- `heroku logs --tail` sin reconexión: cuando la CLI cortaba, el monitor dejaba de recibir logs sin avisar.
- Ruta de Windows fija en el código, `sqlite3` nativo (problemas al compilar) y Socket.io con CORS `*`.
- El "RAG" puntuaba funciones por palabras sueltas. Ahora la ruta se resuelve con `routes*.go` (426 rutas) y la función sale del `[Func]` del log o del `fichero.go:línea`.
- El git blame cogía el autor de la primera línea, no el cambio más reciente.

**Clasificación**
- No había severidad, ni noción de "esperado", ni agrupación: cada 401 por token caducado era una tarjeta y una llamada al modelo. Ahora hay categorías y severidades, ruido separado y huellas.
- "Cascada": cualquier 4xx en los 15 s siguientes a cualquier 5xx se marcaba como cascada. Se ha eliminado. Ahora la infraestructura (Redis, H12, R14, crashes) tiene su categoría y el modelo tiene instrucciones de no culpar al handler.
- La lista de bots marcaba rutas legítimas por subcadenas (`.local`, `.config`, `credentials`). Ahora se aplica sobre el path con patrones anclados, y los 404 fuera de la API cuentan como sondeo.
