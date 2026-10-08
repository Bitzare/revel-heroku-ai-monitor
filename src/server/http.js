'use strict';
// Servidor HTTP sin dependencias: dashboard estático, API JSON, Server-Sent Events
// para el tiempo real e ingesta (drain de Logplex, webhook de n8n, texto plano).
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { parseLogplexFrames } = require('../pipeline/parse');
const { sevRank, SEVERITIES } = require('../config');
const { CATEGORY_LABELS } = require('../pipeline/classify');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2' };
const RANGES = { '15m': 15, '1h': 60, '6h': 360, '24h': 1440, '7d': 10080, '30d': 43200 };
const MAX_BODY = 8 * 1024 * 1024;

function createServer(app) {
    const { cfg, store, pipeline, analyzer } = app;
    const publicDir = path.join(cfg.root, 'public');
    const clients = new Set();

    // ------------------------------------------------------------- SSE
    function broadcast(type, data) {
        const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of clients) res.write(msg);
    }
    let reqBatch = [];
    pipeline.on('request', r => { reqBatch.push(r); });
    const batchTimer = setInterval(() => {
        if (reqBatch.length) { broadcast('req', reqBatch); reqBatch = []; }
    }, 1000);
    const healthTimer = setInterval(() => { if (clients.size) broadcast('health', app.health()); }, 5000);
    const pingTimer = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);
    pipeline.on('incident', ({ issue, isNew, reopened }) => broadcast('issue', { issue: slimIssue(issue), isNew, reopened }));
    pipeline.on('tail', t => broadcast('tail', t));
    pipeline.on('release', r => broadcast('release', r));
    analyzer.on('state', issue => broadcast('issue', { issue: slimIssue(issue) }));
    analyzer.on('analyzed', issue => broadcast('issue', { issue: slimIssue(issue), analyzed: true }));

    // ------------------------------------------------------------- helpers
    const send = (res, code, body, headers = {}) => {
        const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
        res.writeHead(code, { 'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
        res.end(data);
    };
    const readBody = req => new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('cuerpo demasiado grande')); req.destroy(); } else chunks.push(c); });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
    const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const tokenOk = (req, url) => {
        if (!cfg.ingestToken) return isLoopback(req); // sin token, solo desde esta máquina
        const given = req.headers['x-monitor-token'] || url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const a = Buffer.from(String(given)), b = Buffer.from(cfg.ingestToken);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    };
    // Las acciones del dashboard exigen una cabecera propia: un formulario de otra web no puede enviarla sin preflight CORS.
    const actionOk = req => req.headers['x-aimon'] === '1';

    function sinceFor(url) {
        const r = url.searchParams.get('range') || '1h';
        if (r === 'all') return '0000';
        const anchor = url.searchParams.get('anchor') === 'latest' ? Date.parse(store.latestTs() || new Date().toISOString()) : Date.now();
        return new Date(anchor - (RANGES[r] || 60) * 60000).toISOString();
    }

    // ------------------------------------------------------------- rutas
    async function handle(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const p = url.pathname;

        // Ingesta
        if (req.method === 'POST' && p.startsWith('/api/ingest')) {
            if (!tokenOk(req, url)) return send(res, 401, { error: 'token de ingesta inválido' });
            const body = await readBody(req);
            let lines = [];
            if (p === '/api/ingest' || p === '/api/ingest/logplex') {
                lines = parseLogplexFrames(body);
                app.passive.drain.hit(lines.length);
                for (const l of lines) pipeline.ingest(l, 'logplex-drain');
            } else if (p === '/api/ingest/n8n') {
                lines = extractN8nLines(body);
                app.passive.n8n.hit(lines.length);
                for (const l of lines) pipeline.ingest(l, 'n8n');
            } else if (p === '/api/ingest/raw') {
                lines = body.toString('utf8').split(/\r?\n/).filter(Boolean);
                app.passive.raw.hit(lines.length);
                for (const l of lines) pipeline.ingest(l, 'raw');
            } else return send(res, 404, { error: 'ruta desconocida' });
            return send(res, 200, { ok: true, lines: lines.length });
        }

        if (p === '/api/stream') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
            res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ health: app.health() })}\n\n`);
            clients.add(res);
            req.on('close', () => clients.delete(res));
            return;
        }

        if (req.method === 'GET' && p === '/api/health') return send(res, 200, app.health());
        if (req.method === 'GET' && p === '/api/stats') return send(res, 200, stats(url));
        if (req.method === 'GET' && p === '/api/pulse') return send(res, 200, { requests: pipeline.recentRequests.slice(-4000) });
        if (req.method === 'GET' && p === '/api/tail') return send(res, 200, { tail: pipeline.tail.slice(-200) });
        if (req.method === 'GET' && p === '/api/meta') return send(res, 200, { categories: CATEGORY_LABELS, severities: SEVERITIES, app: cfg.appName, model: cfg.model, autofixMode: cfg.autofixMode });

        if (req.method === 'GET' && p === '/api/issues') {
            const issues = store.listIssues({
                state: url.searchParams.get('state') || 'active',
                category: url.searchParams.get('category') || null,
                severity: url.searchParams.get('severity') || null,
                q: url.searchParams.get('q') || null,
                since: sinceFor(url),
                includeNoise: url.searchParams.get('noise') === '1',
            });
            return send(res, 200, { issues: issues.map(slimIssue) });
        }

        const m = p.match(/^\/api\/issues\/(\d+)(\/(state|analyze))?$/);
        if (m) {
            const id = Number(m[1]);
            const issue = store.getIssue(id);
            if (!issue) return send(res, 404, { error: 'incidencia no encontrada' });
            if (req.method === 'GET' && !m[2]) {
                const since = new Date(Date.now() - 24 * 3600000).toISOString();
                return send(res, 200, { issue, events: store.issueEvents(id, 30), histogram: store.issueHistogram(id, since, 30) });
            }
            if (req.method === 'POST' && m[3] === 'state') {
                if (!actionOk(req)) return send(res, 403, { error: 'falta la cabecera X-AIMON' });
                const { state } = JSON.parse((await readBody(req)).toString() || '{}');
                if (!['open', 'ack', 'resolved', 'ignored'].includes(state)) return send(res, 400, { error: 'estado inválido' });
                const updated = store.updateIssue(id, { state, state_changed_at: new Date().toISOString(), ...(state === 'open' ? {} : { regression: 0 }) });
                broadcast('issue', { issue: slimIssue(updated) });
                return send(res, 200, { issue: updated });
            }
            if (req.method === 'POST' && m[3] === 'analyze') {
                if (!actionOk(req)) return send(res, 403, { error: 'falta la cabecera X-AIMON' });
                if (!cfg.aiEnabled) return send(res, 409, { error: 'La IA está desactivada (AI_ENABLED=false)' });
                analyzer.enqueue(id, { force: true });
                return send(res, 202, { issue: slimIssue(store.getIssue(id)) });
            }
            return send(res, 405, { error: 'método no permitido' });
        }

        if (p.startsWith('/api/')) return send(res, 404, { error: 'ruta desconocida' });

        // Estáticos
        const file = path.normalize(path.join(publicDir, p === '/' ? 'index.html' : p));
        if (!file.startsWith(publicDir)) return send(res, 403, 'prohibido');
        fs.readFile(file, (err, data) => {
            if (err) {
                // SPA: cualquier ruta desconocida sirve el index
                return fs.readFile(path.join(publicDir, 'index.html'), (e2, html) => (e2 ? send(res, 404, 'no encontrado') : send(res, 200, html, { 'Content-Type': MIME['.html'] })));
            }
            send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        });
    }

    function stats(url) {
        const since = sinceFor(url);
        const rows = store.metricsSince(since);
        const sinceMs = since === '0000' ? (rows[0] ? Date.parse(rows[0].minute) : Date.now()) : Date.parse(since);
        const endMs = url.searchParams.get('anchor') === 'latest' ? Date.parse(store.latestTs() || new Date().toISOString()) : Date.now();
        const spanMin = Math.max(1, (endMs - sinceMs) / 60000);
        const bucketMin = [1, 2, 5, 10, 15, 30, 60, 120, 360, 720, 1440].find(b => spanMin / b <= 120) || 1440;
        const buckets = new Map();
        const totals = { requests: 0, err4: 0, err5: 0, slow: 0, apdex_sat: 0, apdex_tol: 0, latency_sum: 0, latency_n: 0, by_category: {} };
        for (const r of rows) {
            const t = Math.floor(Date.parse(r.minute) / (bucketMin * 60000)) * bucketMin * 60000;
            const b = buckets.get(t) || { t: new Date(t).toISOString(), requests: 0, err4: 0, err5: 0, slow: 0, apdex_sat: 0, apdex_tol: 0, latency_sum: 0, latency_n: 0, by_category: {} };
            for (const k of ['requests', 'err4', 'err5', 'slow', 'apdex_sat', 'apdex_tol', 'latency_sum', 'latency_n']) { b[k] += r[k]; totals[k] += r[k]; }
            for (const [c, v] of Object.entries(r.by_category)) { b.by_category[c] = (b.by_category[c] || 0) + v; totals.by_category[c] = (totals.by_category[c] || 0) + v; }
            buckets.set(t, b);
        }
        const apdex = t => (t.requests ? (t.apdex_sat + t.apdex_tol / 2) / t.requests : null);
        return {
            since, bucketMinutes: bucketMin,
            timeline: [...buckets.values()].map(b => ({ ...b, apdex: apdex(b), avgMs: b.latency_n ? Math.round(b.latency_sum / b.latency_n) : null })),
            totals: { ...totals, apdex: apdex(totals), avgMs: totals.latency_n ? Math.round(totals.latency_sum / totals.latency_n) : null },
            releases: store.releasesSince(since),
            issueCounts: store.counts(since),
            latestTs: store.latestTs(),
        };
    }

    const server = http.createServer((req, res) => {
        handle(req, res).catch(e => {
            app.log.error(`[http] ${req.method} ${req.url}: ${e.stack || e.message}`);
            if (!res.headersSent) send(res, 500, { error: e.message });
        });
    });
    server.on('close', () => { clearInterval(batchTimer); clearInterval(healthTimer); clearInterval(pingTimer); for (const c of clients) c.end(); });
    server.broadcast = broadcast;
    return server;
}

// n8n puede mandar: {lines:[...]}, {logs:"texto"}, [{data:"texto"}], [{json:{line}}], o texto plano.
function extractN8nLines(body) {
    const text = body.toString('utf8');
    let data;
    try { data = JSON.parse(text); } catch { return text.split(/\r?\n/).filter(Boolean); }
    const out = [];
    const take = v => {
        if (v == null) return;
        if (typeof v === 'string') { out.push(...v.split(/\r?\n/).filter(Boolean)); return; }
        if (Array.isArray(v)) { v.forEach(take); return; }
        if (typeof v === 'object') {
            for (const k of ['lines', 'logs', 'data', 'body', 'line', 'text', 'message', 'json']) if (k in v) { take(v[k]); return; }
        }
    };
    take(data);
    return out;
}

function slimIssue(i) {
    if (!i) return i;
    const a = i.analysis && typeof i.analysis === 'object' ? i.analysis : null;
    return {
        id: i.id, title: i.title, category: i.category, severity: i.severity, expected: !!i.expected, reason: i.reason,
        method: i.method, route: i.route, status_code: i.status_code, func: i.func, handler: i.handler,
        first_seen: i.first_seen, last_seen: i.last_seen, count: i.count, state: i.state,
        regression: !!i.regression, after_release: i.after_release, spike: !!i.spike,
        users: Array.isArray(i.user_ids) ? i.user_ids.length : 0,
        analysis_state: i.analysis_state, has_patch: !!i.patch,
        ai_title: a ? a.title : null, ai_kind: a ? a.kind : null, ai_confidence: a ? a.confidence : null,
    };
}

module.exports = { createServer, extractN8nLines, slimIssue, sevRank };
