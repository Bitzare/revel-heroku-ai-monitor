'use strict';
// Ensambla todas las piezas. Separado de index.js para poder levantar la app
// completa en los tests (con BD en memoria y un Ollama falso).
const fs = require('fs');
const { Store } = require('./store/db');
const { Pipeline } = require('./pipeline/pipeline');
const { CodeIndex } = require('./code/index');
const { loadRoutes } = require('./code/routes');
const { OllamaClient } = require('./ai/ollama');
const { Analyzer } = require('./ai/analyzer');
const { AutoFix } = require('./ai/autofix');
const { N8nNotifier } = require('./notify/n8n');
const { HerokuApiSource, HerokuCliSource, ReplaySource, PassiveSource } = require('./ingest/sources');
const { createServer } = require('./server/http');
const { sevRank } = require('./config');

function createApp(cfg, { log = console, client = null } = {}) {
    const app = { cfg, log, startedAt: new Date().toISOString(), sources: [] };
    app.store = new Store(cfg.dbFile);

    app.code = new CodeIndex(cfg.backendPath).build();
    app.routes = loadRoutes(cfg.backendPath, cfg);
    if (!fs.existsSync(cfg.backendPath)) log.warn(`⚠️  No encuentro el backend en ${cfg.backendPath} (BACKEND_PATH). El análisis irá sin código.`);
    else log.info(`🗺️  Backend: ${app.code.funcs.length} funciones Go, ${app.routes.length} rutas en ${cfg.backendPath}`);

    app.client = client || new OllamaClient({ url: cfg.ollamaUrl, model: cfg.model, numCtx: cfg.numCtx, timeoutMs: cfg.aiTimeoutMs });
    app.autofix = new AutoFix({ code: app.code, client: app.client, cfg });
    app.pipeline = new Pipeline({ store: app.store, routes: app.routes, code: app.code, cfg });
    app.analyzer = new Analyzer({ store: app.store, code: app.code, client: app.client, cfg, autofix: app.autofix });
    app.notifier = new N8nNotifier({ url: cfg.n8nWebhookUrl, token: cfg.n8nWebhookToken, minSeverity: cfg.alertMinSeverity, publicUrl: cfg.publicUrl || `http://${cfg.host}:${cfg.port}`, log });
    app.passive = {
        drain: new PassiveSource('logplex-drain', 'Drain de Logplex'),
        n8n: new PassiveSource('n8n', 'Webhook de n8n'),
        raw: new PassiveSource('raw', 'Ingesta manual'),
    };

    // Incidencia → cola de IA → alerta
    app.pipeline.on('incident', ({ issue, isNew, reopened, spiking }) => {
        if (isNew || reopened || (spiking && issue.analysis_state !== 'done')) app.analyzer.enqueue(issue.id);
        // Las graves se avisan ya; el resto espera al diagnóstico para que la alerta lleve la explicación.
        const urgent = sevRank(issue.severity) >= sevRank('critical') || reopened || spiking;
        if (urgent && app.notifier.shouldAlert(issue, { isNew, reopened, spiking })) {
            app.notifier.send(issue, reopened ? 'regression' : spiking ? 'spike' : 'new').then(ok => ok && app.store.updateIssue(issue.id, { alerted_at: new Date().toISOString() }));
        }
    });
    app.analyzer.on('analyzed', issue => {
        if (issue.analysis_state === 'done' && app.notifier.shouldAlert(issue, { analyzed: true })) {
            app.notifier.send(issue, 'diagnosed').then(ok => ok && app.store.updateIssue(issue.id, { alerted_at: new Date().toISOString() }));
        }
    });

    app.health = () => {
        const sources = [...app.sources.map(s => s.status), ...Object.values(app.passive).map(s => s.status)]
            .filter(s => s.lines > 0 || app.sources.some(x => x.status === s));
        const since5 = new Date(Date.now() - 5 * 60000).toISOString();
        const since15 = new Date(Date.now() - 15 * 60000).toISOString();
        const m = app.store.metricsSince(since5).reduce((a, r) => {
            a.requests += r.requests; a.err5 += r.err5; a.err4 += r.err4; a.sat += r.apdex_sat; a.tol += r.apdex_tol; return a;
        }, { requests: 0, err5: 0, err4: 0, sat: 0, tol: 0 });
        const hot = app.store.listIssues({ state: 'active', since: since15, limit: 50 });
        const crit = hot.filter(i => i.severity === 'critical' && !i.expected).length;
        const high = hot.filter(i => i.severity === 'high' && !i.expected).length;
        const rate5 = m.requests ? m.err5 / m.requests : 0;
        const apdex = m.requests ? (m.sat + m.tol / 2) / m.requests : null;
        const anyLive = sources.some(s => s.state === 'live' && s.lastLine && Date.now() - Date.parse(s.lastLine) < 10 * 60000);
        let status = 'ok';
        if (crit || rate5 > 0.05) status = 'critical';
        else if (high || rate5 > 0.01 || (apdex != null && apdex < 0.85)) status = 'warning';
        else if (!anyLive && !m.requests) status = 'unknown';
        return {
            status, criticalOpen: crit, highOpen: high,
            window: { minutes: 5, requests: m.requests, err5: m.err5, err4: m.err4, errorRate: rate5, apdex },
            sources, pipeline: app.pipeline.stats,
            ai: { enabled: cfg.aiEnabled, model: cfg.model, ...app.client.status, queue: app.analyzer.status() },
            notifier: app.notifier.status(),
            app: cfg.appName, startedAt: app.startedAt, autofixMode: cfg.autofixMode,
        };
    };

    app.startSources = (opts = {}) => {
        const onLine = (l, name) => app.pipeline.ingest(l, name);
        if (opts.replay) {
            app.sources.push(new ReplaySource({ file: opts.replay, onLine, onDone: opts.onReplayDone }).start());
            return;
        }
        for (const s of cfg.sources) {
            if (s === 'heroku-api') {
                if (!cfg.herokuApiToken) { log.warn('⚠️  LOG_SOURCES incluye heroku-api pero falta HEROKU_API_TOKEN'); continue; }
                app.sources.push(new HerokuApiSource({ app: cfg.appName, token: cfg.herokuApiToken, onLine, log }).start());
            } else if (s === 'heroku-cli') {
                app.sources.push(new HerokuCliSource({ app: cfg.appName, bin: cfg.herokuBin, onLine, log }).start());
            } else if (s !== 'none' && s !== 'drain' && s !== 'n8n') {
                log.warn(`⚠️  Fuente desconocida en LOG_SOURCES: ${s}`);
            }
        }
    };

    app.listen = () => new Promise(resolve => {
        app.server = createServer(app);
        app.server.listen(cfg.port, cfg.host, () => resolve(app.server.address()));
    });

    // Tareas periódicas
    app.timers = [
        setInterval(() => { app.pipeline._sweep(false); app.pipeline.flushMetrics(); }, 1000),
        setInterval(() => app.client.health(), 30000),
        setInterval(() => { try { app.store.prune(cfg.retentionDays); } catch (e) { log.warn(`[prune] ${e.message}`); } }, 3600000),
    ];
    app.client.health();

    app.stop = async () => {
        app.timers.forEach(clearInterval);
        app.sources.forEach(s => s.stop());
        app.pipeline.flush();
        if (app.server) await new Promise(r => { app.server.close(() => r()); app.server.closeAllConnections?.(); });
        app.store.close();
    };
    return app;
}

module.exports = { createApp };
