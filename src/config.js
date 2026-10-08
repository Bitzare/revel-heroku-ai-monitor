'use strict';
// Configuración central. Todo sale de variables de entorno (o de un .env en la
// raíz del proyecto) con valores por defecto pensados para Linux y Windows.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Parser mínimo de .env (KEY=VALUE, comillas opcionales, # comentarios) para no
// depender de dotenv. Las variables ya presentes en el entorno tienen prioridad.
function loadDotEnv(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        if (!(key in process.env)) process.env[key] = val;
    }
}

function str(name, def) { const v = process.env[name]; return v === undefined || v === '' ? def : v; }
function num(name, def) { const v = Number(process.env[name]); return Number.isFinite(v) && process.env[name] !== '' ? v : def; }
function bool(name, def) {
    const v = process.env[name];
    if (v === undefined || v === '') return def;
    return /^(1|true|yes|si|sí|on)$/i.test(v);
}
function expandHome(p) { return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p; }

// Busca el backend Go en las rutas habituales de cada sistema si no se indica.
function defaultBackendPath() {
    const candidates = [
        path.join(os.homedir(), 'revel_backend'),
        path.join(os.homedir(), 'GolandProjects', 'revel_backend'),
        path.join(os.homedir(), 'revel-backend'),
    ];
    return candidates.find(p => fs.existsSync(path.join(p, 'go.mod'))) || candidates[0];
}

function load(overrides = {}) {
    loadDotEnv(path.join(ROOT, '.env'));
    const cfg = {
        root: ROOT,
        appName: str('HEROKU_APP', 'revel'),
        host: str('HOST', '127.0.0.1'),
        port: num('PORT', 3333),
        dbFile: path.resolve(ROOT, expandHome(str('DB_FILE', 'data/ops_center.db'))),
        backendPath: path.resolve(expandHome(str('BACKEND_PATH', defaultBackendPath()))),
        apiVersion: str('API_VERSION', '1'),
        adminApiVersion: str('ADMIN_API_VERSION', '1'),

        // Fuentes de logs: lista separada por comas de heroku-api, heroku-cli, none.
        // El drain de Logplex y el webhook de n8n están siempre disponibles por HTTP.
        sources: str('LOG_SOURCES', 'auto').split(',').map(s => s.trim()).filter(Boolean),
        herokuApiToken: str('HEROKU_API_TOKEN', ''),
        herokuBin: str('HEROKU_BIN', 'heroku'),
        ingestToken: str('INGEST_TOKEN', ''),

        // Motor de IA (Ollama)
        ollamaUrl: str('OLLAMA_URL', 'http://127.0.0.1:11434').replace(/\/+$/, ''),
        model: str('OLLAMA_MODEL', 'qwen3.5:9b'),
        numCtx: num('OLLAMA_NUM_CTX', 16384),
        aiTimeoutMs: num('OLLAMA_TIMEOUT_MS', 180000),
        aiEnabled: bool('AI_ENABLED', true),
        // Severidad mínima para gastar una llamada al modelo: noise|low|medium|high|critical
        analyzeMinSeverity: str('ANALYZE_MIN_SEVERITY', 'medium'),
        maxQueue: num('AI_MAX_QUEUE', 200),

        // Parches: off (nada), suggest (diff en la UI), branch (además crea rama sin tocar tu working tree)
        autofixMode: str('AUTOFIX_MODE', 'suggest'),
        autofixMinConfidence: num('AUTOFIX_MIN_CONFIDENCE', 0.7),
        gofmtBin: str('GOFMT_BIN', ''),

        // Alertas salientes hacia n8n (que a su vez avisa a Slack)
        n8nWebhookUrl: str('N8N_WEBHOOK_URL', ''),
        n8nWebhookToken: str('N8N_WEBHOOK_TOKEN', ''),
        alertMinSeverity: str('ALERT_MIN_SEVERITY', 'high'),
        publicUrl: str('PUBLIC_URL', '').replace(/\/+$/, ''),

        // Correlación y retención
        correlationWindowMs: num('CORRELATION_WINDOW_MS', 2500),
        slowRequestMs: num('SLOW_REQUEST_MS', 5000),
        apdexTargetMs: num('APDEX_T_MS', 500),
        retentionDays: num('RETENTION_DAYS', 14),
        ...overrides,
    };
    if (cfg.sources.includes('auto')) {
        cfg.sources = [cfg.herokuApiToken ? 'heroku-api' : 'heroku-cli'];
    }
    return cfg;
}

const SEVERITIES = ['noise', 'low', 'medium', 'high', 'critical'];
const sevRank = s => Math.max(0, SEVERITIES.indexOf(s));

module.exports = { load, SEVERITIES, sevRank, ROOT };
