'use strict';
// Persistencia en SQLite usando el módulo nativo node:sqlite (Node >= 22.13):
// sin dependencias compiladas, funciona igual en Linux y Windows.
const fs = require('fs');
const path = require('path');

// node:sqlite emite un ExperimentalWarning en cada arranque; lo silenciamos solo a él.
const origEmit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
    const msg = typeof w === 'string' ? w : w && w.message;
    if (msg && /SQLite is an experimental feature/.test(msg)) return;
    return origEmit.call(this, w, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    expected INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    reason TEXT,
    method TEXT, route TEXT, status_code INTEGER,
    func TEXT, code_file TEXT, code_line INTEGER, handler TEXT, handler_dir TEXT,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'open',          -- open | ack | resolved | ignored
    state_changed_at TEXT,
    regression INTEGER NOT NULL DEFAULT 0,
    after_release TEXT,
    spike INTEGER NOT NULL DEFAULT 0,
    user_ids TEXT NOT NULL DEFAULT '[]',
    blame TEXT,
    analysis TEXT,
    analysis_state TEXT NOT NULL DEFAULT 'none', -- none | queued | running | done | skipped | failed
    analysis_error TEXT,
    analyzed_at TEXT,
    patch TEXT,
    patch_branch TEXT,
    alerted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_issues_last_seen ON issues(last_seen);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER REFERENCES issues(id),
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    category TEXT, severity TEXT,
    method TEXT, path TEXT, status_code INTEGER,
    dyno TEXT, request_id TEXT, service_ms INTEGER,
    message TEXT,
    evidence TEXT,
    user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS metrics (
    minute TEXT PRIMARY KEY,
    requests INTEGER NOT NULL DEFAULT 0,
    err4 INTEGER NOT NULL DEFAULT 0,
    err5 INTEGER NOT NULL DEFAULT 0,
    slow INTEGER NOT NULL DEFAULT 0,
    apdex_sat INTEGER NOT NULL DEFAULT 0,
    apdex_tol INTEGER NOT NULL DEFAULT 0,
    latency_sum INTEGER NOT NULL DEFAULT 0,
    latency_n INTEGER NOT NULL DEFAULT 0,
    by_category TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    version TEXT,
    description TEXT,
    UNIQUE(ts, version)
);
`;

class Store {
    constructor(file) {
        if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
        this.db.exec(SCHEMA);
        this.st = {
            issueByFp: this.db.prepare('SELECT * FROM issues WHERE fingerprint = ?'),
            issueById: this.db.prepare('SELECT * FROM issues WHERE id = ?'),
            insertIssue: this.db.prepare(`INSERT INTO issues
                (fingerprint, category, severity, expected, title, reason, method, route, status_code, func, code_file, code_line, handler, handler_dir,
                 first_seen, last_seen, count, user_ids, after_release)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`),
            touchIssue: this.db.prepare(`UPDATE issues SET last_seen = MAX(last_seen, ?), count = count + 1,
                severity = ?, user_ids = ?, state = ?, regression = ?, state_changed_at = COALESCE(?, state_changed_at) WHERE id = ?`),
            insertEvent: this.db.prepare(`INSERT INTO events (issue_id, ts, kind, category, severity, method, path, status_code, dyno, request_id, service_ms, message, evidence, user_id)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
        };
    }

    close() { this.db.close(); }

    getIssue(id) { return hydrate(this.st.issueById.get(id)); }
    getIssueByFingerprint(fp) { return hydrate(this.st.issueByFp.get(fp)); }

    /**
     * Inserta o actualiza la incidencia de una huella y guarda la ocurrencia.
     * @returns {{issue, isNew:boolean, reopened:boolean}}
     */
    recordOccurrence(inc) {
        const existing = this.st.issueByFp.get(inc.fingerprint);
        let issueId, isNew = false, reopened = false;
        if (!existing) {
            const res = this.st.insertIssue.run(
                inc.fingerprint, inc.category, inc.severity, inc.expected ? 1 : 0, inc.title, inc.reason || null,
                inc.method || null, inc.route || null, inc.status || null, inc.func || null, inc.codeFile || null, inc.codeLine || null, inc.handler || null, inc.handlerDir || null,
                inc.ts, inc.ts, JSON.stringify(inc.userId ? [inc.userId] : []), inc.afterRelease || null);
            issueId = Number(res.lastInsertRowid);
            isNew = true;
        } else {
            issueId = existing.id;
            const users = new Set(JSON.parse(existing.user_ids || '[]'));
            if (inc.userId && users.size < 50) users.add(inc.userId);
            // Una incidencia resuelta que vuelve a aparecer se reabre como regresión.
            reopened = existing.state === 'resolved';
            const state = reopened ? 'open' : existing.state;
            this.st.touchIssue.run(inc.ts, maxSev(existing.severity, inc.severity), JSON.stringify([...users]), state,
                reopened ? 1 : existing.regression, reopened ? new Date().toISOString() : null, issueId);
        }
        this.st.insertEvent.run(issueId, inc.ts, inc.kind, inc.category, inc.severity, inc.method || null, inc.path || null,
            inc.status || null, inc.dyno || null, inc.requestId || null, inc.serviceMs ?? null, inc.message || null,
            (inc.evidence || []).join('\n').slice(0, 20000), inc.userId || null);
        return { issue: this.getIssue(issueId), isNew, reopened };
    }

    updateIssue(id, fields) {
        const keys = Object.keys(fields);
        if (!keys.length) return this.getIssue(id);
        const sql = `UPDATE issues SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
        this.db.prepare(sql).run(...keys.map(k => serialize(fields[k])), id);
        return this.getIssue(id);
    }

    listIssues({ state, category, severity, q, since, limit = 300, includeNoise = false } = {}) {
        const where = [], args = [];
        if (state && state !== 'all') {
            if (state === 'active') where.push("state IN ('open','ack')");
            else { where.push('state = ?'); args.push(state); }
        }
        if (category) { where.push('category = ?'); args.push(category); }
        if (severity) { where.push('severity = ?'); args.push(severity); }
        if (!includeNoise && !severity && category !== 'threat') where.push("severity != 'noise'");
        if (since) { where.push('last_seen >= ?'); args.push(since); }
        if (q) {
            where.push('(title LIKE ? OR route LIKE ? OR func LIKE ? OR reason LIKE ? OR analysis LIKE ?)');
            const like = `%${q}%`; args.push(like, like, like, like, like);
        }
        const sql = `SELECT * FROM issues ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY CASE state WHEN 'open' THEN 0 WHEN 'ack' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END, last_seen DESC LIMIT ?`;
        return this.db.prepare(sql).all(...args, limit).map(hydrate);
    }

    issueEvents(issueId, limit = 50) {
        return this.db.prepare('SELECT * FROM events WHERE issue_id = ? ORDER BY ts DESC LIMIT ?').all(issueId, limit);
    }

    issueHistogram(issueId, since, bucketMinutes = 10) {
        const rows = this.db.prepare('SELECT ts FROM events WHERE issue_id = ? AND ts >= ?').all(issueId, since);
        const buckets = {};
        for (const r of rows) {
            const d = new Date(r.ts);
            d.setUTCMinutes(Math.floor(d.getUTCMinutes() / bucketMinutes) * bucketMinutes, 0, 0);
            const k = d.toISOString();
            buckets[k] = (buckets[k] || 0) + 1;
        }
        return buckets;
    }

    recentEvents(limit = 200) {
        return this.db.prepare(`SELECT e.*, i.title AS issue_title FROM events e LEFT JOIN issues i ON i.id = e.issue_id ORDER BY e.id DESC LIMIT ?`).all(limit);
    }

    addMetrics(minute, delta) {
        const row = this.db.prepare('SELECT * FROM metrics WHERE minute = ?').get(minute);
        if (!row) {
            this.db.prepare(`INSERT INTO metrics (minute, requests, err4, err5, slow, apdex_sat, apdex_tol, latency_sum, latency_n, by_category)
                VALUES (?,?,?,?,?,?,?,?,?,?)`).run(minute, delta.requests || 0, delta.err4 || 0, delta.err5 || 0, delta.slow || 0,
                delta.apdex_sat || 0, delta.apdex_tol || 0, delta.latency_sum || 0, delta.latency_n || 0, JSON.stringify(delta.by_category || {}));
            return;
        }
        const cats = JSON.parse(row.by_category || '{}');
        for (const [k, v] of Object.entries(delta.by_category || {})) cats[k] = (cats[k] || 0) + v;
        this.db.prepare(`UPDATE metrics SET requests = requests + ?, err4 = err4 + ?, err5 = err5 + ?, slow = slow + ?,
            apdex_sat = apdex_sat + ?, apdex_tol = apdex_tol + ?, latency_sum = latency_sum + ?, latency_n = latency_n + ?, by_category = ? WHERE minute = ?`)
            .run(delta.requests || 0, delta.err4 || 0, delta.err5 || 0, delta.slow || 0, delta.apdex_sat || 0, delta.apdex_tol || 0,
                delta.latency_sum || 0, delta.latency_n || 0, JSON.stringify(cats), minute);
    }

    metricsSince(since) {
        return this.db.prepare('SELECT * FROM metrics WHERE minute >= ? ORDER BY minute').all(since)
            .map(r => ({ ...r, by_category: JSON.parse(r.by_category || '{}') }));
    }

    addRelease(ts, version, description) {
        this.db.prepare('INSERT OR IGNORE INTO releases (ts, version, description) VALUES (?,?,?)').run(ts, version, description);
    }
    releasesSince(since) { return this.db.prepare('SELECT * FROM releases WHERE ts >= ? ORDER BY ts').all(since); }
    lastRelease() { return this.db.prepare('SELECT * FROM releases ORDER BY ts DESC LIMIT 1').get() || null; }

    latestTs() {
        const r = this.db.prepare('SELECT MAX(minute) AS m FROM metrics').get();
        const e = this.db.prepare('SELECT MAX(ts) AS t FROM events').get();
        return [r && r.m, e && e.t].filter(Boolean).sort().pop() || null;
    }

    counts(since) {
        return this.db.prepare(`SELECT category, severity, state, COUNT(*) AS n, SUM(count) AS occurrences FROM issues WHERE last_seen >= ? GROUP BY category, severity, state`).all(since);
    }

    pendingAnalysis() {
        return this.db.prepare("SELECT id FROM issues WHERE analysis_state IN ('queued','running')").all().map(r => r.id);
    }

    prune(retentionDays) {
        const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
        this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
        this.db.prepare('DELETE FROM metrics WHERE minute < ?').run(cutoff);
        // Máximo 200 ocurrencias guardadas por incidencia: el contador sigue siendo exacto.
        this.db.exec(`DELETE FROM events WHERE id IN (
            SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY issue_id ORDER BY ts DESC) AS rn FROM events) WHERE rn > 200)`);
    }
}

const SEV = ['noise', 'low', 'medium', 'high', 'critical'];
function maxSev(a, b) { return SEV.indexOf(a) >= SEV.indexOf(b) ? a : b; }
function serialize(v) {
    if (v === undefined) return null;
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
}
function hydrate(row) {
    if (!row) return null;
    const out = { ...row };
    for (const k of ['analysis', 'blame', 'user_ids']) {
        if (typeof out[k] === 'string') { try { out[k] = JSON.parse(out[k]); } catch { /* texto plano */ } }
    }
    return out;
}

module.exports = { Store };
