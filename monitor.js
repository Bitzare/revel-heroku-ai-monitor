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

// 🚀 MOTOR: Qwen 2.5 Coder 7B 
const MODEL_NAME = 'qwen2.5-coder:7b';

// Directorio del Backend Go
const BACKEND_PATH = 'C:\\Users\\Rushu\\GolandProjects\\revel_backend';

// Si usas el Log Drain de Heroku + Ngrok, puedes poner esto en 'false'
const USE_LOCAL_CLI = true; 

// ==========================================
// DB SQLITE & MIGRACIONES
// ==========================================
const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT, status TEXT, method TEXT, url TEXT,
        error_real TEXT, suggested_fix TEXT, razonamiento TEXT,
        confidence TEXT, is_anomaly INTEGER, git_blame TEXT, correlation TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS checklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT, endpoint TEXT, count INTEGER,
        priority TEXT, confidence TEXT, action TEXT, impact TEXT
    )`);
});

// ==========================================
// 🧠 CAPA 2: RAG DE ALTA PRECISIÓN (SNIPER)
// ==========================================
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
    } catch (e) {}
}

function getUniversalRAG(targetPath, errorText, httpMethod) {
    const cleanPathUrl = targetPath.split('?')[0].replace(/\/\d+/g, '').replace(/\/[a-f0-9-]{36}/g, '');
    const pathTokens = cleanPathUrl.toLowerCase().split(/[/-]/).filter(t => t.length > 2 && !['admin', 'api', 'v1', 'v2', 'rv1'].includes(t));
    const errorTokens = errorText.toLowerCase().split(/\W+/).filter(t => t.length > 3 && t !== 'nil'); // 'nil' ignorado como ruido
    
    const scored = globalCodeIndex.map(fn => {
        let score = 0;
        const funcNameLower = fn.name.toLowerCase();
        const codeLower = fn.lines.join('\n').toLowerCase();
        const fileLower = fn.file.toLowerCase();
        
        // Evitar que mutemos main.go por un error de API si hay más opciones
        if (fileLower.includes('main.go')) score -= 20;

        if (httpMethod === 'GET' && (funcNameLower.includes('post') || funcNameLower.includes('create') || fileLower.includes('post_'))) score -= 100;
        if (httpMethod === 'POST' && (funcNameLower.includes('get') || funcNameLower.includes('fetch') || fileLower.includes('get_'))) score -= 100;
        
        if (fileLower.includes(`${httpMethod.toLowerCase()}_`)) score += 30;

        const lastToken = pathTokens[pathTokens.length - 1];
        if (lastToken) {
            if (funcNameLower.includes(lastToken)) score += 60;
            if (fileLower.includes(lastToken)) score += 40;
        }

        pathTokens.forEach(pt => { 
            if (funcNameLower.includes(pt)) score += 10; 
            if (fileLower.includes(pt)) score += 5;
        });

        errorTokens.forEach(et => { if (codeLower.includes(et)) score += 5; });
        
        return { ...fn, score };
    }).filter(fn => fn.score > 0).sort((a, b) => b.score - a.score);

    const topFunctions = scored.slice(0, 2); 
    if (topFunctions.length === 0) return { context: "", blame: null, targetFile: null };

    let context = "";
    let bestBlame = null;
    
    for (const f of topFunctions) {
        const cleanPath = f.file.replace(BACKEND_PATH, '').replace(/^[\\/]+/, '').replace(/\\/g, '/');
        context += `// ARCHIVO: ${cleanPath} (Líneas ${f.start}-${f.end})\n${f.lines.join('\n')}\n\n`;
        if (!bestBlame) bestBlame = executeGitBlame(f.file, f.start, f.end);
    }
    
    // 🚀 MEJORA CRÍTICA: Retornamos las coordenadas exactas del objetivo real número 1
    return { 
        context, 
        blame: bestBlame,
        targetFile: topFunctions[0].file,
        targetStart: topFunctions[0].start,
        targetEnd: topFunctions[0].end
    };
}

function executeGitBlame(filePath, startLine, endLine) {
    try {
        const cwd = path.dirname(filePath);
        const rawBlame = execSync(`git blame -L ${startLine},${endLine} --porcelain "${path.basename(filePath)}"`, { cwd, stdio: 'pipe' }).toString();
        const authorMatch = rawBlame.match(/^author (.+)$/m);
        const timeMatch = rawBlame.match(/^author-time (\d+)$/m);
        if (authorMatch && timeMatch) {
            const date = new Date(parseInt(timeMatch[1]) * 1000).toISOString().split('T')[0];
            return `${authorMatch[1]} (${date})`;
        }
    } catch (e) {}
    return null;
}

console.log(`⏳ Indexando código base en: ${BACKEND_PATH}`);
buildUniversalIndex(BACKEND_PATH);
console.log(`🗺️  RAG Universal listo: ${globalCodeIndex.length} funciones Go indexadas.`);

// ==========================================
// ESTADO INTERNO & ANOMALÍAS
// ==========================================
let timeBuckets = {};
const activeRequestsCache = new Map();
const CACHE_TTL_MS = 10000;
let recentCriticalErrors = [];
const CASCADING_WINDOW_MS = 15000;
let errorBaseline = {}; let currentWindowErrors = {}; let lastWindowReset = Date.now();

function loadBaseline() { try { if (fs.existsSync(BASELINE_FILE)) errorBaseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch { errorBaseline = {}; } }
function saveBaseline() { fs.writeFileSync(BASELINE_FILE, JSON.stringify(errorBaseline, null, 2), 'utf8'); }

function checkAnomaly(endpoint) {
    const now = Date.now();
    if (now - lastWindowReset > 60000) {
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
        saveBaseline(); currentWindowErrors = {}; lastWindowReset = now;
    }
    currentWindowErrors[endpoint] = (currentWindowErrors[endpoint] || 0) + 1;
    const b = errorBaseline[`${endpoint}_${new Date().getHours()}`];
    return b && b.samples >= 3 && currentWindowErrors[endpoint] >= b.avgRate * 2.0 && currentWindowErrors[endpoint] >= 3;
}

// ==========================================
// WAF Y PARSEO DE LOGS
// ==========================================
const TRIGGER_REGEX = /(status=(4\d\d|5\d\d)|\((4\d\d|5\d\d)\)|panic|Error \d+|duplicate entry|runtime error|mysql|sql:|invalid syntax|detached)/i;
const THREAT_NOISE = ['.env', '.git', '.bak', '.php', 'wp-admin', 'wp-includes', 'wp-content', '.yaml', '.sql', '.yml', '.config', '.local', '.aws', '.kube', '.npmrc', 'credentials', 'debug.log'];

function processStreamLine(line) {
    if (!line.trim() || /sql:.*(?:ping|pool|acquire)/i.test(line)) return;
    const timeSec = line.match(/(?:T|\s)(\d{2}:\d{2}:\d{2})/)?.[1];
    if (!timeSec) return;

    if (!timeBuckets[timeSec]) timeBuckets[timeSec] = { lines: [], timer: null, failedReqs: new Map() };
    timeBuckets[timeSec].lines.push(line);

    if (TRIGGER_REGEX.test(line)) {
        const p = line.match(/path="([^"\s?]+)"/i) || line.match(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?]+)/i);
        const m = line.match(/\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/i);
        const st = line.match(/(?:status=| \()([2-5]\d{2})(?:\)| )/i);
        const url = p?.[1] || p?.[2];
        
        if (url && !url.startsWith('/06/') && !THREAT_NOISE.some(ext => url.toLowerCase().includes(ext))) {
            if (!timeBuckets[timeSec].failedReqs.has(url)) {
                timeBuckets[timeSec].failedReqs.set(url, { path: url, method: m?.[1] || 'GET', status: st?.[1] || '400', ts: line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)?.[0] || new Date().toISOString() });
            }
        } else if (url && THREAT_NOISE.some(ext => url.toLowerCase().includes(ext))) {
            saveErrorLog({ timestamp: new Date().toISOString(), status: st?.[1] || '404', method: m?.[1] || 'GET', url, error_real: '⚠️ THREAT SCAN / BOT', suggested_fix: 'Bloquear IP.', razonamiento: 'Detección WAF.', confidence: 'HIGH', is_anomaly: false });
        }
    }

    if (timeBuckets[timeSec].timer) clearTimeout(timeBuckets[timeSec].timer);
    timeBuckets[timeSec].timer = setTimeout(() => {
        const bucket = timeBuckets[timeSec]; delete timeBuckets[timeSec];
        if (bucket.failedReqs.size === 0) return;

        const logs = bucket.lines.join('\n');
        for (const [targetPath, reqData] of bucket.failedReqs.entries()) {
            const sig = `${targetPath}_${timeSec}`;
            if (activeRequestsCache.has(sig)) continue;
            activeRequestsCache.set(sig, Date.now() + CACHE_TTL_MS);

            if (reqData.status.startsWith('5')) recentCriticalErrors.push({ ts: Date.now(), path: targetPath, status: reqData.status });
            recentCriticalErrors = recentCriticalErrors.filter(e => Date.now() - e.ts < CASCADING_WINDOW_MS);
            const cascade = !reqData.status.startsWith('5') ? recentCriticalErrors.find(e => e.path !== targetPath) : null;
            const correlationText = cascade ? `⚠️ Cascada tras caída ${cascade.status} en ${cascade.path}` : null;

            analysisQueue.push({ logs, targetPath, reqData, isAnomaly: checkAnomaly(targetPath), correlationText });
            if (!isProcessingQueue) drainQueue();
        }
    }, 600);
}

// ==========================================
// COLA Y AGENTE IA
// ==========================================
let analysisQueue = []; let isProcessingQueue = false;
async function drainQueue() {
    if (isProcessingQueue || analysisQueue.length === 0) return;
    isProcessingQueue = true;
    while (analysisQueue.length > 0) {
        const job = analysisQueue.shift();
        await analyzeWithOllamaAgentic(job.logs, job.targetPath, job.reqData, job.isAnomaly, job.correlationText);
    }
    isProcessingQueue = false;
}

async function analyzeWithOllamaAgentic(logs, targetPath, reqData, isAnomaly, correlation) {
    console.log(`\n🤖 [Fase 1] Analizando: ${reqData.method} ${targetPath}`);
    const ragData = getUniversalRAG(targetPath, logs, reqData.method);
    
    let prompt = `You are a Senior SRE. LOGS:\n${logs}\n`;
    if (ragData.context) prompt += `SOURCE CODE:\n${ragData.context}\n`;
    if (correlation) prompt += `CONTEXT: ${correlation}\n`;
    prompt += `TASK: Analyze failed [${reqData.method} ${targetPath}]. Identify exact raw error. Explain in Spanish. No JSON.`;

    try {
        const res1 = await fetch(OLLAMA_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL_NAME, prompt, stream: false, options: { temperature: 0.0, num_ctx: 8192 } }) });
        const reflection = (await res1.json()).response || '';

        const extractPrompt = `Convert to strict JSON:\n${reflection}\nRULES: "error_real" must be EXACT COPY of error. JSON SCHEMA: {"razonamiento": "...", "error_real": "...", "suggested_fix": "..."}`;
        const res2 = await fetch(OLLAMA_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL_NAME, prompt: extractPrompt, stream: false, options: { temperature: 0.0, num_ctx: 8192 }, format: 'json' }) });
        const result = JSON.parse((await res2.json()).response || '{}');
        
        // Si el RAG apuntó a main.go pero el error habla de otra ruta, bajamos confianza para proteger el código
        let finalConfidence = (result.error_real && result.error_real.length > 5) ? 'HIGH' : 'LOW';
        if (ragData.targetFile && ragData.targetFile.includes('main.go') && targetPath !== '/') {
            finalConfidence = 'LOW'; 
        }

        saveErrorLog({ timestamp: reqData.ts, status: reqData.status, method: reqData.method, url: targetPath, error_real: result.error_real, razonamiento: result.razonamiento, suggested_fix: result.suggested_fix, confidence: finalConfidence, is_anomaly: isAnomaly, git_blame: ragData.blame, correlation: correlation });

        // 🚀 CAPA 3: Solo dispara si la confianza es alta y el targetFile es válido y NO es main.go por accidente
        if (finalConfidence === 'HIGH' && ragData.targetFile) {
            await triggerAutoFix(result, ragData);
        }
    } catch (e) { console.error("❌ Error en Agente IA o JSON inválido."); }
}

// ==========================================
// 🚀 CAPA 3: AUTO-FIX (100% DETERMINISTA)
// ==========================================
async function triggerAutoFix(logData, ragData) {
    if (!ragData || !ragData.targetFile) return;

    // 🎯 ADIÓS REGEX: Usamos las coordenadas guardadas directamente por Node de forma segura
    const absoluteFilePath = ragData.targetFile;
    const relativeFilePath = absoluteFilePath.replace(BACKEND_PATH, '').replace(/^[\\/]+/, '').replace(/\\/g, '/');
    const startLine = ragData.targetStart - 1;
    const endLine = ragData.targetEnd;
    
    console.log(`\n🛠️  [Auto-Fix] Aplicando parche determinista en: ${relativeFilePath}`);

    const prompt = `expert Go rewrite of the function. REASON: ${logData.razonamiento}. SUGGESTED REWRITE: ${logData.suggested_fix}. Here is the exact function code to modify:\n${ragData.context}\nReturn ONLY the valid raw Go code function block, no markdown formatting, no backticks, no text.`;
    try {
        const res = await fetch(OLLAMA_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL_NAME, prompt, stream: false, options: { temperature: 0.0, num_ctx: 8192 } }) });
        let newCode = (await res.json()).response.replace(/```go\n?|```/g, '').trim();

        if (newCode.startsWith('func ')) {
            const lines = fs.readFileSync(absoluteFilePath, 'utf8').split('\n');
            lines.splice(startLine, endLine - startLine, newCode);
            
            const branch = `ai-fix-${Date.now()}`;
            const current = execSync('git branch --show-current', { cwd: BACKEND_PATH }).toString().trim();
            
            execSync(`git checkout -b ${branch}`, { cwd: BACKEND_PATH });
            fs.writeFileSync(absoluteFilePath, lines.join('\n'), 'utf8');
            execSync(`git add "${relativeFilePath}"`, { cwd: BACKEND_PATH });
            execSync(`git commit -m "fix(ai): automatic patch for ${logData.error_real.substring(0,20)}"`, { cwd: BACKEND_PATH });
            execSync(`git checkout ${current}`, { cwd: BACKEND_PATH });
            console.log(`  ✅ [Auto-Fix] Rama local '${branch}' generada perfectamente sin tocar main.go.`);
        } else {
            console.warn('  ⚠️ [Auto-Fix] La IA devolvió un bloque de código sucio. Abortando escritura por seguridad.');
        }
    } catch (e) { console.error(`  ❌ [Auto-Fix] Falló Git: ${e.message}`); }
}

// ==========================================
// SERVIDOR Y DASHBOARD
// ==========================================
function saveErrorLog(res) {
    db.run(`INSERT INTO logs (timestamp, status, method, url, error_real, suggested_fix, razonamiento, confidence, is_anomaly, git_blame, correlation) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [res.timestamp, res.status, res.method, res.url, res.error_real, res.suggested_fix, res.razonamiento, res.confidence, res.is_anomaly?1:0, res.git_blame, res.correlation], function(err) {
        if(!err) io.emit('new_log', { ...res, id: this.lastID });
        triggerChecklist();
    });
}

function triggerChecklist() {
    db.all(`SELECT url, error_real as error, suggested_fix as fix, MAX(git_blame) as gitBlame, COUNT(*) as count FROM logs WHERE error_real NOT LIKE '%THREAT%' GROUP BY url, substr(error_real,1,50) ORDER BY count DESC LIMIT 10`, [], async (err, rows) => {
        if (err || rows.length === 0) return;
        const prompt = `SRE Manager. Create JSON checklist for: ${JSON.stringify(rows)}. SCHEMA: {"tasks": [{"title": "...", "endpoint": "...", "count": 5, "priority": "Alta", "action": "..."}]}`;
        try {
            const res = await fetch(OLLAMA_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL_NAME, prompt, stream: false, format: 'json', options: { num_ctx: 8192 } }) });
            const tasks = JSON.parse((await res.json()).response || '{"tasks":[]}').tasks;
            db.run("DELETE FROM checklist");
            const stmt = db.prepare("INSERT INTO checklist (title, endpoint, count, priority, action) VALUES (?,?,?,?,?)");
            tasks.forEach(t => stmt.run(t.title, t.endpoint, t.count, t.priority, t.action));
            io.emit('update_checklist', tasks);
        } catch(e){}
    });
}

const server = http.createServer((req, res) => {
    if (req.url === '/api/ingest' && req.method === 'POST') {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => {
            let p = 0; while(p < b.length) {
                let s = b.indexOf(' ', p); if(s===-1) break;
                let l = parseInt(b.substring(p,s),10); 
                processStreamLine(b.substring(s+1, s+1+l)); p = s+1+l;
            }
            res.end('OK');
        });
    } else if (req.url === '/') {
        fs.readFile('dashboard.html', (e, d) => { res.writeHead(200, {'Content-Type': 'text/html'}); res.end(d); });
    } else { res.writeHead(404); res.end(); }
});

const io = new Server(server, { cors: { origin: "*" } });
io.on('connection', (s) => {
    db.all("SELECT * FROM logs ORDER BY id DESC LIMIT 100", (e, r) => s.emit('initial_logs', r));
    db.all("SELECT * FROM checklist", (e, r) => s.emit('update_checklist', r));
});

loadBaseline();
server.listen(3333, '127.0.0.1', () => {
    console.log(`🌐 Dashboard: http://127.0.0.1:3333 | Drain: /api/ingest`);
    if (USE_LOCAL_CLI) {
        const p = process.platform === 'win32';
        readline.createInterface({ input: spawn(p?'cmd.exe':'heroku', p?['/c','heroku','logs','--tail','--app',APP_NAME]:['logs','--tail','--app',APP_NAME]).stdout }).on('line', processStreamLine);
    }
});