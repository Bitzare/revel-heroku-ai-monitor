'use strict';
// Convierte una línea cruda (Heroku CLI, Logplex drain, n8n o fichero local del
// backend) en un evento estructurado. No clasifica: solo extrae hechos.

// Colores ANSI del logger ([EndPoint] los usa). También sin el ESC, porque algunos
// intermediarios (n8n, copiar/pegar de la consola) se comen ese carácter y dejan "[32m".
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\[(?:0|[0-9]{1,2}(?:;[0-9]{1,3})*)m(?=\s|$)/g;
// 2026-10-08T14:07:04.410064+00:00 heroku[router]: ...
const HEROKU_PREFIX_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s+([\w.-]+)\[([\w.-]+)\]:\s?(.*)$/;
// RFC5424 de Logplex: <190>1 2026-...+00:00 host app web.1 - mensaje
const SYSLOG_RE = /^<\d+>\d+\s+(\S+)\s+\S+\s+(\S+)\s+(\S+)\s+-\s?(.*)$/;
// Formato del logger estándar de Go: "2026/10/07 12:30:21 mensaje", con prefijo opcional "[EndPoint] "
const GO_LOG_RE = /^(?:\[([\w-]+)\]\s+)?(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\.\d+)?\s?(.*)$/;
const ENDPOINT_RE = /^\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\S+)\s+\((\d{3})\)/;
const FUNC_TAG_RE = /^\[([A-Za-z_][\w.]*)\]\s+(.*)$/;
const CODE_LOC_RE = /(\/?(?:[\w.-]+\/)*[\w.-]+\.go):(\d+)/;
const USER_ID_RE = /\buser_?id[=: ]+(\d+)/i;

function stripAnsi(s) { return s.replace(ANSI_RE, ''); }

function parseKv(text) {
    // at=info method=GET path="/rv1/x" status=200 ...
    const out = {};
    const re = /([\w#.-]+)=("([^"]*)"|\S*)/g;
    let m;
    while ((m = re.exec(text))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
    return out;
}

function msOf(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }

function urlPath(raw) {
    // Acepta URL completa o path; devuelve path sin query.
    let p = raw;
    const scheme = p.indexOf('://');
    if (scheme !== -1) {
        const slash = p.indexOf('/', scheme + 3);
        p = slash === -1 ? '/' : p.slice(slash);
    }
    const q = p.indexOf('?');
    if (q !== -1) p = p.slice(0, q);
    return p || '/';
}

function goLogDate(d, t) { return new Date(`${d.replace(/\//g, '-')}T${t}`).toISOString(); }

/**
 * @returns {null | {
 *   raw, ts, source, dyno, text, kind,
 *   method?, path?, status?, serviceMs?, requestId?, routerCode?, routerDesc?,
 *   func?, message?, codeFile?, codeLine?, userId?, release?
 * }}
 */
function parseLine(rawLine, opts = {}) {
    if (rawLine == null) return null;
    let line = stripAnsi(String(rawLine)).replace(/\r$/, '');
    if (!line.trim()) return null;

    let ts = null, source = 'app', dyno = opts.dyno || 'local', body = line;

    const sys = line.match(SYSLOG_RE);
    if (sys) {
        ts = sys[1]; source = sys[2]; dyno = sys[3]; body = sys[4];
    } else {
        const h = line.match(HEROKU_PREFIX_RE);
        if (h) { ts = h[1]; source = h[2]; dyno = h[3]; body = h[4]; }
    }

    const ev = { raw: line, ts: null, source, dyno, text: body, kind: 'info' };

    if (source === 'heroku' && dyno === 'router') {
        const kv = parseKv(body);
        ev.kind = 'router';
        ev.method = kv.method;
        ev.path = urlPath(kv.path || '/');
        ev.status = msOf(kv.status);
        ev.serviceMs = msOf(kv.service);
        ev.requestId = kv.request_id;
        ev.dyno = kv.dyno || dyno;
        if (kv.at === 'error') { ev.routerCode = kv.code; ev.routerDesc = kv.desc; }
        ev.ts = normTs(ts);
        return ev;
    }

    if (source === 'heroku') {
        // Eventos de plataforma del dyno: crashes, R14, reinicios...
        ev.kind = 'platform';
        const code = body.match(/\b(?:Error\s+)?([HR]\d{2})\b/);
        if (code) ev.routerCode = code[1];
        ev.message = body;
        ev.ts = normTs(ts);
        return ev;
    }

    if (source === 'app' && dyno === 'api') {
        ev.kind = 'release';
        const rel = body.match(/\b(?:Release|Deploy)\s+(v\d+)/i) || body.match(/\b(v\d+)\b/);
        if (/Release v\d+|Deploy \w+/i.test(body)) ev.release = rel ? rel[1] : null;
        else ev.kind = 'info';
        ev.message = body;
        ev.ts = normTs(ts);
        return ev;
    }

    if (source === 'app' && /^heroku-(redis|postgresql)/.test(dyno)) {
        ev.kind = 'metric';
        ev.message = body;
        ev.ts = normTs(ts);
        return ev;
    }

    // Línea de la aplicación Go
    let goTag = null;
    const g = body.match(GO_LOG_RE);
    if (g) {
        goTag = g[1] || null;
        if (!ts) ts = goLogDate(g[2], g[3]);
        body = g[4];
    }
    ev.ts = normTs(ts) || opts.now || new Date().toISOString();
    ev.text = body;

    if (goTag === 'cors') { ev.kind = 'noise'; return ev; }
    if (goTag === 'EndPoint') {
        const e = body.match(ENDPOINT_RE);
        if (e) {
            ev.kind = 'endpoint';
            ev.method = e[1];
            ev.path = urlPath(e[2]);
            ev.status = parseInt(e[3], 10);
            return ev;
        }
    }
    if (/^-{3,}\s*\d{4}-\d{2}-\d{2}\s*-{3,}$/.test(body.trim())) { ev.kind = 'noise'; return ev; }

    ev.kind = 'app';
    let msg = body;
    const ft = msg.match(FUNC_TAG_RE);
    if (ft && goTag !== 'EndPoint') { ev.func = ft[1]; msg = ft[2]; }
    else if (goTag && !['EndPoint', 'Initialization', 'Email'].includes(goTag)) { ev.func = goTag; }
    ev.message = msg.trim();
    const loc = msg.match(CODE_LOC_RE);
    if (loc) { ev.codeFile = loc[1].replace(/^\//, ''); ev.codeLine = parseInt(loc[2], 10); }
    const uid = line.match(USER_ID_RE);
    if (uid) ev.userId = uid[1];
    return ev;
}

function normTs(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Logplex HTTPS drain: el cuerpo son tramas con "octet counting":
 * "<longitud> <mensaje syslog><longitud> <mensaje>...". La longitud es en bytes,
 * así que se trabaja sobre el Buffer, no sobre el string (tildes/emoji rompían el parser anterior).
 */
function parseLogplexFrames(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf), 'utf8');
    const out = [];
    let p = 0;
    while (p < buf.length) {
        while (p < buf.length && (buf[p] === 0x0a || buf[p] === 0x0d || buf[p] === 0x20)) p++;
        const sp = buf.indexOf(0x20, p);
        if (sp === -1) break;
        const len = parseInt(buf.toString('ascii', p, sp), 10);
        if (!Number.isFinite(len) || len <= 0) break;
        out.push(buf.toString('utf8', sp + 1, sp + 1 + len).replace(/\n$/, ''));
        p = sp + 1 + len;
    }
    return out;
}

module.exports = { parseLine, parseLogplexFrames, stripAnsi, urlPath, parseKv };
