#!/usr/bin/env node
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const http = require('http');
const path = require('path');

// ==========================================
// CONFIGURACIÓN PRINCIPAL
// ==========================================
const APP_NAME = 'revel';
const OUTPUT_LOG = 'revel_ai_errors.log';
const CHECKLIST_FILE = 'revel_ai_checklist.json';
const BASELINE_FILE = 'revel_ai_baseline.json';
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const MODEL_NAME = 'deepseek-coder:6.7b';

// ==========================================
// CONFIGURACIÓN RAG SEMÁNTICA
// ==========================================
const BACKEND_PATH = 'C:\\Users\\Rushu\\GolandProjects\\revel_backend';

// MEJORA #5: ROUTE_MAP auto-descubierto al inicio.
// Esta estructura se usa solo como fallback si el auto-discovery falla.
const ROUTE_MAP_FALLBACK = {
    '/competitions': '/handlers/competitions',
    '/categories':   '/handlers/competitions',
    '/matches':      '/handlers/competitions',
    '/trainings':    '/handlers/trainings',
    '/payments':     '/handlers/payments',
    '/sessions':     '/handlers/sessions',
    '/profile':      '/handlers/users',
    '/users':        '/handlers/users',
    '/chats':        '/handlers/chats',
    '/clubs':        '/handlers/clubs',
    '/venues':       '/handlers/venues',
    '/courts':       '/handlers/courts',
    '/events':       '/handlers/events',
    '/checkin':      '/handlers/admin',
    '/stores':       '/handlers/stores',
    '/meetings':     '/handlers/meetings',
    '/premium':      '/handlers/premium',
    '/rankings':     '/handlers/rankings',
    '/bookings':     '/handlers/booking',
    '/licenses':     '/handlers/licenses'
};

let ROUTE_MAP = { ...ROUTE_MAP_FALLBACK };

// ==========================================
// MEJORA #5: AUTO-DISCOVERY DE HANDLERS
// ==========================================
function autoDiscoverRoutes() {
    const handlersBase = path.join(BACKEND_PATH, 'handlers');
    try {
        if (!fs.existsSync(handlersBase)) return;
        const dirs = fs.readdirSync(handlersBase, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);

        for (const dir of dirs) {
            const folderPath = `/handlers/${dir}`;
            // fuzzy-match: "/bookings" -> "booking", "/venues" -> "venues"
            const segment = `/${dir}`;
            if (!ROUTE_MAP[segment]) {
                ROUTE_MAP[segment] = folderPath;
            }
            // También añadir el singular si el directorio está en plural (o viceversa)
            const singular = `/${dir.replace(/s$/, '')}`;
            if (!ROUTE_MAP[singular]) {
                ROUTE_MAP[singular] = folderPath;
            }
        }
        console.log(`🗺️  ROUTE_MAP auto-descubierto: ${Object.keys(ROUTE_MAP).length} rutas`);
    } catch (err) {
        console.warn('⚠️  Auto-discovery falló, usando ROUTE_MAP de fallback.');
    }
}

// ==========================================
// MEJORA #1: RAG SEMÁNTICO (por función, no por archivo)
// ==========================================
const MAX_RAG_CHARS = 2200; // Más restrictivo, más calidad
const FUNC_REGEX = /^func\s+\w+/m;

function extractRelevantFunctions(sourceCode, urlPath) {
    const pathSegments = urlPath.split('/').filter(Boolean);
    const lines = sourceCode.split('\n');
    const funcs = [];
    let currentFunc = null;
    let braceDepth = 0;
    let inFunc = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!inFunc && FUNC_REGEX.test(line)) {
            currentFunc = { name: line.trim(), lines: [line], start: i };
            inFunc = true;
            braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
        } else if (inFunc) {
            currentFunc.lines.push(line);
            braceDepth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
            if (braceDepth <= 0) {
                funcs.push(currentFunc);
                inFunc = false;
                currentFunc = null;
            }
        }
    }

    // Rankear funciones por relevancia al path
    const scored = funcs.map(f => {
        let score = 0;
        for (const seg of pathSegments) {
            if (f.name.toLowerCase().includes(seg.toLowerCase())) score += 2;
        }
        // Funciones handler tienen más peso
        if (/Handler|Create|Update|Delete|Get|List/i.test(f.name)) score += 1;
        return { ...f, score };
    }).sort((a, b) => b.score - a.score);

    let ctx = '';
    for (const f of scored) {
        const block = f.lines.join('\n');
        if (ctx.length + block.length > MAX_RAG_CHARS) break;
        ctx += block + '\n\n';
    }
    return ctx;
}

function getSourceContext(targetPath) {
    let sourceContext = '';
    for (const [urlKeyword, folderPath] of Object.entries(ROUTE_MAP)) {
        if (targetPath.includes(urlKeyword)) {
            const targetDir = path.join(BACKEND_PATH, folderPath);
            try {
                const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.go'));
                for (const file of files) {
                    const raw = fs.readFileSync(path.join(targetDir, file), 'utf8');
                    const funcCtx = extractRelevantFunctions(raw, targetPath);
                    if (funcCtx) sourceContext += `// ${folderPath}/${file}\n${funcCtx}`;
                    if (sourceContext.length > MAX_RAG_CHARS) break;
                }
                break;
            } catch (err) { /* dir no accesible */ }
        }
    }
    return sourceContext;
}

// ==========================================
// ESTADO INTERNO
// ==========================================
let timeBuckets = {};
const activeRequestsCache = new Map();
const CACHE_TTL_MS = 10000;
let herokuProcess = null;
let checklistDebounceTimer = null;
let isGeneratingChecklist = false;

// MEJORA #3: Cola de análisis para evitar saturar Ollama
const analysisQueue = [];
let isProcessingQueue = false;

// MEJORA #8: Baseline de error rates por hora
let errorBaseline = {}; // { "endpoint_HH": { avgRate: N, samples: N } }
let currentWindowErrors = {}; // { "endpoint": count } por ventana de 60s
let lastWindowReset = Date.now();
const WINDOW_MS = 60000;
const ANOMALY_MULTIPLIER = 2.0;

// ==========================================
// MEJORA #4: LOG WRITER ASYNC (no bloquea event loop)
// ==========================================
const logStream = fs.createWriteStream(OUTPUT_LOG, { flags: 'a', encoding: 'utf8' });

function writeLog(text) {
    return new Promise((resolve, reject) => {
        logStream.write(text, err => err ? reject(err) : resolve());
    });
}

// ==========================================
// DETECCIÓN Y CLASIFICACIÓN
// ==========================================
const TRIGGER_REGEX = /(status=(4\d\d|5\d\d)|\((4\d\d|5\d\d)\)|panic|Error \d+|duplicate entry|runtime error|mysql|sql:|invalid syntax|detached)/i;

// MEJORA #7: Filtro negativo para SQL noise
const SQL_NOISE_REGEX = /sql:.*(?:register|ping|driver|open|pool|acquire)/i;

// MEJORA #8: Clasificación de errores transitorios antes de llamar a Ollama
const TRANSIENT_REGEX = /timeout|connection refused|EOF|context canceled|deadline exceeded|reset by peer|broken pipe|no such host/i;

const SAFE_NOISE   = ['.txt', '.ico', '.png', '.jpg', '.css', '.js', '.svg'];
const THREAT_NOISE = ['.env', '.git', '.bak', '.php', 'wp-admin', 'wp-includes', '.yaml', '.sql', '.yml', '.config', '.local'];

function getPathCategory(urlPath) {
    if (!urlPath) return 'UNKNOWN';
    const lower = urlPath.toLowerCase();
    if (THREAT_NOISE.some(ext => lower.includes(ext))) return 'THREAT';
    if (SAFE_NOISE.some(ext => lower.includes(ext))) return 'SAFE';
    return 'API';
}

function extractPath(line) {
    const herokuMatch = line.match(/path="([^"\s?]+)"/i);
    if (herokuMatch) return herokuMatch[1];
    const goMatch = line.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?]+)/i);
    if (goMatch) return goMatch[2];
    return null;
}

function extractMethod(line) {
    const match = line.match(/\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/i);
    return match ? match[1].toUpperCase() : 'UNKNOWN';
}

function extractTimeFull(line) {
    const match = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/);
    return match ? match[0] : new Date().toISOString();
}

function extractTimeSecond(line) {
    const match = line.match(/(?:T|\s)(\d{2}:\d{2}:\d{2})/);
    return match ? match[1] : null;
}

function extractStatus(line) {
    const match = line.match(/(?:status=| \()([2-5]\d{2})(?:\)| )/i);
    return match ? match[1] : null;
}

function cleanLogs(rawLogs) {
    return rawLogs.split('\n').filter(line => {
        const l = line.toLowerCase();
        if (l.includes('app[heroku-redis]') || l.includes('[cors]')) return false;
        if (/status=20[04]|status=301|status=302|\(20[04]\)|\(301\)/.test(line)) return false;
        return true;
    }).join('\n');
}

function extractFirstJson(text) {
    let depth = 0, start = -1;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
            if (start === -1) start = i;
            depth++;
        } else if (text[i] === '}') {
            depth--;
            if (depth === 0 && start !== -1) return text.slice(start, i + 1);
        }
    }
    return null;
}

// ==========================================
// MEJORA #8: DETECCIÓN DE ANOMALÍAS (BASELINE)
// ==========================================
function loadBaseline() {
    try {
        if (fs.existsSync(BASELINE_FILE)) {
            errorBaseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
        }
    } catch { errorBaseline = {}; }
}

function saveBaseline() {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(errorBaseline, null, 2), 'utf8');
}

function checkAnomaly(endpoint) {
    const now = Date.now();
    // Resetear ventana cada minuto
    if (now - lastWindowReset > WINDOW_MS) {
        // Actualizar baseline con la ventana que cerró
        const hour = new Date().getHours();
        for (const [ep, count] of Object.entries(currentWindowErrors)) {
            const key = `${ep}_${hour}`;
            if (!errorBaseline[key]) {
                errorBaseline[key] = { avgRate: count, samples: 1 };
            } else {
                const b = errorBaseline[key];
                b.avgRate = (b.avgRate * b.samples + count) / (b.samples + 1);
                b.samples = Math.min(b.samples + 1, 100); // cap para evitar que el baseline sea inmovible
            }
        }
        saveBaseline();
        currentWindowErrors = {};
        lastWindowReset = now;
    }

    currentWindowErrors[endpoint] = (currentWindowErrors[endpoint] || 0) + 1;

    const hour = new Date().getHours();
    const key = `${endpoint}_${hour}`;
    const baseline = errorBaseline[key];

    if (!baseline || baseline.samples < 3) return false; // Sin suficientes datos aún
    const currentRate = currentWindowErrors[endpoint];
    return currentRate >= baseline.avgRate * ANOMALY_MULTIPLIER && currentRate >= 3;
}

// ==========================================
// PROCESAMIENTO DEL STREAM
// ==========================================
function processStreamLine(line) {
    if (!line.trim()) return;
    // MEJORA #7: Filtrar ruido de SQL antes de todo
    if (SQL_NOISE_REGEX.test(line)) return;

    const timeSec = extractTimeSecond(line);
    if (!timeSec) return;

    if (!timeBuckets[timeSec]) {
        timeBuckets[timeSec] = { lines: [], timer: null, failedRequests: new Map() };
    }
    timeBuckets[timeSec].lines.push(line);

    if (TRIGGER_REGEX.test(line)) {
        const currentPath = extractPath(line);
        if (currentPath && !currentPath.startsWith('/06/')) {
            const category = getPathCategory(currentPath);
            if (category !== 'SAFE') {
                const method = extractMethod(line);
                const status = extractStatus(line);
                const timestamp = extractTimeFull(line);

                if (!timeBuckets[timeSec].failedRequests.has(currentPath)) {
                    timeBuckets[timeSec].failedRequests.set(currentPath, {
                        method: method !== 'UNKNOWN' ? method : 'GET',
                        status: status || '400',
                        timestamp: timestamp
                    });
                } else {
                    if (status) timeBuckets[timeSec].failedRequests.get(currentPath).status = status;
                }
            }
        }
    }

    if (timeBuckets[timeSec].timer) clearTimeout(timeBuckets[timeSec].timer);
    timeBuckets[timeSec].timer = setTimeout(() => {
        const bucket = timeBuckets[timeSec];
        delete timeBuckets[timeSec];

        if (bucket.failedRequests.size === 0) return;

        const combinedLogs = bucket.lines.join('\n');

        for (const [targetPath, reqData] of bucket.failedRequests.entries()) {
            const signatureKey = `${targetPath}_${timeSec}`;
            const now = Date.now();

            if (activeRequestsCache.has(signatureKey) && activeRequestsCache.get(signatureKey) > now) continue;
            activeRequestsCache.set(signatureKey, now + CACHE_TTL_MS);
            for (const [key, expiry] of activeRequestsCache) {
                if (expiry <= now) activeRequestsCache.delete(key);
            }

            if (getPathCategory(targetPath) === 'THREAT') {
                saveErrorLog({
                    timestamp: reqData.timestamp,
                    status: reqData.status,
                    method: reqData.method,
                    url: targetPath,
                    error_real: '⚠️ THREAT SCAN / BOT',
                    suggested_fix: 'Bloquear IP en el WAF o ignorar.',
                    razonamiento: 'Detección heurística de escaneo de archivos sensibles.',
                    confidence: 'HIGH',
                    is_anomaly: false
                });
                continue;
            }

            // MEJORA #8: Detección de anomalía por rate
            const isAnomaly = checkAnomaly(targetPath);

            // MEJORA #8: Clasificación de errores transitorios — no llama a Ollama
            if (TRANSIENT_REGEX.test(combinedLogs)) {
                console.log(`  ⚡ [Transitorio] ${reqData.method} ${targetPath} — no requiere análisis`);
                saveErrorLog({
                    timestamp: reqData.timestamp,
                    status: reqData.status,
                    method: reqData.method,
                    url: targetPath,
                    error_real: combinedLogs.match(TRANSIENT_REGEX)?.[0] || 'Transient error',
                    suggested_fix: 'Error transitorio — revisar salud de DB/Redis/red.',
                    razonamiento: 'Clasificado automáticamente como error de red/timeout. No requiere cambio en código.',
                    confidence: 'MEDIUM',
                    is_anomaly: isAnomaly
                });
                continue;
            }

            // MEJORA #3: Encolar en lugar de disparar en paralelo
            analysisQueue.push({ combinedLogs, targetPath, reqData, isAnomaly });
            if (!isProcessingQueue) drainQueue();
        }
    }, 600);
}

// ==========================================
// MEJORA #3: COLA DE ANÁLISIS (serializada)
// ==========================================
async function drainQueue() {
    if (isProcessingQueue || analysisQueue.length === 0) return;
    isProcessingQueue = true;

    while (analysisQueue.length > 0) {
        const job = analysisQueue.shift();
        await analyzeWithOllamaAgentic(job.combinedLogs, job.targetPath, job.reqData, job.isAnomaly);
    }

    isProcessingQueue = false;
}

// ==========================================
// MEJORA #2: VALIDACIÓN DEL OUTPUT + SCORE CONFIANZA
// ==========================================
function validateAiOutput(result) {
    const errors = [];
    if (!result.error_real || result.error_real.length < 10) errors.push('error_real vacío o muy corto');
    if (result.error_real === 'Error desconocido') errors.push('error_real genérico');
    if (!result.razonamiento || result.razonamiento.length < 20) errors.push('razonamiento insuficiente');
    if (!result.suggested_fix) errors.push('fix ausente');

    const knownPatterns = /Error \d+|duplicate entry|invalid syntax|panic:|nil pointer|index out of range|EOF|permission denied/i;
    const confidence = errors.length === 0 && knownPatterns.test(result.error_real) ? 'HIGH'
        : errors.length <= 1 ? 'MEDIUM'
        : 'LOW';

    return { valid: errors.length <= 1, errors, confidence };
}

// ==========================================
// MOTOR AGÉNTICO
// ==========================================
async function analyzeWithOllamaAgentic(isolatedLogs, targetPath, reqData, isAnomaly = false) {
    const filteredLogs = cleanLogs(isolatedLogs);
    console.log(`\n🤖 [Fase 1] DeepSeek aislando bug: ${reqData.method} ${targetPath}`);

    // MEJORA #1: RAG semántico por función
    const sourceContext = getSourceContext(targetPath);

    const reflectionPrompt = `You are a Senior SRE debugging a Go application.
LOG TRACE:
${filteredLogs}

${sourceContext ? `SOURCE CODE CONTEXT (relevant functions only):\n${sourceContext}` : ''}

TASK:
Analyze the failed request for: [ ${reqData.method} ${targetPath} ].
Identify the EXACT raw system error trace (e.g., 'Error 1062: Duplicate entry...' or 'invalid syntax').
Write a detailed technical reflection in Spanish identifying why it failed.
Do NOT format as JSON.`;

    let reflectionText = '';
    try {
        const res1 = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: MODEL_NAME, prompt: reflectionPrompt, stream: false, options: { temperature: 0.0 } })
        });
        const data1 = await res1.json();
        reflectionText = data1.response || '';
        console.log(`  🧠 [Fase 2] Reflexión completada. Formateando output...`);
    } catch (err) {
        console.error('  ❌ Fallo en Fase 1 (Ollama no disponible?)');
        return;
    }

    const extractionPrompt = `You are a JSON formatter. Convert the SRE analysis into strict JSON.

SRE ANALYSIS:
${reflectionText}

CRITICAL RULES:
1. Output ONLY valid JSON.
2. The "error_real" field MUST be the EXACT RAW COPY of the error string. Do not summarize it.
3. If the error is not identifiable, set error_real to the most specific raw fragment found.

JSON SCHEMA:
{
  "razonamiento": "<Resumen técnico detallado en español>",
  "error_real": "<Raw error string exacto, ej: 'Error 1062...'>",
  "suggested_fix": "<Solución técnica de 1 línea>"
}`;

    try {
        const res2 = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: MODEL_NAME, prompt: extractionPrompt, stream: false, options: { temperature: 0.0 }, format: 'json' })
        });
        const data2 = await res2.json();
        let rawResponse = data2.response || '';
        rawResponse = rawResponse.replace(/<[｜|].*?[｜|]>/g, '');
        rawResponse = extractFirstJson(rawResponse) || rawResponse;
        rawResponse = rawResponse.replace(/[\x00-\x1F\x7F]/g, ' ');

        const result = JSON.parse(rawResponse);

        // MEJORA #2: Validar antes de guardar
        const validation = validateAiOutput(result);
        if (!validation.valid) {
            console.warn(`  ⚠️  Output de baja confianza (${validation.errors.join(', ')}). Guardando con flag LOW.`);
        }

        saveErrorLog({
            timestamp: reqData.timestamp,
            status: reqData.status,
            method: reqData.method,
            url: targetPath.replace(/^https?:\/\/api\.revel\.cool/, ''),
            error_real: result.error_real,
            razonamiento: result.razonamiento,
            suggested_fix: result.suggested_fix,
            confidence: validation.confidence,
            is_anomaly: isAnomaly
        });

    } catch (err) {
        console.error('  ❌ Fallo en la extracción JSON.');
    }
}

// ==========================================
// MEJORA #4 + #6: SAVE ASYNC + ROTACIÓN DE LOG
// ==========================================
const MAX_LOG_LINES = 2000;

async function saveErrorLog(aiResult) {
    const errorDisplay = aiResult.error_real || 'Error desconocido';
    const anomalyFlag = aiResult.is_anomaly ? '  🚨 ANOMALY   : RATE ANÓMALO — prioridad elevada automáticamente\n' : '';
    const logEntry = `
────────────────────────────────────────────────────────────────────────
  TIMESTAMP  : ${aiResult.timestamp || new Date().toISOString()}
  STATUS     : ${aiResult.status || '400'}
  METHOD     : ${aiResult.method || 'ERROR'}
  URL        : ${aiResult.url || 'API'}
  CONFIDENCE : ${aiResult.confidence || 'UNKNOWN'}
${anomalyFlag}  APP ERROR  : ${errorDisplay}
  FIX SUGGEST: 💡 ${aiResult.suggested_fix || 'Revisar logs.'}
────────────────────────────────────────────────────────────────────────
`;

    try {
        await writeLog(logEntry + '\n');
    } catch (err) {
        console.error('  ❌ Error escribiendo log:', err.message);
    }

    console.log(`  ✅ [${aiResult.confidence}] [${aiResult.status}] ${aiResult.method} -> ${aiResult.url}`);
    console.log(`  🚨 Error Real: 🔥 ${errorDisplay}`);
    if (aiResult.is_anomaly) console.log(`  🆘 ANOMALÍA DETECTADA en ${aiResult.url}`);

    // MEJORA #6: Rotación de log si crece demasiado
    rotateLogIfNeeded();

    if (checklistDebounceTimer) clearTimeout(checklistDebounceTimer);
    checklistDebounceTimer = setTimeout(triggerChecklistGeneration, 4000);
}

function rotateLogIfNeeded() {
    try {
        const content = fs.readFileSync(OUTPUT_LOG, 'utf8');
        const lines = content.split('\n');
        if (lines.length > MAX_LOG_LINES * 2) {
            const trimmed = lines.slice(-MAX_LOG_LINES).join('\n');
            fs.writeFileSync(OUTPUT_LOG, trimmed, 'utf8');
            console.log(`  📦 Log rotado: mantenidas las últimas ${MAX_LOG_LINES} líneas.`);
        }
    } catch { /* silencioso */ }
}

// ==========================================
// MEJORA #6: CHECKLIST CON HASH GUARD
// ==========================================
let lastChecklistHash = '';

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h.toString(16);
}

async function triggerChecklistGeneration() {
    if (!fs.existsSync(OUTPUT_LOG)) return;
    if (isGeneratingChecklist) return;

    const rawContent = fs.readFileSync(OUTPUT_LOG, 'utf8');
    const contentHash = hashString(rawContent);

    // MEJORA #6: Solo regenerar si el contenido cambió
    if (contentHash === lastChecklistHash) {
        console.log('  📋 Checklist al día — sin cambios.');
        return;
    }

    isGeneratingChecklist = true;
    lastChecklistHash = contentHash;

    try {
        const blocks = rawContent.split('────────────────────────────────────────────────────────────────────────');
        const uniqueErrors = {};

        blocks.forEach(block => {
            const urlMatch       = block.match(/URL\s+:\s+([^\n]+)/);
            const errorMatch     = block.match(/APP ERROR\s+:\s+([^\n]+)/);
            const fixMatch       = block.match(/FIX SUGGEST\s+:\s+💡\s+([^\n]+)/);
            const confidenceMatch = block.match(/CONFIDENCE\s+:\s+([^\n]+)/);
            const anomalyMatch   = block.match(/ANOMALY/);

            if (!urlMatch || !errorMatch) return;

            const url = urlMatch[1].trim();
            const error = errorMatch[1].trim();

            if (error.includes('THREAT SCAN') || url.includes('.env') || url.includes('.php')) return;

            const fix = fixMatch ? fixMatch[1].trim() : 'Revisar código.';
            const confidence = confidenceMatch ? confidenceMatch[1].trim() : 'UNKNOWN';
            const key = `${url}_${error}`;

            if (!uniqueErrors[key]) {
                uniqueErrors[key] = { url, error, fix, confidence, isAnomaly: !!anomalyMatch, count: 0 };
            }
            uniqueErrors[key].count++;
            if (anomalyMatch) uniqueErrors[key].isAnomaly = true;
        });

        const errorSummary = Object.values(uniqueErrors).sort((a, b) => b.count - a.count);
        if (errorSummary.length === 0) {
            fs.writeFileSync(CHECKLIST_FILE, '[]', 'utf8');
            return;
        }

        console.log(`\n📋 [Generando Plan de Tareas en segundo plano...]`);

        const prompt = `You are a Technical SRE Manager. Review this summary of backend errors and create a priority checklist.

CRITICAL DIRECTIONS:
1. Return ONLY a valid JSON object with a single key "tasks" holding an array.
2. Order strictly by priority. "isAnomaly: true" entries must be "Crítica".
3. "confidence: LOW" entries should note uncertainty in the action.
4. Fields MUST be in SPANISH.

JSON SCHEMA:
{
  "tasks": [
    {
      "title": "Breve título técnico",
      "endpoint": "/ruta",
      "count": 5,
      "priority": "Crítica/Alta/Media/Baja",
      "confidence": "HIGH/MEDIUM/LOW",
      "action": "Qué cambiar exactamente en Go o MySQL.",
      "impact": "Impacto de la mejora."
    }
  ]
}

DATA SUMMARY:
${JSON.stringify(errorSummary, null, 2)}`;

        const response = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: MODEL_NAME, prompt, stream: false, options: { temperature: 0.0 }, format: 'json' })
        });

        const data = await response.json();
        let rawResponse = data.response || '';
        rawResponse = extractFirstJson(rawResponse) || rawResponse;

        const result = JSON.parse(rawResponse);
        const tasksArray = result.tasks || [];

        fs.writeFileSync(CHECKLIST_FILE, JSON.stringify(tasksArray, null, 2), 'utf8');
        console.log(`  ✨ Checklist actualizado: ${tasksArray.length} tareas.`);
    } catch (err) {
        console.error('  ❌ Fallo creando checklist:', err.message);
        lastChecklistHash = ''; // Permitir reintento
    } finally {
        isGeneratingChecklist = false;
    }
}

// ==========================================
// HEROKU STREAM
// ==========================================
function startHerokuLogStream() {
    console.log(`⏳ Conectando con Heroku Stream para "${APP_NAME}"...`);
    const isWindows = process.platform === 'win32';
    herokuProcess = spawn(
        isWindows ? 'cmd.exe' : 'heroku',
        isWindows ? ['/c', 'heroku', 'logs', '--tail', '--app', APP_NAME] : ['logs', '--tail', '--app', APP_NAME]
    );
    const rl = readline.createInterface({ input: herokuProcess.stdout, terminal: false });
    rl.on('line', processStreamLine);

    herokuProcess.on('close', code => {
        console.warn(`⚠️  Heroku stream cerrado (code ${code}). Reconectando en 5s...`);
        setTimeout(startHerokuLogStream, 5000);
    });
}

// ==========================================
// HTTP SERVER (Dashboard)
// ==========================================
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/') {
        fs.readFile('dashboard.html', (err, data) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(err ? '<h1>dashboard.html no encontrado</h1>' : data);
        });
    } else if (req.url === '/api/logs') {
        fs.readFile(OUTPUT_LOG, 'utf8', (err, data) => {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(data || '');
        });
    } else if (req.url === '/api/checklist') {
        fs.readFile(CHECKLIST_FILE, 'utf8', (err, data) => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(err ? '[]' : data);
        });
    } else if (req.url === '/api/baseline') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ baseline: errorBaseline, currentWindow: currentWindowErrors }));
    } else if (req.url === '/api/queue') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ queueLength: analysisQueue.length, isProcessing: isProcessingQueue }));
    } else {
        res.writeHead(404);
        res.end();
    }
});

// ==========================================
// INICIO
// ==========================================
autoDiscoverRoutes();
loadBaseline();
startHerokuLogStream();
server.listen(3333, '127.0.0.1', () => {
    console.log(`🌐 Dashboard Ops Center listo en: http://127.0.0.1:3333`);
    console.log(`📊 Endpoints disponibles: /api/logs | /api/checklist | /api/baseline | /api/queue`);
});