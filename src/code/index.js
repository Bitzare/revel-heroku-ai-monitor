'use strict';
// Índice de funciones Go del backend + utilidades para sacar contexto de código
// (función completa, fragmento alrededor de file:line, git blame).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FUNC_RE = /^func\s+(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)\s*[[(]/;
const SKIP_DIRS = new Set(['.git', 'vendor', 'node_modules', 'bin', 'docs', 'docs_stripe', 'functions', 'assets', 'firebase']);

class CodeIndex {
    constructor(backendPath) {
        this.root = backendPath;
        this.funcs = [];          // {name, recv, file(rel), start, end}
        this.byName = new Map();  // name -> [func]
        this.files = new Set();
    }

    build() {
        this.funcs = []; this.byName.clear(); this.files.clear();
        if (!fs.existsSync(this.root)) return this;
        this._walk(this.root);
        for (const f of this.funcs) {
            if (!this.byName.has(f.name)) this.byName.set(f.name, []);
            this.byName.get(f.name).push(f);
        }
        return this;
    }

    _walk(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) this._walk(full); continue; }
            if (!e.name.endsWith('.go') || e.name.endsWith('_test.go')) continue;
            const rel = this.rel(full);
            this.files.add(rel);
            this._indexFile(full, rel);
        }
    }

    _indexFile(full, rel) {
        let lines;
        try { lines = fs.readFileSync(full, 'utf8').split('\n'); } catch { return; }
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(FUNC_RE);
            if (!m) continue;
            // Fin de la función: primera línea "}" en columna 0 tras la firma (gofmt lo garantiza).
            let end = i;
            if (!/}\s*$/.test(lines[i]) || /{\s*$/.test(lines[i])) {
                for (let j = i + 1; j < lines.length; j++) { if (lines[j].startsWith('}')) { end = j; break; } }
            }
            this.funcs.push({ name: m[2], recv: m[1] ? m[1].trim() : null, file: rel, start: i + 1, end: end + 1 });
            i = end;
        }
    }

    rel(full) { return path.relative(this.root, full).split(path.sep).join('/'); }
    abs(rel) { return path.join(this.root, ...rel.split('/')); }

    /** Busca una función por nombre; si hay varias, prefiere la del directorio indicado. */
    find(name, preferDir) {
        const list = this.byName.get(name);
        if (!list || !list.length) return null;
        if (preferDir) {
            const hit = list.find(f => f.file.startsWith(preferDir + '/'));
            if (hit) return hit;
        }
        return list.find(f => f.file.startsWith('handlers/')) || list[0];
    }

    /** Función que contiene file:line (rutas como "/handlers/sessions/tokens.go"). */
    enclosing(file, line) {
        const rel = this.resolveFile(file);
        if (!rel) return null;
        return this.funcs.find(f => f.file === rel && f.start <= line && f.end >= line) || null;
    }

    resolveFile(file) {
        if (!file) return null;
        const clean = file.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^app\//, '');
        if (this.files.has(clean)) return clean;
        // Stack traces de Heroku traen /app/... o rutas de módulo; casamos por sufijo.
        for (const f of this.files) if (clean.endsWith('/' + f) || f.endsWith('/' + clean)) return f;
        return null;
    }

    source(fn, maxLines = 160) {
        try {
            const lines = fs.readFileSync(this.abs(fn.file), 'utf8').split('\n').slice(fn.start - 1, fn.end);
            const cut = lines.length > maxLines;
            return (cut ? lines.slice(0, maxLines) : lines).map((l, i) => `${String(fn.start + i).padStart(4)}| ${l}`).join('\n') + (cut ? `\n    | ... (${lines.length - maxLines} líneas más)` : '');
        } catch { return ''; }
    }

    rawSource(fn) {
        try { return fs.readFileSync(this.abs(fn.file), 'utf8').split('\n').slice(fn.start - 1, fn.end).join('\n'); } catch { return ''; }
    }

    snippet(file, line, radius = 12) {
        const rel = this.resolveFile(file);
        if (!rel) return '';
        try {
            const lines = fs.readFileSync(this.abs(rel), 'utf8').split('\n');
            const a = Math.max(0, line - 1 - radius), b = Math.min(lines.length, line + radius);
            return lines.slice(a, b).map((l, i) => `${String(a + i + 1).padStart(4)}${a + i + 1 === line ? '>' : '|'} ${l}`).join('\n');
        } catch { return ''; }
    }

    /** Autor y fecha de la última modificación del rango (git blame --porcelain). */
    blame(rel, start, end) {
        try {
            const out = execFileSync('git', ['blame', '--porcelain', '-L', `${start},${end}`, '--', rel], { cwd: this.root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString();
            // Nos quedamos con el commit más reciente del rango, que es el sospechoso habitual.
            // Se ignoran las líneas de log (log.Printf inyectados en masa por tools/add-error-logs.js),
            // que si no harían que el "culpable" fuese siempre ese commit de refactor.
            const commits = {};
            let best = null, cur = null;
            for (const l of out.split('\n')) {
                const h = l.match(/^([0-9a-f]{40}) \d+ \d+/);
                if (h) { cur = commits[h[1]] || (commits[h[1]] = { sha: h[1] }); continue; }
                if (!cur) continue;
                if (l.startsWith('author ')) cur.author = l.slice(7);
                else if (l.startsWith('author-time ')) cur.time = parseInt(l.slice(12), 10);
                else if (l.startsWith('summary ')) cur.summary = l.slice(8);
                else if (l.startsWith('\t')) {
                    const content = l.slice(1).trim();
                    if (!content || /^(log\.|logs\.)/.test(content) || content === '}') continue;
                    if (!best || cur.time > best.time) best = cur;
                }
            }
            if (!best || /^0+$/.test(best.sha)) return null;
            return { author: best.author, date: new Date(best.time * 1000).toISOString().slice(0, 10), sha: best.sha.slice(0, 8), summary: best.summary };
        } catch { return null; }
    }
}

module.exports = { CodeIndex };
