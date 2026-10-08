'use strict';
// Propuesta de parche. Nunca toca tu working tree ni cambia de rama:
//  - suggest: genera un diff unificado que se muestra en el dashboard.
//  - branch:  además crea la rama ai-fix/<id>-<fecha> con git plumbing
//             (hash-object + índice temporal + commit-tree + update-ref), así que
//             GoLand y tus cambios sin commitear no se enteran.
// El anterior hacía git checkout -b / checkout en el repo del backend en caliente.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PATCH_SCHEMA = {
    type: 'object',
    properties: {
        replacement: { type: 'string', description: 'La función Go completa corregida, desde "func" hasta la llave final' },
        explanation: { type: 'string', description: 'Qué cambia y por qué, 1-3 frases' },
    },
    required: ['replacement', 'explanation'],
};

class AutoFix {
    constructor({ code, client, cfg }) {
        this.code = code; this.client = client; this.cfg = cfg;
        this.gofmt = findGofmt(cfg.gofmtBin);
    }

    eligible(issue, analysis, ctx) {
        if (!this.cfg.autofixMode || this.cfg.autofixMode === 'off') return false;
        if (analysis.kind !== 'backend_bug' || !analysis.grounded) return false;
        if (analysis.confidence < (this.cfg.autofixMinConfidence ?? 0.7)) return false;
        return !!this._target(analysis, ctx);
    }

    _target(analysis, ctx) {
        const loc = analysis.location;
        if (loc && loc.function) {
            const fn = this.code.find(loc.function, loc.file ? loc.file.split('/').slice(0, -1).join('/') : null);
            if (fn) return fn;
        }
        return ctx.target || null;
    }

    async run(issue, analysis, ctx) {
        const fn = this._target(analysis, ctx);
        const original = this.code.rawSource(fn);
        if (!original) return null;
        const prompt = [
            `Corrige esta función Go según el diagnóstico. Cambia lo mínimo imprescindible, conserva firma, estilo, logs y comentarios existentes.`,
            `Diagnóstico: ${analysis.root_cause}`,
            `Solución propuesta: ${analysis.fix}`,
            `Error en producción: ${analysis.exact_error}`,
            `Fichero: ${fn.file}`,
            '```go', original, '```',
            'Devuelve la función completa corregida en "replacement" (sin markdown).',
            `Escribe "explanation" en ${this.cfg.aiLanguage === 'en' ? 'inglés (English)' : 'español'}.`,
        ].join('\n');
        const { data } = await this.client.chatJson([{ role: 'user', content: prompt }], PATCH_SCHEMA, { retries: 1, temperature: 0 });
        const replacement = String(data.replacement || '').replace(/^```(?:go)?\n?|```\s*$/g, '').trim();

        const sig = original.split('\n')[0].trim();
        if (!replacement.startsWith('func ')) throw new Error('el modelo no devolvió una función');
        if (replacement.split('\n')[0].trim() !== sig) throw new Error('el modelo cambió la firma de la función');
        if (replacement === original.trim()) throw new Error('el modelo devolvió la función sin cambios');

        const abs = this.code.abs(fn.file);
        const current = fs.readFileSync(abs, 'utf8');
        if (!current.includes(original)) throw new Error('el fichero ha cambiado desde que se indexó');
        const { src: updated, added } = addMissingImports(current.replace(original, replacement));
        this._checkSyntax(updated);
        const diff = unifiedDiff(fn.file, current, updated);
        let branch = null;
        if (this.cfg.autofixMode === 'branch') branch = this._createBranch(issue, fn, original, replacement, analysis);
        const note = added.length ? `\n# Imports añadidos: ${added.join(', ')}` : '';
        return { diff: `# ${data.explanation}${note}\n${diff}`, branch };
    }

    _checkSyntax(src) {
        if (!this.gofmt) return; // sin gofmt no se puede validar; el diff sigue siendo una sugerencia
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimon-'));
        const f = path.join(dir, 'x.go');
        try {
            fs.writeFileSync(f, src);
            execFileSync(this.gofmt, ['-e', '-l', f], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
        } catch (e) {
            const err = (e.stderr || '').toString().split('\n')[0];
            throw new Error(`el parche no compila sintácticamente: ${err.replace(f, '')}`);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    _createBranch(issue, fn, original, replacement, analysis) {
        const git = (args, opts = {}) => execFileSync('git', args, { cwd: this.code.root, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000, ...opts }).toString().trim();
        // Partimos del contenido de HEAD, no del disco: puede haber cambios sin commitear.
        let headContent;
        try { headContent = git(['show', `HEAD:${fn.file}`]); } catch { throw new Error('el fichero no está en HEAD'); }
        if (!headContent.includes(original.trimEnd())) throw new Error('la función tiene cambios sin commitear; solo se genera el diff');
        const content = addMissingImports(headContent.replace(original.trimEnd(), replacement)).src + '\n';
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimon-idx-'));
        const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index'),
            GIT_AUTHOR_NAME: 'Revel AI Ops Monitor', GIT_AUTHOR_EMAIL: 'ai-ops-monitor@localhost',
            GIT_COMMITTER_NAME: 'Revel AI Ops Monitor', GIT_COMMITTER_EMAIL: 'ai-ops-monitor@localhost' };
        try {
            const blob = git(['hash-object', '-w', '--stdin'], { input: content });
            git(['read-tree', 'HEAD'], { env });
            git(['update-index', '--cacheinfo', `100644,${blob},${fn.file}`], { env });
            const tree = git(['write-tree'], { env });
            const msg = `fix(ai): ${analysis.title || issue.title}\n\n${analysis.root_cause}\n\nIncidencia #${issue.id} del AI Ops Monitor. Revisar antes de mergear.`;
            const commit = git(['commit-tree', tree, '-p', 'HEAD', '-F', '-'], { env, input: msg });
            const branch = `ai-fix/${issue.id}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
            git(['update-ref', `refs/heads/${branch}`, commit]);
            return branch;
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
}

// Paquetes de la stdlib que el modelo suele usar en los parches sin importarlos.
const STD_IMPORTS = { errors: 'errors', sql: 'database/sql', strings: 'strings', fmt: 'fmt', strconv: 'strconv', time: 'time', context: 'context', http: 'net/http', json: 'encoding/json' };

function addMissingImports(src) {
    const block = src.match(/^import\s*\(([\s\S]*?)^\)/m);
    const single = src.match(/^import\s+(?:\w+\s+)?"([^"]+)"\s*$/m);
    const imported = new Set();
    const body = block ? block[1] : single ? single[0] : '';
    for (const m of body.matchAll(/(?:(\w+)\s+)?"([^"]+)"/g)) imported.add(m[1] || m[2].split('/').pop());
    const code = src.replace(/\/\/.*$/gm, '').replace(/"(?:[^"\\\n]|\\.)*"|`[^`]*`/g, '""');
    const added = [];
    for (const [alias, pkg] of Object.entries(STD_IMPORTS)) {
        if (!imported.has(alias) && new RegExp(`\\b${alias}\\.[A-Z]`).test(code)) added.push(pkg);
    }
    if (!added.length) return { src, added };
    const lines = added.map(p => `\t"${p}"`).join('\n');
    if (block) return { src: src.replace(/^import\s*\(\n?/m, m => `${m}${lines}\n`), added };
    if (single) return { src: src.replace(single[0], `import (\n${lines}\n\t"${single[1]}"\n)`), added };
    return { src: src.replace(/^(package \w+\n)/m, `$1\nimport (\n${lines}\n)\n`), added };
}

function findGofmt(explicit) {
    const exe = process.platform === 'win32' ? 'gofmt.exe' : 'gofmt';
    const cands = [explicit];
    for (const d of (process.env.PATH || '').split(path.delimiter)) cands.push(path.join(d, exe));
    const sdk = path.join(os.homedir(), 'sdk');
    try { for (const d of fs.readdirSync(sdk).filter(n => n.startsWith('go')).sort().reverse()) cands.push(path.join(sdk, d, 'bin', exe)); } catch { /* sin sdk */ }
    if (process.env.GOROOT) cands.push(path.join(process.env.GOROOT, 'bin', exe));
    return cands.find(c => c && fs.existsSync(c)) || null;
}

// Diff unificado sin dependencias: LCS por líneas sobre la zona que cambia y
// agrupación en hunks con `context` líneas alrededor (compatible con git apply).
function unifiedDiff(file, a, b, context = 3) {
    const A = a.split('\n'), B = b.split('\n');
    let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    const a1 = A.slice(pre, A.length - suf), b1 = B.slice(pre, B.length - suf);
    const n = a1.length, m = b1.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a1[i] === b1[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    // ops: [tipo, texto, líneaA, líneaB] (1-based)
    const ops = [];
    for (let k = 0; k < pre; k++) ops.push([' ', A[k], k + 1, k + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && a1[i] === b1[j]) { ops.push([' ', a1[i], pre + i + 1, pre + j + 1]); i++; j++; }
        else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) { ops.push(['-', a1[i], pre + i + 1, null]); i++; }
        else { ops.push(['+', b1[j], null, pre + j + 1]); j++; }
    }
    for (let k = 0; k < suf; k++) ops.push([' ', A[A.length - suf + k], A.length - suf + k + 1, B.length - suf + k + 1]);

    const changed = ops.map((o, k) => (o[0] !== ' ' ? k : -1)).filter(k => k !== -1);
    if (!changed.length) return '';
    const hunks = [];
    let start = Math.max(0, changed[0] - context), end = Math.min(ops.length - 1, changed[0] + context);
    for (const k of changed.slice(1)) {
        if (k - context <= end + 1) end = Math.min(ops.length - 1, k + context);
        else { hunks.push([start, end]); start = Math.max(0, k - context); end = Math.min(ops.length - 1, k + context); }
    }
    hunks.push([start, end]);

    let out = `--- a/${file}\n+++ b/${file}\n`;
    for (const [s0, e0] of hunks) {
        const slice = ops.slice(s0, e0 + 1);
        const aLines = slice.filter(o => o[0] !== '+'), bLines = slice.filter(o => o[0] !== '-');
        const prevA = ops.slice(0, s0).filter(o => o[0] !== '+').pop(), prevB = ops.slice(0, s0).filter(o => o[0] !== '-').pop();
        const aStart = aLines.length ? aLines[0][2] : (prevA ? prevA[2] : 0);
        const bStart = bLines.length ? bLines[0][3] : (prevB ? prevB[3] : 0);
        out += `@@ -${aStart},${aLines.length} +${bStart},${bLines.length} @@\n${slice.map(o => o[0] + o[1]).join('\n')}\n`;
    }
    return out;
}

module.exports = { AutoFix, unifiedDiff, findGofmt, addMissingImports };
