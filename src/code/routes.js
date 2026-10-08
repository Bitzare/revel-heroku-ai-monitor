'use strict';
// Lee routes*.go / main.go del backend y construye la tabla
// "MÉTODO /ruta/:param → paquete.Handler". Así un 400 en
// /admin/v1/clubs/3/is-federated apunta exactamente a clubs.GetIsFederatedClub
// en vez de adivinarlo por palabras como hacía el RAG anterior.
const fs = require('fs');
const path = require('path');

const REG_RE = /\b(\w+)\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\(\s*([^,]+?)\s*,\s*([\w.]+)\s*\)/g;
const IMPORT_RE = /^\s*(?:(\w+)\s+)?"([^"]+)"\s*$/;

function parseImports(src) {
    const map = {};
    const block = src.match(/import\s*\(([\s\S]*?)\)/);
    const lines = block ? block[1].split('\n') : [];
    const single = src.match(/^import\s+(?:(\w+)\s+)?"([^"]+)"/m);
    if (single) lines.push(`${single[1] || ''} "${single[2]}"`);
    for (const l of lines) {
        const m = l.match(IMPORT_RE);
        if (!m) continue;
        const alias = m[1] || m[2].split('/').pop();
        map[alias] = m[2];
    }
    return map;
}

// Evalúa expresiones tipo RevelAPIVersion+"/clubs/:id" o "/admin"+CurrentAdminAPIVersion+"/x".
function evalPathExpr(expr, consts) {
    let out = '';
    for (const part of expr.split('+').map(s => s.trim())) {
        const lit = part.match(/^"([^"]*)"$|^`([^`]*)`$/);
        if (lit) { out += lit[1] ?? lit[2]; continue; }
        if (part in consts) { out += consts[part]; continue; }
        return null; // expresión desconocida: no arriesgamos
    }
    return out;
}

function loadRoutes(backendPath, cfg = {}) {
    const consts = {
        CurrentAPIVersion: `/v${cfg.apiVersion || '1'}`,
        RevelAPIVersion: `/rv${cfg.apiVersion || '1'}`,
        CurrentAdminAPIVersion: `/v${cfg.adminApiVersion || '1'}`,
    };
    let files = [];
    try {
        files = fs.readdirSync(backendPath).filter(f => /^(routes.*|main)\.go$/.test(f));
    } catch { return []; }

    const routes = [];
    for (const f of files) {
        const src = fs.readFileSync(path.join(backendPath, f), 'utf8');
        const imports = parseImports(src);
        // Ignora rutas comentadas
        const code = src.split('\n').map(l => (l.trim().startsWith('//') ? '' : l)).join('\n');
        let m;
        REG_RE.lastIndex = 0;
        while ((m = REG_RE.exec(code))) {
            const [, , method, expr, handler] = m;
            const pattern = evalPathExpr(expr, consts);
            if (!pattern || !pattern.startsWith('/')) continue;
            const [pkg, fn] = handler.includes('.') ? handler.split('.') : [null, handler];
            const importPath = pkg ? imports[pkg] : null;
            const pkgDir = importPath && importPath.includes('/handlers/') ? importPath.slice(importPath.indexOf('/handlers/') + 1) : null;
            const line = code.slice(0, m.index).split('\n').length;
            routes.push({ method, pattern, handler: fn, pkg, pkgDir, file: f, line, ...compile(pattern) });
        }
    }
    return routes;
}

function compile(pattern) {
    const segs = pattern.replace(/\/+$/, '').split('/');
    const literal = segs.filter(s => s && !s.startsWith(':') && !s.startsWith('*')).length;
    const src = segs.map(s => (s.startsWith(':') ? '[^/]+' : s.startsWith('*') ? '.*' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
    return { re: new RegExp(`^${src}/?$`), specificity: literal };
}

function matchRoute(routes, method, p) {
    if (!p) return null;
    let best = null;
    for (const r of routes) {
        if (method && r.method !== method) continue;
        if (!r.re.test(p)) continue;
        if (!best || r.specificity > best.specificity) best = r;
    }
    return best;
}

module.exports = { loadRoutes, matchRoute, evalPathExpr, parseImports };
