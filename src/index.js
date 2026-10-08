#!/usr/bin/env node
'use strict';
// Uso:
//   node src/index.js                     # monitor en vivo (fuentes de LOG_SOURCES)
//   node src/index.js --replay fichero    # reproduce un fichero de logs y deja el dashboard abierto
//   node src/index.js --replay f --exit   # reproduce, espera a la IA y sale (útil en CI / pruebas)
//   node src/index.js --no-ai             # sin Ollama
const config = require('./config');
const { createApp } = require('./app');

function parseArgs(argv) {
    const o = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--replay') o.replay = argv[++i];
        else if (a === '--exit') o.exit = true;
        else if (a === '--no-ai') o.noAi = true;
        else if (a === '--port') o.port = Number(argv[++i]);
        else if (a === '--db') o.db = argv[++i];
        else if (a === '-h' || a === '--help') o.help = true;
    }
    return o;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log('node src/index.js [--replay fichero [--exit]] [--no-ai] [--port 3333] [--db ruta.db]\nConfiguración en .env (ver .env.example).');
        return;
    }
    const overrides = {};
    if (args.noAi) overrides.aiEnabled = false;
    if (args.port) overrides.port = args.port;
    if (args.db) overrides.dbFile = require('path').resolve(args.db);
    const cfg = config.load(overrides);
    const log = { info: console.log, warn: console.warn, error: console.error };

    const nonLocal = !['127.0.0.1', 'localhost', '::1'].includes(cfg.host);
    if (nonLocal && !cfg.ingestToken) log.warn('⚠️  HOST no es local y no hay INGEST_TOKEN: la ingesta solo aceptará peticiones desde esta máquina.');

    const app = createApp(cfg, { log });
    const addr = await app.listen();
    log.info(`🌐 Dashboard: http://${addr.address}:${addr.port}`);
    log.info(`📥 Ingesta: POST /api/ingest (drain Logplex) · /api/ingest/n8n · /api/ingest/raw${cfg.ingestToken ? ' (con token)' : ' (solo local)'}`);
    log.info(`🤖 IA: ${cfg.aiEnabled ? `${cfg.model} en ${cfg.ollamaUrl}` : 'desactivada'} · parches: ${cfg.autofixMode}`);

    app.startSources({
        replay: args.replay,
        onReplayDone: async () => {
            app.pipeline.flush();
            const h = app.health();
            log.info(`✅ Replay terminado: ${h.pipeline.lines} líneas, ${h.pipeline.requests} peticiones, ${h.pipeline.incidents} ocurrencias.`);
            if (args.exit) {
                const wait = () => { const q = app.analyzer.status(); return q.queued === 0 && q.running === null; };
                while (!wait()) await new Promise(r => setTimeout(r, 1000));
                await app.stop();
                process.exit(0);
            }
        },
    });
    if (!args.replay) log.info(`📡 Fuentes: ${cfg.sources.join(', ')}`);

    const shutdown = async () => { log.info('\n👋 Cerrando...'); await app.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(e => { console.error(e); process.exit(1); });
