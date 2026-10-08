'use strict';
// Corazón del monitor: recibe líneas crudas de cualquier fuente, las correlaciona
// por dyno/petición, clasifica, agrupa por huella y persiste. Emite eventos para
// la UI (SSE), la cola de IA y las alertas.
//
// Orden real de las líneas en Heroku para una petición fallida:
//   app[web.1]: 2026/10/08 14:16:43 [GetIsFederatedClub] Failed to ...: sql: no rows   ← causa
//   app[web.1]: [EndPoint] 2026/10/08 14:16:43 GET https://.../is-federated (400)        ← fin del handler
//   heroku[router]: at=info method=GET path="/admin/v1/clubs/3/is-federated" status=400 service=37ms
// Así que las causas ya están en el buffer cuando llega la petición, y el router
// llega justo detrás del [EndPoint]: se fusionan en una sola petición.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { parseLine } = require('./parse');
const { classify, looksLikeError, isNoiseMessage, CATEGORY_LABELS, bump } = require('./classify');
const { fingerprint, normalizePath } = require('./fingerprint');
const { matchRoute } = require('../code/routes');
const { sevRank } = require('../config');
const { latBin, mergeHist } = require('../store/db');

const MERGE_WINDOW_MS = 1500;       // endpoint ↔ router de la misma petición
const PANIC_TAIL_MS = 300;          // líneas de stack que siguen a un panic
const SPIKE_WINDOW_MS = 5 * 60000;
const STACK_LINE_RE = /^(goroutine \d+|\s|created by|\/|[\w./-]+\.go:\d+|[\w.]+\(.*\)$|main\.|net\/http\.)/;

class Pipeline extends EventEmitter {
    constructor({ store, routes = [], code = null, cfg = {} }) {
        super();
        this.store = store;
        this.routes = routes;
        this.code = code;
        this.cfg = cfg;
        this.window = cfg.correlationWindowMs || 2500;
        this.pending = new Map();     // clave petición → {req, arrived}
        this.orphans = new Map();     // dyno → [{ev, arrived, consumed}]
        this.panics = new Map();      // dyno → evento panic abierto
        this.seen = new Set();        // dedupe de líneas entre fuentes
        this.seenOrder = [];
        this.spikes = new Map();      // fingerprint → [ms]
        this.logicalNow = 0;          // ms del último timestamp de log visto
        this.stats = { lines: 0, dupes: 0, parsed: 0, requests: 0, incidents: 0, bySource: {} };
        this.metricBuf = new Map();   // minuto → delta (se vuelca cada segundo)
        this.routeBuf = new Map();    // tramo de 10 min + endpoint → delta
        this.tail = [];               // últimas líneas relevantes para la vista en directo
        this.recentRequests = [];     // anillo para la tira de pulso del dashboard
    }

    /** Punto de entrada único para todas las fuentes. */
    ingest(rawLine, sourceName = 'unknown') {
        this.stats.lines++;
        const src = this.stats.bySource[sourceName] || (this.stats.bySource[sourceName] = { lines: 0, last: null });
        src.lines++; src.last = new Date().toISOString();

        const key = crypto.createHash('md5').update(String(rawLine)).digest('base64');
        if (this.seen.has(key)) { this.stats.dupes++; return; }
        this.seen.add(key); this.seenOrder.push(key);
        if (this.seenOrder.length > 50000) this.seen.delete(this.seenOrder.shift());

        const ev = parseLine(rawLine);
        if (!ev) return;
        this.stats.parsed++;
        const tsMs = Date.parse(ev.ts);
        if (tsMs > this.logicalNow) this.logicalNow = tsMs;

        switch (ev.kind) {
            case 'router':
            case 'endpoint':
                this._onRequest(ev, tsMs); break;
            case 'app':
                this._onApp(ev, tsMs); break;
            case 'platform':
                this._pushTail(ev, 'platform');
                if (/crashed|exited with status [1-9]|Error [HR]\d{2}/i.test(ev.message)) this._emitIncident(this._standalone(ev, 'platform'));
                break;
            case 'release':
                if (ev.release) {
                    this.store.addRelease(ev.ts, ev.release, ev.message);
                    this._pushTail(ev, 'release');
                    this.emit('release', { ts: ev.ts, version: ev.release, description: ev.message });
                }
                break;
            default: break;
        }
        this._sweep(false);
    }

    // ---------------------------------------------------------------- peticiones
    _onRequest(ev, tsMs) {
        const k = `${ev.dyno}|${ev.method}|${ev.path}|${ev.status}`;
        const p = this.pending.get(k);
        if (p && Math.abs(tsMs - p.tsMs) <= MERGE_WINDOW_MS && p.kinds.size === 1 && !p.kinds.has(ev.kind)) {
            // Fusiona [EndPoint] + router: el router aporta latencia, request_id y códigos Hxx.
            const r = p.req;
            if (ev.kind === 'router') {
                r.serviceMs = ev.serviceMs; r.requestId = ev.requestId; r.routerCode = ev.routerCode || r.routerCode; r.routerDesc = ev.routerDesc;
            }
            r.evidence.push(ev.raw);
            p.kinds.add(ev.kind);
            this._finalizeRequest(k, p); // ya tenemos las dos mitades
            return;
        }
        if (p) this._finalizeRequest(k, p);
        this.pending.set(k, {
            tsMs, arrived: Date.now(), kinds: new Set([ev.kind]),
            req: { ...ev, kind: 'request', evidence: [ev.raw] },
        });
        // Si la otra mitad nunca llega (local sin router, o router sin [EndPoint] como en un H12)
        // el barrido la finaliza al pasar la ventana.
    }

    _finalizeRequest(k, p) {
        this.pending.delete(k);
        const req = p.req;
        this.stats.requests++;
        const route = matchRoute(this.routes, req.method, req.path);
        req.route = route ? route.pattern : normalizePath(req.path);
        req.handler = route ? route.handler : null;
        req.handlerDir = route ? route.pkgDir : null;

        const failed = (req.status && req.status >= 400) || req.routerCode || (req.serviceMs && req.serviceMs >= (this.cfg.slowRequestMs || 5000));
        const causes = this._takeCauses(req, p.tsMs, !!failed);
        this._metric(req, p.tsMs, failed ? null : 'ok');
        const pulse = { t: p.tsMs, s: req.status || 0, ms: req.serviceMs ?? null, m: req.method, r: req.route, h: req.routerCode || null };
        this.recentRequests.push(pulse);
        if (this.recentRequests.length > 6000) this.recentRequests.splice(0, 1000);
        this.emit('request', pulse);
        if (!failed) return;
        this._pushTail({ ts: req.ts, dyno: req.dyno, text: `${req.method} ${req.path} → ${req.status || ''}${req.routerCode ? ' ' + req.routerCode : ''}${req.serviceMs != null ? ` (${req.serviceMs} ms)` : ''}` }, req.status >= 500 || req.routerCode ? 'error' : 'warn');

        req.causes = causes;
        for (const c of causes) req.evidence.unshift(c.raw);
        const first = causes.find(c => c.func) || causes[0];
        if (first) { req.func = first.func; req.codeFile = first.codeFile; req.codeLine = first.codeLine; req.message = first.message; }
        req.userId = causes.map(c => c.userId).find(Boolean) || null;
        this._emitIncident(req);
    }

    /**
     * Busca en el buffer del dyno las líneas de error que pertenecen a esta petición:
     * dentro de su duración (service ms) y, si es posible, del mismo handler.
     */
    _takeCauses(req, tsMs, failed) {
        const list = this.orphans.get(req.dyno);
        if (!list || !list.length) return [];
        const span = Math.max(req.serviceMs || 0, 0) + 150;
        const lo = tsMs - Math.min(span, this.window * 4), hi = tsMs + 50;
        const cands = list.filter(o => !o.consumed && o.tsMs >= lo && o.tsMs <= hi);
        if (!cands.length) return [];
        let picked;
        const byHandler = req.handler ? cands.filter(o => o.ev.func === req.handler) : [];
        if (byHandler.length) {
            // Las del handler + líneas sin etiqueta pegadas a ellas (p.ej. "not authorized: /handlers/sessions/tokens.go:106 -> ...")
            const times = byHandler.map(o => o.tsMs);
            picked = cands.filter(o => byHandler.includes(o) || (!o.ev.func && times.some(t => Math.abs(t - o.tsMs) <= 5)));
        } else if (failed) {
            // Sin coincidencia de handler: solo las líneas sin etiqueta o de funciones que no son handlers de otra ruta
            // (si la ruta no está en routes*.go no sabemos su handler y aceptamos todas).
            picked = cands.filter(o => !o.ev.func || !req.handler || !this._isOtherHandler(o.ev.func, req.handler));
        } else {
            picked = [];
        }
        for (const o of picked) o.consumed = true;
        return picked.map(o => o.ev);
    }

    _isOtherHandler(func, handler) {
        if (!func || func === handler) return false;
        return this.routes.some(r => r.handler === func);
    }

    // ---------------------------------------------------------------- líneas app
    _onApp(ev, tsMs) {
        // Continuación de un panic abierto en este dyno
        const open = this.panics.get(ev.dyno);
        if (open && tsMs - open.lastMs <= PANIC_TAIL_MS && STACK_LINE_RE.test(ev.text)) {
            open.ev.stack.push(ev.text);
            open.ev.evidence.push(ev.raw);
            open.lastMs = tsMs;
            const loc = ev.text.match(/([\w./-]+\.go):(\d+)/);
            if (loc && !open.ev.codeFile && this.code && this.code.resolveFile(loc[1])) {
                open.ev.codeFile = this.code.resolveFile(loc[1]); open.ev.codeLine = parseInt(loc[2], 10);
            }
            return;
        }
        if (/\bpanic[:(]|http: panic serving|fatal error:/i.test(ev.message)) {
            ev.stack = []; ev.evidence = [ev.raw];
            this.panics.set(ev.dyno, { ev, lastMs: tsMs, arrived: Date.now() });
            this._pushTail(ev, 'error');
            return;
        }
        if (isNoiseMessage(ev.message)) return;
        if (!looksLikeError(ev)) return;
        this._pushTail(ev, 'error');
        if (!this.orphans.has(ev.dyno)) this.orphans.set(ev.dyno, []);
        this.orphans.get(ev.dyno).push({ ev, tsMs, arrived: Date.now(), consumed: false });
    }

    _standalone(ev, kind = 'app') {
        const inc = { ...ev, kind, evidence: ev.evidence || [ev.raw], causes: [] };
        if (ev.stack && ev.stack.length) inc.message = `${ev.message}\n${ev.stack.slice(0, 40).join('\n')}`;
        return inc;
    }

    /**
     * Finaliza lo que ya no puede recibir más datos. Usa el tiempo de los logs
     * (para que un replay de un fichero dé el mismo resultado que en vivo) y, como
     * respaldo cuando no llegan líneas, el reloj real.
     */
    _sweep(force) {
        const now = Date.now();
        const expired = (tsMs, arrived, ms) => force || this.logicalNow - tsMs > ms || now - arrived > ms + 1000;

        for (const [k, p] of this.pending) if (expired(p.tsMs, p.arrived, MERGE_WINDOW_MS)) this._finalizeRequest(k, p);

        for (const [dyno, pnc] of this.panics) {
            if (expired(pnc.lastMs, pnc.arrived, PANIC_TAIL_MS)) {
                this.panics.delete(dyno);
                const fn = pnc.ev.codeFile && this.code ? this.code.enclosing(pnc.ev.codeFile, pnc.ev.codeLine) : null;
                if (fn) pnc.ev.func = pnc.ev.func || fn.name;
                this._emitIncident(this._standalone(pnc.ev, 'panic'));
            }
        }

        for (const [dyno, list] of this.orphans) {
            const keep = [];
            for (const o of list) {
                if (o.consumed) continue;
                if (expired(o.tsMs, o.arrived, this.window)) this._emitIncident(this._standalone(o.ev, 'app'));
                else keep.push(o);
            }
            if (keep.length) this.orphans.set(dyno, keep); else this.orphans.delete(dyno);
        }
    }

    flush() { this._sweep(true); this.flushMetrics(); }

    // ---------------------------------------------------------------- incidencias
    _emitIncident(inc) {
        if (!inc.func && inc.codeFile && this.code) {
            const fn = this.code.enclosing(inc.codeFile, inc.codeLine);
            if (fn) { inc.func = fn.name; inc.funcInferred = inc.kind !== 'panic'; }
        }
        const cls = classify(inc, this.cfg);
        Object.assign(inc, cls);
        inc.title = buildTitle(inc);
        inc.fingerprint = fingerprint(inc);
        const tsMs = Date.parse(inc.ts) || Date.now();

        // Picos: muchas ocurrencias de la misma huella en 5 minutos sube la severidad un nivel.
        const arr = (this.spikes.get(inc.fingerprint) || []).filter(t => tsMs - t < SPIKE_WINDOW_MS);
        arr.push(tsMs); this.spikes.set(inc.fingerprint, arr);
        const spiking = arr.length >= 10 && !inc.expected && inc.severity !== 'noise';
        if (spiking) inc.severity = bump(inc.severity);

        const last = this.store.lastRelease();
        if (last && tsMs - Date.parse(last.ts) < 30 * 60000 && tsMs >= Date.parse(last.ts)) inc.afterRelease = last.version;

        if (inc.kind !== 'request') this._metric(inc, tsMs, 'bg');
        else this._metricCategory(inc, tsMs);

        const { issue, isNew, reopened } = this.store.recordOccurrence(inc);
        if (spiking && !issue.spike) this.store.updateIssue(issue.id, { spike: 1 });
        this.stats.incidents++;
        const payload = { issue: this.store.getIssue(issue.id), isNew, reopened, spiking, incident: slim(inc) };
        this.emit('incident', payload);
    }

    // ---------------------------------------------------------------- métricas
    _metric(req, tsMs, mode) {
        const minute = new Date(Math.floor(tsMs / 60000) * 60000).toISOString();
        const d = this.metricBuf.get(minute) || { requests: 0, err4: 0, err5: 0, slow: 0, apdex_sat: 0, apdex_tol: 0, latency_sum: 0, latency_n: 0, by_category: {}, lat_hist: [] };
        this.metricBuf.set(minute, d);
        if (mode === 'bg') return;
        const is5 = req.status >= 500 || !!req.routerCode, is4 = !is5 && req.status >= 400;
        const slow = req.serviceMs != null && req.serviceMs >= (this.cfg.slowRequestMs || 5000);
        d.requests++;
        if (is5) d.err5++; else if (is4) d.err4++;
        if (req.serviceMs != null) {
            d.latency_sum += req.serviceMs; d.latency_n++;
            d.lat_hist = mergeHist(d.lat_hist, oneHot(req.serviceMs));
            const t = this.cfg.apdexTargetMs || 500;
            if (!is5) { if (req.serviceMs <= t) d.apdex_sat++; else if (req.serviceMs <= 4 * t) d.apdex_tol++; }
            if (slow) d.slow++;
        } else if (!is5) {
            d.apdex_sat++; // sin latencia (logs locales): cuenta como satisfecha
        }
        // Sondeos de bots fuera de la API no ensucian la tabla de endpoints.
        if (!req.route || (!req.handler && !/^\/(r?v\d+|admin)\//.test(req.path || ''))) return;
        const bucket = new Date(Math.floor(tsMs / 600000) * 600000).toISOString();
        const k = `${bucket}|${req.method}|${req.route}`;
        const r = this.routeBuf.get(k) || { bucket, method: req.method, route: req.route, handler: req.handler, requests: 0, err4: 0, err5: 0, slow: 0, latency_sum: 0, latency_n: 0, lat_hist: [] };
        r.requests++;
        if (is5) r.err5++; else if (is4) r.err4++;
        if (slow) r.slow++;
        if (req.serviceMs != null) { r.latency_sum += req.serviceMs; r.latency_n++; r.lat_hist = mergeHist(r.lat_hist, oneHot(req.serviceMs)); }
        this.routeBuf.set(k, r);
    }

    _metricCategory(inc, tsMs) {
        const minute = new Date(Math.floor(tsMs / 60000) * 60000).toISOString();
        const d = this.metricBuf.get(minute);
        if (d) d.by_category[inc.category] = (d.by_category[inc.category] || 0) + 1;
    }

    flushMetrics() {
        if (!this.metricBuf.size && !this.routeBuf.size) return;
        for (const [minute, d] of this.metricBuf) this.store.addMetrics(minute, d);
        for (const r of this.routeBuf.values()) this.store.addRouteMetrics(r.bucket, r.method, r.route, r.handler, r);
        this.metricBuf.clear();
        this.routeBuf.clear();
        this.emit('metrics');
    }

    _pushTail(ev, level) {
        this.tail.push({ ts: ev.ts, level, dyno: ev.dyno, text: (ev.text || ev.message || '').slice(0, 400) });
        if (this.tail.length > 300) this.tail.shift();
        this.emit('tail', this.tail[this.tail.length - 1]);
    }

}

function oneHot(ms) { const h = []; h[latBin(ms)] = 1; return h; }

function buildTitle(inc) {
    const label = CATEGORY_LABELS[inc.category] || inc.category;
    if (inc.category === 'threat') return 'Sondeos automáticos de bots (rutas tipo .env, wp-admin, /blog...)';
    if (inc.kind === 'request') {
        const what = inc.func ? `${inc.func}: ${shortMsg(inc.message)}` : inc.reason;
        return `${inc.method} ${inc.route} → ${inc.status || inc.routerCode}${what ? ` · ${what}` : ''}`.slice(0, 220);
    }
    if (inc.kind === 'panic') return `Panic${inc.func ? ` en ${inc.func}` : ''}: ${shortMsg(inc.message)}`.slice(0, 220);
    if (inc.kind === 'platform') return `${inc.reason || label}: ${shortMsg(inc.message)}`.slice(0, 220);
    return `${inc.func && !inc.funcInferred ? `${inc.func}: ` : ''}${shortMsg(inc.message) || label}`.slice(0, 220);
}

function shortMsg(m) {
    if (!m) return '';
    return String(m).split('\n')[0].replace(/^Failed to /i, '').replace(/\s+/g, ' ').slice(0, 140);
}

function slim(inc) {
    const { raw, text, causes, evidence, stack, ...rest } = inc;
    return { ...rest, evidence: (evidence || []).slice(-12) };
}

module.exports = { Pipeline, buildTitle, sevRank };
