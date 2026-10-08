'use strict';
// Diagnóstico con IA, una vez por incidencia (huella), no por cada ocurrencia.
// El modelo recibe: evidencias reales de los logs, la clasificación determinista,
// el handler exacto según routes*.go, la función de la causa y el blame. Su
// respuesta se valida contra los logs (grounding) antes de mostrarse.
const { EventEmitter } = require('events');
const { sevRank, SEVERITIES } = require('../config');
const { CATEGORY_LABELS } = require('../pipeline/classify');

const KINDS = ['backend_bug', 'client_error', 'expected', 'infrastructure', 'data', 'configuration', 'attack'];

const ANALYSIS_SCHEMA = {
    type: 'object',
    properties: {
        title: { type: 'string', description: 'Título corto en español, máx. 90 caracteres' },
        summary: { type: 'string', description: 'Qué está pasando, 1-2 frases en español' },
        root_cause: { type: 'string', description: 'Causa raíz técnica, citando función/línea si se ve en el código' },
        exact_error: { type: 'string', description: 'Copia literal del mensaje de error de los logs' },
        kind: { type: 'string', enum: KINDS },
        severity: { type: 'string', enum: SEVERITIES },
        location: {
            type: 'object',
            properties: { file: { type: 'string' }, function: { type: 'string' }, line: { type: 'integer' } },
            required: ['file', 'function', 'line'],
        },
        fix: { type: 'string', description: 'Solución concreta en español' },
        fix_steps: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['title', 'summary', 'root_cause', 'exact_error', 'kind', 'severity', 'location', 'fix', 'fix_steps', 'confidence'],
};

const SYSTEM_PROMPT = `Eres un SRE senior de guardia para el backend Go de Revel (API REST con httprouter, MySQL, Redis, Stripe, desplegada en Heroku).
Recibes evidencias de logs de producción y el código fuente relevante. Tu trabajo: explicar el fallo con precisión y proponer la corrección.

Reglas:
- Responde SIEMPRE en español, salvo identificadores de código y mensajes de error.
- "exact_error" debe ser una copia literal de un mensaje que aparezca en las evidencias. Si no hay mensaje de error explícito, copia la línea más relevante.
- No inventes funciones, ficheros ni líneas: usa solo lo que ves en el código que se te da. Si no lo sabes, deja "file" y "function" vacíos y "line" a 0, y baja "confidence".
- Distingue bien: un 401 por token ausente/caducado o un 404 de un recurso inexistente suelen ser "expected" o "client_error", no bugs. Un handler que devuelve un status incorrecto (p.ej. 401 cuando la consulta SQL no encuentra filas) SÍ es "backend_bug".
- "sql: no rows in result set" tratado como error 4xx/5xx suele indicar que falta manejar sql.ErrNoRows.
- Si las evidencias indican caída de infraestructura (redis, timeouts de red, H12, R14) no culpes al código del handler.
- "confidence" refleja cuánto respaldan las evidencias tu diagnóstico (0.9+ solo si el código muestra claramente la causa).`;

class Analyzer extends EventEmitter {
    constructor({ store, code, client, cfg, autofix = null }) {
        super();
        this.store = store; this.code = code; this.client = client; this.cfg = cfg; this.autofix = autofix;
        this.queue = []; this.running = null; this.processed = 0; this.failed = 0;
        // Al arrancar, lo que se quedó a medias en la sesión anterior vuelve a la cola.
        for (const id of store.pendingAnalysis()) this.enqueue(id, { force: true });
    }

    shouldAnalyze(issue) {
        if (!this.cfg.aiEnabled) return false;
        if (issue.category === 'threat' || issue.severity === 'noise') return false;
        if (issue.expected && sevRank(issue.severity) < sevRank('high')) return false;
        return sevRank(issue.severity) >= sevRank(this.cfg.analyzeMinSeverity || 'medium');
    }

    enqueue(issueId, { force = false } = {}) {
        const issue = this.store.getIssue(issueId);
        if (!issue) return false;
        if (!force && !this.shouldAnalyze(issue)) {
            if (issue.analysis_state === 'none') this.store.updateIssue(issueId, { analysis_state: 'skipped' });
            return false;
        }
        if (this.queue.some(q => q.id === issueId) || (this.running && this.running.id === issueId)) return true;
        if (this.queue.length >= (this.cfg.maxQueue || 200)) {
            // Cola llena: sacamos la de menor prioridad para no crecer sin límite.
            this.queue.sort((a, b) => b.prio - a.prio);
            const dropped = this.queue.pop();
            this.store.updateIssue(dropped.id, { analysis_state: 'none' });
        }
        this.queue.push({ id: issueId, prio: sevRank(issue.severity) * 10 + (issue.regression ? 5 : 0) + (force ? 20 : 0) });
        this.store.updateIssue(issueId, { analysis_state: 'queued', analysis_error: null });
        this.emit('state', this.store.getIssue(issueId));
        this._drain();
        return true;
    }

    status() {
        return { queued: this.queue.length, running: this.running ? this.running.id : null, processed: this.processed, failed: this.failed };
    }

    async _drain() {
        if (this.running) return;
        while (this.queue.length) {
            this.queue.sort((a, b) => b.prio - a.prio);
            this.running = this.queue.shift();
            try { await this._analyze(this.running.id); } catch (e) { /* ya registrado */ }
            this.running = null;
        }
    }

    async _analyze(id) {
        let issue = this.store.updateIssue(id, { analysis_state: 'running' });
        this.emit('state', issue);
        try {
            const ctx = this.buildContext(issue);
            if (ctx.blame) this.store.updateIssue(id, { blame: ctx.blame });
            const { data, meta } = await this.client.chatJson(
                [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: ctx.prompt }],
                ANALYSIS_SCHEMA,
            );
            const analysis = this.validate(data, ctx);
            analysis.meta = { ...meta, model: this.client.model, contextChars: ctx.prompt.length };
            issue = this.store.updateIssue(id, { analysis, analysis_state: 'done', analyzed_at: new Date().toISOString(), analysis_error: null });
            this.processed++;
            this.emit('analyzed', issue);
            if (this.autofix && this.autofix.eligible(issue, analysis, ctx)) {
                try {
                    const patch = await this.autofix.run(issue, analysis, ctx);
                    if (patch) { issue = this.store.updateIssue(id, { patch: patch.diff, patch_branch: patch.branch || null }); this.emit('analyzed', issue); }
                } catch (e) {
                    this.store.updateIssue(id, { analysis_error: `Parche descartado: ${e.message}` });
                }
            }
        } catch (e) {
            this.failed++;
            issue = this.store.updateIssue(id, { analysis_state: 'failed', analysis_error: e.message });
            this.emit('analyzed', issue);
            throw e;
        }
    }

    /** Monta el prompt con evidencias y el código relevante, con un presupuesto de caracteres. */
    buildContext(issue) {
        const events = this.store.issueEvents(issue.id, 6);
        const evidence = [];
        const seen = new Set();
        for (const e of events) {
            for (const l of (e.evidence || e.message || '').split('\n')) {
                const k = l.replace(/^\S+\s+/, '');
                if (l && !seen.has(k)) { seen.add(k); evidence.push(l.slice(0, 600)); }
            }
            if (evidence.length > 60) break;
        }

        const code = this.code;
        const blocks = [];
        let target = null;
        if (code) {
            const handlerDir = issue.route ? routeDir(issue) : null;
            const handlerFn = issue.handler ? code.find(issue.handler, handlerDir) : null;
            const causeFn = issue.func && issue.func !== issue.handler ? code.find(issue.func, handlerDir) : null;
            const locFn = issue.code_file ? code.enclosing(issue.code_file, issue.code_line) : null;
            for (const [label, fn] of [['Handler de la ruta', handlerFn], ['Función que registró el error', causeFn], ['Función donde se originó (file:line del error)', locFn]]) {
                if (fn && !blocks.some(b => b.fn.file === fn.file && b.fn.start === fn.start)) blocks.push({ label, fn });
            }
            target = (causeFn || handlerFn || locFn) || null;
            if (!blocks.length && issue.code_file) {
                const snip = code.snippet(issue.code_file, issue.code_line);
                if (snip) blocks.push({ label: 'Fragmento', snippet: snip, file: issue.code_file });
            }
        }

        let budget = Math.max(6000, (this.cfg.numCtx || 16384) * 3 - 6000);
        const parts = [];
        parts.push(`## Incidencia\nTítulo: ${issue.title}\nClasificación automática: ${CATEGORY_LABELS[issue.category] || issue.category} / severidad ${issue.severity}${issue.expected ? ' (parece esperado)' : ''} — ${issue.reason || ''}`);
        if (issue.route) parts.push(`Petición: ${issue.method} ${issue.route} → ${issue.status_code || ''}`);
        parts.push(`Ocurrencias: ${issue.count} (primera ${issue.first_seen}, última ${issue.last_seen})${issue.user_ids?.length ? `; usuarios afectados: ${issue.user_ids.length}` : ''}${issue.after_release ? `; apareció tras el deploy ${issue.after_release}` : ''}${issue.regression ? '; es una REGRESIÓN (estaba resuelta)' : ''}`);
        const evText = evidence.slice(-60).join('\n');
        parts.push(`## Evidencias (logs de producción)\n\`\`\`\n${evText}\n\`\`\``);
        budget -= parts.join('\n').length;

        let blame = null;
        for (const b of blocks) {
            const src = b.snippet || code.source(b.fn);
            const file = b.fn ? b.fn.file : b.file;
            if (src.length > budget) { if (budget > 1500) parts.push(`## ${b.label}: ${file}\n\`\`\`go\n${src.slice(0, budget - 200)}\n\`\`\``); break; }
            parts.push(`## ${b.label}: ${file}${b.fn ? ` (${b.fn.name}, líneas ${b.fn.start}-${b.fn.end})` : ''}\n\`\`\`go\n${src}\n\`\`\``);
            budget -= src.length + 100;
            if (!blame && b.fn) blame = code.blame(b.fn.file, b.fn.start, b.fn.end);
        }
        if (blame) parts.push(`Último cambio relevante en ese código: ${blame.author}, ${blame.date} (${blame.sha} "${blame.summary}")`);
        if (!blocks.length) parts.push('(No se encontró código relacionado: diagnostica solo con las evidencias y baja la confianza.)');
        parts.push('Devuelve el diagnóstico en el JSON pedido.');
        return { prompt: parts.join('\n\n'), evidence, evText, target, blocks, blame };
    }

    /** Comprueba que lo que dice el modelo está respaldado por los logs y el código. */
    validate(raw, ctx) {
        const a = { ...raw };
        a.kind = KINDS.includes(a.kind) ? a.kind : 'backend_bug';
        a.severity = SEVERITIES.includes(a.severity) ? a.severity : 'medium';
        a.confidence = Math.max(0, Math.min(1, Number(a.confidence) || 0));
        a.fix_steps = Array.isArray(a.fix_steps) ? a.fix_steps.filter(s => typeof s === 'string' && s.trim()).slice(0, 5) : [];
        a.flags = [];

        const norm = s => String(s || '').toLowerCase().replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
        const ev = norm(ctx.evText);
        const exact = norm(a.exact_error);
        if (!exact) { a.grounded = false; }
        else if (ev.includes(exact)) { a.grounded = true; }
        else {
            const toks = exact.split(/[^a-z0-9_.]+/).filter(t => t.length > 3);
            const hit = toks.filter(t => ev.includes(t)).length;
            a.grounded = toks.length > 0 && hit / toks.length >= 0.7;
        }
        if (!a.grounded) { a.flags.push('error_no_literal'); a.confidence = Math.min(a.confidence, 0.4); }

        const loc = a.location || {};
        const file = loc.file && this.code ? this.code.resolveFile(loc.file) : null;
        if (loc.file && !file) { a.flags.push('fichero_inventado'); a.confidence = Math.min(a.confidence, 0.35); }
        const fn = loc.function && this.code ? this.code.find(String(loc.function).replace(/^.*\./, ''), file ? file.split('/').slice(0, -1).join('/') : null) : null;
        if (loc.function && !fn) a.flags.push('funcion_no_encontrada');
        a.location = file || fn ? { file: fn ? fn.file : file, function: fn ? fn.name : null, line: Number(loc.line) || (fn ? fn.start : null) } : null;
        if (!a.location && ctx.target) a.location = { file: ctx.target.file, function: ctx.target.name, line: ctx.target.start, inferred: true };
        a.title = String(a.title || '').slice(0, 120);
        return a;
    }
}

// handlers/<pkg> deducido del handler registrado (si lo hay) para desambiguar nombres repetidos.
function routeDir(issue) { return issue.handler_dir || null; }

module.exports = { Analyzer, ANALYSIS_SCHEMA, SYSTEM_PROMPT, KINDS };
