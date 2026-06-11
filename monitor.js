#!/usr/bin/env node
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const http = require('http');
const path = require('path');

// --- NUEVAS DEPENDENCIAS ---
const sqlite3 = require('sqlite3').verbose();
const { Server } = require('socket.io');

// ==========================================
// CONFIGURACIÓN PRINCIPAL
// ==========================================
const APP_NAME = 'revel';
const DB_FILE = 'ops_center.db'; // Sustituye a revel_ai_errors.log y checklist.json
const BASELINE_FILE = 'revel_ai_baseline.json';
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const MODEL_NAME = 'deepseek-coder:6.7b';

// ==========================================
// INICIALIZACIÓN DE LA BASE DE DATOS SQLITE
// ==========================================
const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        status TEXT,
        method TEXT,
        url TEXT,
        error_real TEXT,
        suggested_fix TEXT,
        razonamiento TEXT,
        confidence TEXT,
        is_anomaly INTEGER
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS checklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        endpoint TEXT,
        count INTEGER,
        priority TEXT,
        confidence TEXT,
        action TEXT,
        impact TEXT
    )`);
});

// ==========================================
// CONFIGURACIÓN RAG SEMÁNTICA
// ==========================================
const BACKEND_PATH = 'C:\\Users\\Rushu\\GolandProjects\\revel_backend';

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

function autoDiscoverRoutes() {
    const handlersBase = path.join(BACKEND_PATH, 'handlers');
    try {
        if (!fs.existsSync(handlersBase)) return;
        const dirs = fs.readdirSync(handlersBase, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);

        for (const dir of dirs) {
            const folderPath = `/handlers/${dir}`;
            const segment = `/${dir}`;
            if (!ROUTE_MAP[segment]) ROUTE_MAP[segment] = folderPath;
            const singular = `/${dir.replace(/s$/, '')}`;
            if (!ROUTE_MAP[singular]) ROUTE_MAP[singular] = folderPath;
        }
        console.log(`🗺️  ROUTE_MAP auto-descubierto: ${Object.keys(ROUTE_MAP).length} rutas`);
    } catch (err) {
        console.warn('⚠️  Auto-discovery falló, usando ROUTE_MAP de fallback.');
    }
}

const MAX_RAG_CHARS = 2200;
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

    const scored = funcs.map(f => {
        let score = 0;
        for (const seg of pathSegments) {
            if (f.name.toLowerCase().includes(seg.toLowerCase())) score += 2;
        }
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
            } catch (err) {}
        }
    }
    return sourceContext;
}

// ==========================================
// ESTADO INTERNO Y COLAS
// ==========================================
let timeBuckets = {};
const activeRequestsCache = new Map();
const CACHE_TTL_MS = 10000;
let herokuProcess = null;
let checklistDebounceTimer = null;
let isGeneratingChecklist = false;

const analysisQueue = [];
let isProcessingQueue = false;

// ==========================================
// ANOMALÍAS
// ==========================================
let errorBaseline = {}; 
let currentWindowErrors = {}; 
let lastWindowReset = Date.now();
const WINDOW_MS = 60000;
const ANOMALY_MULTIPLIER = 2.0;

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
    if (now - lastWindowReset > WINDOW_MS) {
        const hour = new Date().getHours();
        for (const [ep, count] of Object.entries(currentWindowErrors)) {
            const key = `${ep}_${hour}`;
            if (!errorBaseline[key]) {
                errorBaseline[key] = { avgRate: count, samples: 1 };
            } else {
                const b = errorBaseline[key];
                b.avgRate = (b.avgRate * b.samples + count) / (b.samples + 1);
                b.samples = Math.min(b.samples + 1, 100);
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

    if (!baseline || baseline.samples < 3) return false; 
    const currentRate = currentWindowErrors[endpoint];
    return currentRate >= baseline.avgRate * ANOMALY_MULTIPLIER && currentRate >= 3;
}

// ==========================================
// DETECCIÓN Y PARSEO
// ==========================================
const TRIGGER_REGEX = /(status=(4\d\d|5\d\d)|\((4\d\d|5\d\d)\)|panic|Error \d+|duplicate entry|runtime error|mysql|sql:|invalid syntax|detached)/i;
const SQL_NOISE_REGEX = /sql:.*(?:register|ping|driver|open|pool|acquire)/i;
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
// PROCESAMIENTO DEL STREAM HEROKU
// ==========================================
function processStreamLine(line) {
    if (!line.trim()) return;
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

            const isAnomaly = checkAnomaly(targetPath);

            if (TRANSIENT_REGEX.test(combinedLogs)) {
                console.log(`  ⚡ [Transitorio] ${reqData.method} ${targetPath} — ignorando IA`);
                saveErrorLog({
                    timestamp: reqData.timestamp,
                    status: reqData.status,
                    method: reqData.method,
                    url: targetPath,
                    error_real: combinedLogs.match(TRANSIENT_REGEX)?.[0] || 'Transient error',
                    suggested_fix: 'Error transitorio — revisar salud de infraestructura de red.',
                    razonamiento: 'Clasificado automáticamente como timeout/red.',
                    confidence: 'MEDIUM',
                    is_anomaly: isAnomaly
                });
                continue;
            }

            analysisQueue.push({ combinedLogs, targetPath, reqData, isAnomaly });
            if (!isProcessingQueue) drainQueue();
        }
    }, 600);
}

// ==========================================
// COLA Y AGENTE
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

function validateAiOutput(result) {
    const errors = [];
    if (!result.error_real || result.error_real.length < 10) errors.push('error_real vacío/corto');
    if (result.error_real === 'Error desconocido') errors.push('error genérico');
    if (!result.razonamiento || result.razonamiento.length < 20) errors.push('razonamiento pobre');
    if (!result.suggested_fix) errors.push('fix ausente');

    const knownPatterns = /Error \d+|duplicate entry|invalid syntax|panic:|nil pointer|index out of range|EOF|permission denied/i;
    const confidence = errors.length === 0 && knownPatterns.test(result.error_real) ? 'HIGH'
        : errors.length <= 1 ? 'MEDIUM'
        : 'LOW';

    return { valid: errors.length <= 1, errors, confidence };
}

async function analyzeWithOllamaAgentic(isolatedLogs, targetPath, reqData, isAnomaly = false) {
    const filteredLogs = cleanLogs(isolatedLogs);
    console.log(`\n🤖 [Fase 1] IA analizando: ${reqData.method} ${targetPath}`);

    const sourceContext = getSourceContext(targetPath);

    const reflectionPrompt = `You are a Senior SRE debugging a Go application.
LOG TRACE:
${filteredLogs}

${sourceContext ? `SOURCE CODE CONTEXT:\n${sourceContext}` : ''}

TASK:
Analyze the failed request for: [ ${reqData.method} ${targetPath} ].
Identify the EXACT raw system error trace (e.g., 'Error 1062: Duplicate entry...' or 'invalid syntax').
Write a detailed technical reflection in Spanish identifying why it failed. Do NOT format as JSON.`;

    let reflectionText = '';
    try {
        const res1 = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: MODEL_NAME, prompt: reflectionPrompt, stream: false, options: { temperature: 0.0 } })
        });
        const data1 = await res1.json();
        reflectionText = data1.response || '';
        console.log(`  🧠 [Fase 2] Reflexión completada. Extrayendo...`);
    } catch (err) {
        console.error('  ❌ Fallo en Ollama.');
        return;
    }

    const extractionPrompt = `You are a JSON formatter. Convert the SRE analysis into strict JSON.

SRE ANALYSIS:
${reflectionText}

CRITICAL RULES:
1. Output ONLY valid JSON.
2. The "error_real" MUST be the EXACT RAW COPY of the error string.

JSON SCHEMA:
{
  "razonamiento": "<Resumen detallado en español>",
  "error_real": "<Raw error string exacto>",
  "suggested_fix": "<Solución técnica>"
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

        const result = JSON.parse(rawResponse);
        const validation = validateAiOutput(result);

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

    } catch (err) { console.error('  ❌ Fallo en parseo JSON final.'); }
}

// ==========================================
// ALMACENAMIENTO SQLITE Y EMISIÓN WEBSOCKET
// ==========================================
function saveErrorLog(aiResult) {
    const stmt = db.prepare(`INSERT INTO logs (timestamp, status, method, url, error_real, suggested_fix, razonamiento, confidence, is_anomaly) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    
    stmt.run(
        aiResult.timestamp, 
        aiResult.status, 
        aiResult.method, 
        aiResult.url, 
        aiResult.error_real || 'Desconocido', 
        aiResult.suggested_fix || '', 
        aiResult.razonamiento || '', 
        aiResult.confidence || 'UNKNOWN', 
        aiResult.is_anomaly ? 1 : 0,
        function(err) {
            if (err) return console.error('❌ Error SQLite:', err);
            
            // Empujar el nuevo error instantáneamente a los navegadores conectados
            aiResult.id = this.lastID;
            io.emit('new_log', aiResult);
            
            console.log(`  ✅ [Guardado BD] [${aiResult.status}] ${aiResult.method} -> ${aiResult.url}`);
            if (aiResult.is_anomaly) console.log(`  🆘 ANOMALÍA RATE ELEVADO`);
            
            // Disparar recálculo de la Checklist
            if (checklistDebounceTimer) clearTimeout(checklistDebounceTimer);
            checklistDebounceTimer = setTimeout(triggerChecklistGeneration, 4000);
        }
    );
    stmt.finalize();
}

// ==========================================
// GENERACIÓN DE CHECKLIST VÍA SQLITE
// ==========================================
let lastChecklistHash = '';

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return h.toString(16);
}

async function triggerChecklistGeneration() {
    if (isGeneratingChecklist) return;

    // Obtener los errores más frecuentes usando consultas nativas SQL en milisegundos
    const query = `
        SELECT url, error_real as error, suggested_fix as fix, confidence, MAX(is_anomaly) as isAnomaly, COUNT(*) as count
        FROM logs
        WHERE error_real NOT LIKE '%THREAT SCAN%' 
          AND error_real != 'Error desconocido'
          AND length(error_real) > 10
        GROUP BY url, substr(error_real, 1, 80)
        ORDER BY count DESC
        LIMIT 15
    `;

    db.all(query, [], async (err, rows) => {
        if (err || rows.length === 0) return;

        const contentHash = hashString(JSON.stringify(rows));
        if (contentHash === lastChecklistHash) return; // Si la tabla no ha cambiado significativamente, ignorar

        isGeneratingChecklist = true;
        lastChecklistHash = contentHash;

        console.log(`\n📋 [DB Query] Consolidando Plan de Tareas (${rows.length} grupos)...`);

        const prompt = `You are a Technical SRE Manager. Review this summary of backend errors and create a priority checklist.
CRITICAL DIRECTIONS:
1. Return ONLY a valid JSON object with a single key "tasks" holding an array.
2. Order strictly by priority. "isAnomaly: 1" entries must be "Crítica".
3. Fields MUST be in SPANISH.

JSON SCHEMA:
{
  "tasks": [
    {
      "title": "Breve título",
      "endpoint": "/ruta",
      "count": 5,
      "priority": "Crítica/Alta/Media/Baja",
      "confidence": "HIGH/MEDIUM/LOW",
      "action": "Qué cambiar exactamente en Go/MySQL.",
      "impact": "Impacto."
    }
  ]
}
DATA SUMMARY:\n${JSON.stringify(rows, null, 2)}`;

        try {
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
            
            // Guardar en SQLite la checklist actualizada y emitir
            db.serialize(() => {
                db.run("DELETE FROM checklist"); 
                const stmt = db.prepare("INSERT INTO checklist (title, endpoint, count, priority, confidence, action, impact) VALUES (?, ?, ?, ?, ?, ?, ?)");
                tasksArray.forEach(t => stmt.run(t.title, t.endpoint, t.count, t.priority, t.confidence, t.action, t.impact));
                stmt.finalize();
            });

            io.emit('update_checklist', tasksArray);
            console.log(`  ✨ Checklist DB actualizada: ${tasksArray.length} tareas.`);

        } catch (err) {
            console.error('  ❌ Fallo creando checklist IA:', err.message);
            lastChecklistHash = '';
        } finally {
            isGeneratingChecklist = false;
        }
    });
}

function startHerokuLogStream() {
    console.log(`⏳ Conectando con Heroku Stream...`);
    const isWindows = process.platform === 'win32';
    herokuProcess = spawn(isWindows ? 'cmd.exe' : 'heroku', isWindows ? ['/c', 'heroku', 'logs', '--tail', '--app', APP_NAME] : ['logs', '--tail', '--app', APP_NAME]);
    const rl = readline.createInterface({ input: herokuProcess.stdout, terminal: false });
    rl.on('line', processStreamLine);
}

// ==========================================
// HTTP SERVER Y SOCKET.IO
// ==========================================
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        fs.readFile('dashboard.html', (err, data) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    } else {
        res.writeHead(404); res.end();
    }
});

const io = new Server(server, { cors: { origin: "*" } });

io.on('connection', (socket) => {
    console.log('📡 Cliente web conectado');
    
    // Al conectar, enviamos los últimos 150 errores y la checklist actual directamente desde SQL
    db.all("SELECT * FROM logs ORDER BY id DESC LIMIT 150", [], (err, rows) => {
        if (!err) socket.emit('initial_logs', rows);
    });
    
    db.all("SELECT * FROM checklist ORDER BY count DESC", [], (err, rows) => {
        if (!err) socket.emit('update_checklist', rows);
    });
});

autoDiscoverRoutes();
loadBaseline();
startHerokuLogStream();
server.listen(3333, '127.0.0.1', () => {
    console.log(`🌐 Servidor Ops Center (WebSocket + SQLite) activo en http://127.0.0.1:3333`);
});