'use strict';
// Agrupa ocurrencias del mismo problema bajo una huella estable (estilo Sentry):
// mismas rutas con distintos IDs, mismos errores con distintos valores → misma incidencia.
const crypto = require('crypto');

function normalizeMessage(msg) {
    if (!msg) return '';
    return String(msg)
        .replace(/\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
        .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<ip>')
        .replace(/\b(pi|pm|seti|cus|ch|in|sub|price|prod|acct|evt|cs|re|txn)_[A-Za-z0-9]+/g, '$1_<id>')
        .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
        .replace(/"[^"]{0,200}"/g, '"<s>"')
        .replace(/'[^']{0,200}'/g, "'<s>'")
        .replace(/\b\d+(\.\d+)?\b/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
}

// Sustituye segmentos variables de un path por :id cuando no hay plantilla de ruta.
function normalizePath(p) {
    if (!p) return '';
    return p
        .split('/')
        .map(seg => {
            if (!seg) return seg;
            if (/^\d+$/.test(seg)) return ':id';
            if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg)) return ':uuid';
            if (/^[0-9a-f]{16,}$/i.test(seg)) return ':hash';
            if (/^(es|en|ca|pt|fr|it|de)$/i.test(seg)) return ':language';
            return seg;
        })
        .join('/')
        .replace(/\/+$/, '') || '/';
}

function fingerprint(inc) {
    const cause = (inc.causes || []).find(c => c.func || c.codeFile) || (inc.causes || [])[0];
    // Los sondeos de bots cambian de ruta en cada petición: una sola incidencia para todos.
    if (inc.category === 'threat') return crypto.createHash('sha1').update('threat|scanners').digest('hex').slice(0, 16);
    const parts = [inc.category];
    if (inc.route || inc.path) {
        parts.push(`${inc.method || ''} ${inc.route || normalizePath(inc.path)}`, String(inc.status || ''));
        if (cause) parts.push(cause.func || '', normalizeMessage(cause.message));
    } else {
        parts.push(inc.func || '', inc.codeFile ? `${inc.codeFile}:${inc.codeLine}` : '', normalizeMessage(inc.message));
    }
    if (inc.routerCode) parts.push(inc.routerCode);
    return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

module.exports = { fingerprint, normalizeMessage, normalizePath };
