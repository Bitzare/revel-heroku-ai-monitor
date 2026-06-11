#!/usr/bin/env node
const { spawn, execSync } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const http = require('http');
const path = require('path');

const sqlite3 = require('sqlite3').verbose();
const { Server } = require('socket.io');

// ==========================================
// CONFIGURACIÓN PRINCIPAL
// ==========================================
const APP_NAME = 'revel';
const DB_FILE = 'ops_center.db'; 
const BASELINE_FILE = 'revel_ai_baseline.json';
const OLLAMA_URL = 'http://localhost:11434/api/generate';

// 🚀 UPGRADE: Modelo especializado en código y obediencia JSON
const MODEL_NAME = 'qwen2.5-coder:7b';

// Si usas el Log Drain de Heroku + Ngrok, puedes poner esto en 'false'
const USE_LOCAL_CLI = true; 

// ==========================================
// DB SQLITE & MIGRACIONES AUTOMÁTICAS
// ==========================================
const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT, status TEXT, method TEXT, url TEXT,
        error_real TEXT, suggested_fix TEXT, razonamiento TEXT,
        confidence TEXT, is_anomaly INTEGER
    )`);
    // Auto-Migración Capa 2
    db.run(`ALTER TABLE logs ADD COLUMN git_blame TEXT`, (err) => {});
    db.run(`ALTER TABLE logs ADD COLUMN correlation TEXT`, (err) => {});
    
    db.run(`CREATE TABLE IF NOT EXISTS checklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT, endpoint TEXT, count INTEGER,
        priority TEXT, confidence TEXT, action TEXT, impact TEXT
    )`);
});

// ==========================================
// 🧠 CAPA 2: RAG UNIVERSAL E INDEXACIÓN DE CÓDIGO
// ==========================================
const BACKEND_PATH = 'C:\\Users\\Rushu\\GolandProjects\\revel_backend';
let globalCodeIndex = [];
const FUNC_REGEX = /^func\s+([A-Za-z0-9_]+)/;

function buildUniversalIndex(dir) {
    try {
        const files = fs.readdirSync(dir, { withFileTypes: true });
        for (const file of files) {
            const fullPath = path.join(dir, file.name);
            if (file.isDirectory()) {
                if (!['.git', 'vendor', 'node_modules', 'bin'].includes(file.name)) buildUniversalIndex(fullPath);
            } else if (file.name.endsWith('.go')) {
                const content = fs.readFileSync(fullPath, 'utf8');
                const lines = content.split('\n');
                let inFunc = false, currentFunc = null, braceDepth = 0;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (!inFunc && FUNC_REGEX.test(line)) {
                        const match = line.match(FUNC_REGEX);
                        currentFunc = { file: fullPath, name: match[1], lines: [line], start: i + 1 };
                        inFunc = true;
                        braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
                    } else if (inFunc) {
                        currentFunc.lines.push(line);
                        braceDepth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
                        if (braceDepth <= 0) {
                            currentFunc.end = i + 1;
                            globalCodeIndex.push(currentFunc);
                            inFunc = false; currentFunc = null;
                        }
                    }
                }
            }
        }
    } catch (e) { /* Fallo silencioso si carpeta no existe */ }
}

function getUniversalRAG(targetPath, errorText) {
    const pathTokens = targetPath.toLowerCase().split(/[/-]/).filter(Boolean);
    const errorTokens = errorText.toLowerCase().split(/\W+/).filter(t => t.length > 3);
    
    const scored = globalCodeIndex.map(fn => {
        let score = 0;
        const funcNameLower = fn.name.toLowerCase();
        const codeLower = fn.lines.join('\n').toLowerCase();
        
        pathTokens.forEach(pt => { if (funcNameLower.includes(pt)) score += 5; });
        errorTokens.forEach(et => { if (codeLower.includes(et)) score += 2; });
        if (fn.file.includes('handlers')) score += 1;
        
        return { ...fn, score };
    }).filter(fn => fn.score > 0).sort((a, b) => b.score - a.score);

    const topFunctions = scored.slice(0, 2); 
    if (topFunctions.length === 0) return { context: "", blame: null };

    let context = "";
    let bestBlame = null;
    
    for (const f of topFunctions) {
        context += `// ARCHIVO: ${f.file.replace(BACKEND_PATH, '')} (Líneas ${f.start}-${f.end})\n${f.lines.join('\n')}\n\n`;
        if (!bestBlame) bestBlame = executeGitBlame(f.file, f.start, f.end);
    }
    
    return { context, blame: bestBlame };
}

function executeGitBlame(filePath, startLine, endLine) {
    try {
        const cwd = path.dirname(filePath);
        const rawBlame = execSync(`git blame -L ${startLine},${endLine} --porcelain "${path.basename(filePath)}"`, { cwd, stdio: 'pipe' }).toString();
        const authorMatch = rawBlame.match(/^author (.+)$/m);
        const timeMatch = rawBlame.match(/^author-time (\d+)$/m);
        const summaryMatch = rawBlame.match(/^summary (.+)$/m);
        
        if (authorMatch && timeMatch) {
            const date = new Date(parseInt(timeMatch[1]) * 1000).toISOString().split('T')[0];
            return `Modificado por @${authorMatch[1]} el ${date} (Commit: ${summaryMatch ? summaryMatch[1] : 'N/A'})`;
        }
    } catch (e) {}
    return null;
}

// Inicializar el RAG
console.log(`⏳ Indexando código base en: ${BACKEND_PATH}`);
buildUniversalIndex(BACKEND_PATH);
console.log(`🗺️  RAG Universal listo: ${globalCodeIndex.length} funciones Go indexadas.`);

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

let recentCriticalErrors = []; 
const CASCADING_WINDOW_MS = 15000; 

// ==========================================
// ANOMALÍAS
// ==========================================
let errorBaseline = {}; let currentWindowErrors = {}; let lastWindowReset = Date.now();
const WINDOW_MS = 60000; const ANOMALY_MULTIPLIER = 2.0;

function loadBaseline() { try { if (fs.existsSync(BASELINE_FILE)) errorBaseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch { errorBaseline = {}; } }
function saveBaseline() { fs.writeFileSync(BASELINE_FILE, JSON.stringify(errorBaseline, null, 2), 'utf8'); }

function checkAnomaly(endpoint) {
    const now = Date.now();
    if (now - lastWindowReset > WINDOW_MS) {
        const hour = new Date().getHours();
        for (const [ep, count] of Object.entries(currentWindowErrors)) {
            const key = `${ep}_${hour}`;
            if (!errorBaseline[key]) errorBaseline[key] = { avgRate: count, samples: 1 };
            else {
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
    const baseline = errorBaseline[`${endpoint}_${new Date().getHours()}`];
    return baseline && baseline.samples >= 3 && currentWindowErrors[endpoint] >= baseline.avgRate * ANOMALY_MULTIPLIER && currentWindowErrors[endpoint] >= 3;
}

// ==========================================
// PARSEO DE LOGS Y WAF
// ==========================================
const TRIGGER_REGEX = /(status=(4\d\d|5\d\d)|\((4\d\d|5\d\d)\)|panic|Error \d+|duplicate entry|runtime error|mysql|sql:|invalid syntax|detached)/i;
const SQL_NOISE_REGEX = /sql:.*(?:register|ping|driver|open|pool|acquire)/i;
const TRANSIENT_REGEX = /timeout|connection refused|EOF|context canceled|deadline exceeded|reset by peer|broken pipe|no such host/i;
const THREAT_NOISE = ['.env', '.git', '.bak', '.php', 'wp-admin', 'wp-includes', '.yaml', '.sql', '.yml', '.config', '.local'];
const SAFE_NOISE   = ['.txt', '.ico', '.png', '.jpg', '.css', '.js', '.svg'];

function getPathCategory(url) {
    const lower = url?.toLowerCase() || '';
    if (THREAT_NOISE.some(ext => lower.includes(ext))) return 'THREAT';
    if (SAFE_NOISE.some(ext => lower.includes(ext))) return 'SAFE';
    return 'API';
}

function extractData(line) {
    const p = line.match(/path="([^"\s?]+)"/i) || line.match(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?]+)/i);
    const m = line.match(/\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/i);
    const ts = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/);
    const st = line.match(/(?:status=| \()([2-5]\d{2})(?:\)| )/i);
    return { path: p?.[1] || p?.[2], method: m?.[1] || 'UNKNOWN', timestamp: ts?.[0] || new Date().toISOString(), status: st?.[1] || '400' };
}

function processStreamLine(line) {
    if (!line.trim() || SQL_NOISE_REGEX.test(line)) return;
    const timeSec = line.match(/(?:T|\s)(\d{2}:\d{2}:\d{2})/)?.[1];
    if (!timeSec) return;

    if (!timeBuckets[timeSec]) timeBuckets[timeSec] = { lines: [], timer: null, failedReqs: new Map() };
    timeBuckets[timeSec].lines.push(line);

    if (TRIGGER_REGEX.test(line)) {
        const data = extractData(line);
        if (data.path && !data.path.startsWith('/06/') && getPathCategory(data.path) !== 'SAFE') {
            if (!timeBuckets[timeSec].failedReqs.has(data.path)) timeBuckets[timeSec].failedReqs.set(data.path, data);
            else if (data.status) timeBuckets[timeSec].failedReqs.get(data.path).status = data.status;
        }
    }

    if (timeBuckets[timeSec].timer) clearTimeout(timeBuckets[timeSec].timer);
    timeBuckets[timeSec].timer = setTimeout(() => {
        const bucket = timeBuckets[timeSec];
        delete timeBuckets[timeSec];
        if (bucket.failedReqs.size === 0) return;

        const combinedLogs = bucket.lines.join('\n');
        for (const [targetPath, reqData] of bucket.failedReqs.entries()) {
            const signatureKey = `${targetPath}_${timeSec}`;
            const now = Date.now();
            if (activeRequestsCache.has(signatureKey) && activeRequestsCache.get(signatureKey) > now) continue;
            activeRequestsCache.set(signatureKey, now + CACHE_TTL_MS);
            for (const [key, expiry] of activeRequestsCache) if (expiry <= now) activeRequestsCache.delete(key);

            if (getPathCategory(targetPath) === 'THREAT') {
                saveErrorLog({ timestamp: reqData.timestamp, status: reqData.status, method: reqData.method, url: targetPath, error_real: '⚠️ THREAT SCAN / BOT', suggested_fix: 'Bloquear IP en el WAF.', razonamiento: 'Escaneo detectado.', confidence: 'HIGH', is_anomaly: false });
                continue;
            }

            if (reqData.status.startsWith('5')) {
                recentCriticalErrors.push({ ts: now, path: targetPath, status: reqData.status });
            }
            recentCriticalErrors = recentCriticalErrors.filter(e => now - e.ts < CASCADING_WINDOW_MS);
            
            const cascadingSource = !reqData.status.startsWith('5') ? recentCriticalErrors.find(e => e.path !== targetPath) : null;
            let correlationText = cascadingSource ? `⚠️ Posible Cascada: Falla consecutiva tras caída ${cascadingSource.status} en ${cascadingSource.path}` : null;

            const isAnomaly = checkAnomaly(targetPath);
            analysisQueue.push({ combinedLogs, targetPath, reqData, isAnomaly, correlationText });
            if (!isProcessingQueue) drainQueue();
        }
    }, 600);
}

// ==========================================
// COLA Y AGENTE IA (RAG & BLAME)
// ==========================================
async function drainQueue() {
    if (isProcessingQueue || analysisQueue.length === 0) return;
    isProcessingQueue = true;
    while (analysisQueue.length > 0) {
        const job = analysisQueue.shift();
        await analyzeWithOllamaAgentic(job.combinedLogs, job.targetPath, job.reqData, job.isAnomaly, job.correlationText);
    }
    isProcessingQueue = false;
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
        if (text[i] === '{') { if (start === -1) start = i; depth++; }
        else if (text[i] === '}') { depth--; if (depth === 0 && start !== -1) return text.slice(start, i + 1); }
    }
    return null;
}

async function analyzeWithOllamaAgentic(isolatedLogs, targetPath, reqData, isAnomaly, correlationText) {
    const filteredLogs = cleanLogs(isolatedLogs);
    console.log(`\n🤖 [Fase 1] IA analizando: ${reqData.method} ${targetPath}`);

    const ragData = getUniversalRAG(targetPath, filteredLogs);
    
    let sysPrompt = `You are a Senior SRE debugging a Go application.\nLOG TRACE:\n${filteredLogs}\n`;
    if (ragData.context) sysPrompt += `\nSOURCE CODE CONTEXT (Auto-Retrieved via AI Search):\n${ragData.context}\n`;
    if (correlationText) sysPrompt += `\nSYSTEM CONTEXT ALERT: ${correlationText}. This might be a cascading failure! Do not overcomplicate the fix if the DB is down.\n`;
    
    sysPrompt += `\nTASK:\nAnalyze the failed request for: [ ${reqData.method} ${targetPath} ].\nIdentify the EXACT raw system error trace. Write a detailed technical reflection in Spanish. Do NOT format as JSON.`;

    let reflectionText = '';
    try {
        const res1 = await fetch(OLLAMA_URL, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ 
                model: MODEL_NAME, 
                prompt: sysPrompt, 
                stream: false, 
                options: { temperature: 0.0, num_ctx: 8192 } // 🚀 Ventana de memoria expandida 
            }) 
        });
        reflectionText = (await res1.json()).response || '';
    } catch (err) { return console.error('  ❌ Fallo en Ollama al conectar.'); }

    const extractionPrompt = `You are a JSON formatter. Convert the SRE analysis into strict JSON.\nSRE ANALYSIS:\n${reflectionText}\nCRITICAL RULES:\n1. Output ONLY valid JSON.\n2. "error_real" MUST be the EXACT RAW COPY of the error string.\nJSON SCHEMA:\n{\n  "razonamiento": "<Resumen detallado en español>",\n  "error_real": "<Raw error string exacto>",\n  "suggested_fix": "<Solución técnica>"\n}`;

    try {
        const res2 = await fetch(OLLAMA_URL, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ 
                model: MODEL_NAME, 
                prompt: extractionPrompt, 
                stream: false, 
                options: { temperature: 0.0, num_ctx: 8192 }, // 🚀 Ventana de memoria expandida 
                format: 'json' 
            }) 
        });
        let rawResponse = (await res2.json()).response || '';
        rawResponse = extractFirstJson(rawResponse.replace(/<[｜|].*?[｜|]>/g, '')) || '{}';
        const result = JSON.parse(rawResponse.replace(/[\x00-\x1F\x7F]/g, ' '));
        
        const errors = [];
        if (!result.error_real || result.error_real.length < 10) errors.push('error_real corto');
        if (!result.razonamiento) errors.push('razonamiento pobre');
        const confidence = errors.length === 0 ? 'HIGH' : 'MEDIUM';

        saveErrorLog({ 
            timestamp: reqData.timestamp, status: reqData.status, method: reqData.method, url: targetPath.replace(/^https?:\/\/api\.revel\.cool/, ''), 
            error_real: result.error_real, razonamiento: result.razonamiento, suggested_fix: result.suggested_fix, 
            confidence, is_anomaly: isAnomaly,
            git_blame: ragData.blame, correlation: correlationText 
        });
    } catch (err) { console.error('  ❌ Fallo en parseo JSON final.'); }
}

// ==========================================
// DB & WEBSOCKETS
// ==========================================
function saveErrorLog(aiResult) {
    const stmt = db.prepare(`INSERT INTO logs (timestamp, status, method, url, error_real, suggested_fix, razonamiento, confidence, is_anomaly, git_blame, correlation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(aiResult.timestamp, aiResult.status, aiResult.method, aiResult.url, aiResult.error_real || 'Desconocido', aiResult.suggested_fix || '', aiResult.razonamiento || '', aiResult.confidence || 'UNKNOWN', aiResult.is_anomaly ? 1 : 0, aiResult.git_blame || null, aiResult.correlation || null,
        function(err) {
            if (err) return;
            aiResult.id = this.lastID;
            io.emit('new_log', aiResult);
            console.log(`  ✅ [${aiResult.status}] ${aiResult.url} | 🔥 ${aiResult.error_real}`);
            if (checklistDebounceTimer) clearTimeout(checklistDebounceTimer);
            checklistDebounceTimer = setTimeout(triggerChecklistGeneration, 4000);
        }
    );
    stmt.finalize();
}

let lastChecklistHash = '';
function hashString(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0; return h.toString(16); }

async function triggerChecklistGeneration() {
    if (isGeneratingChecklist) return;
    db.all(`SELECT url, error_real as error, suggested_fix as fix, MAX(git_blame) as gitBlame, confidence, MAX(is_anomaly) as isAnomaly, COUNT(*) as count FROM logs WHERE error_real NOT LIKE '%THREAT SCAN%' AND error_real != 'Error desconocido' AND length(error_real) > 10 GROUP BY url, substr(error_real, 1, 80) ORDER BY count DESC LIMIT 15`, [], async (err, rows) => {
        if (err || rows.length === 0) return;
        const contentHash = hashString(JSON.stringify(rows));
        if (contentHash === lastChecklistHash) return;
        isGeneratingChecklist = true; lastChecklistHash = contentHash;

        const prompt = `You are a Technical SRE Manager. Create a priority checklist.\nCRITICAL DIRECTIONS:\n1. ONLY valid JSON.\n2. Fields in SPANISH.\nJSON SCHEMA:\n{\n  "tasks": [\n    {\n      "title": "Breve título",\n      "endpoint": "/ruta",\n      "count": 5,\n      "priority": "Crítica/Alta",\n      "action": "Qué cambiar. Mention author if gitBlame provided."\n    }\n  ]\n}\nDATA:\n${JSON.stringify(rows, null, 2)}`;

        try {
            const response = await fetch(OLLAMA_URL, { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ 
                    model: MODEL_NAME, 
                    prompt, 
                    stream: false, 
                    options: { temperature: 0.0, num_ctx: 8192 }, // 🚀 Ventana de memoria expandida 
                    format: 'json' 
                }) 
            });
            const tasksArray = JSON.parse(extractFirstJson((await response.json()).response || '') || '{}').tasks || [];
            
            db.serialize(() => {
                db.run("DELETE FROM checklist"); 
                const stmt = db.prepare("INSERT INTO checklist (title, endpoint, count, priority, confidence, action, impact) VALUES (?, ?, ?, ?, 'HIGH', ?, '')");
                tasksArray.forEach(t => stmt.run(t.title, t.endpoint, t.count, t.priority, t.action));
                stmt.finalize();
            });
            io.emit('update_checklist', tasksArray);
        } catch (err) { lastChecklistHash = ''; } finally { isGeneratingChecklist = false; }
    });
}

// ==========================================
// HTTP SERVER Y SYSLOG DRAIN
// ==========================================
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/api/ingest' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            const lines = []; let pos = 0;
            while (pos < body.length) {
                const spaceIdx = body.indexOf(' ', pos); if (spaceIdx === -1) break;
                const len = parseInt(body.substring(pos, spaceIdx), 10); if (isNaN(len)) break;
                lines.push(body.substring(spaceIdx + 1, spaceIdx + 1 + len));
                pos = spaceIdx + 1 + len;
            }
            lines.forEach(line => processStreamLine(line));
            res.writeHead(200); res.end('OK');
        });
        return;
    }
    if (req.url === '/') {
        fs.readFile('dashboard.html', (err, data) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data); });
    } else { res.writeHead(404); res.end(); }
});

const io = new Server(server, { cors: { origin: "*" } });
io.on('connection', (socket) => {
    db.all("SELECT * FROM logs ORDER BY id DESC LIMIT 150", [], (err, rows) => { if (!err) socket.emit('initial_logs', rows); });
    db.all("SELECT * FROM checklist ORDER BY count DESC", [], (err, rows) => { if (!err) socket.emit('update_checklist', rows); });
});

loadBaseline();
server.listen(3333, '127.0.0.1', () => {
    console.log(`🌐 Servidor Ops Center activo en http://127.0.0.1:3333`);
    if (USE_LOCAL_CLI) {
        console.log(`⏳ [Modo Híbrido] Conectando CLI de Heroku...`);
        const p = process.platform === 'win32';
        readline.createInterface({ input: spawn(p ? 'cmd.exe' : 'heroku', p ? ['/c', 'heroku', 'logs', '--tail', '--app', APP_NAME] : ['logs', '--tail', '--app', APP_NAME]).stdout, terminal: false }).on('line', processStreamLine);
    }
});