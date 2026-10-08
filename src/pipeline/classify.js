'use strict';
// Clasificación determinista: categoría + severidad + si es "esperado".
// Va antes que la IA para que el modelo solo se use donde aporta (y para que el
// dashboard funcione aunque Ollama esté apagado).
const { sevRank, SEVERITIES } = require('../config');

// Escáneres de vulnerabilidades. Se comprueba sobre el path, no sobre toda la línea.
const THREAT_RE = new RegExp([
    String.raw`\.env\b`, String.raw`\.git(\/|$)`, String.raw`\.(bak|old|swp|sql|tar|gz|zip|rar|7z)$`,
    String.raw`\.(php\d?|asp|aspx|jsp|cgi|pl)$`, 'wp-(admin|includes|content|login|config)', 'xmlrpc',
    'wp-json', '/wordpress', String.raw`^/wp(/|$)`, 'phpmyadmin', 'pma', 'cgi-bin', String.raw`\.aws`, String.raw`\.kube`, String.raw`\.npmrc`, String.raw`\.ssh`,
    String.raw`\.ds_store`, String.raw`/credentials(\.\w+)?$`, 'debug\\.log', String.raw`\.ya?ml$`, String.raw`\.config$`, String.raw`\.ini$`,
    '/actuator', '/vendor/phpunit', '/boaform', '/hnap1', '/solr/', '/owa/', '/autodiscover', '/telescope',
    '/_ignition', '/server-status', String.raw`/console(/|$)`, '/manager/html', '/\\.vscode', String.raw`/shell(/|$)`, '/eval-stdin',
].join('|'), 'i');

// Patrones de pago heredados del workflow de n8n "Alertas de errores (Heroku -> Slack)".
const PAYMENT_RE = /stripe|resource_missing|parameter_invalid_empty|card_declined|payment_?intent|PaymentMethod|setup_?intent|webhook had no valid signature|PostCoinPackIntent|PostStudentTrainingIntent|PostAppCreditsBuySingle|PostAppSubscriptions|HandleWebhook|\binvoice\b|\brefund/i;
const PAYMENT_PATH_RE = /\/payments?\/|\/stripe|intent|\/coins?\/|\/subscriptions?\b|\/credits/i;
const EXPECTED_PAYMENT_RE = /insufficient coins/i;

const PANIC_RE = /\bpanic[:(]|runtime error|http: panic serving|goroutine \d+ \[running\]|fatal error:/i;
const INFRA_RE = /dial tcp|i\/o timeout|connection refused|connection reset|broken pipe|no such host|too many connections|redis|EOF$|tls handshake|context deadline exceeded|driver: bad connection|server has gone away/i;
const DB_RE = /\bsql:|mysql|Error \d{4}\b|deadlock|duplicate entry|foreign key constraint|Data too long|Unknown column|syntax to use near|Lock wait timeout/i;
const NOT_FOUND_RE = /sql: no rows in result set|not found/i;
const AUTH_RE = /not authorized|unauthori[sz]ed|forbidden|jwt|token (is )?(expired|invalid)|no token available|failed to validate session|invalid session/i;
const VALIDATION_RE = /invalid syntax|unmarshal|cannot unmarshal|strconv\.|invalid character|unexpected end of JSON|missing (field|param)|required|bad request|invalid (input|param|value|request)/i;
const ERRORISH_RE = /\berror\b|\bfailed\b|\bfail\b|\bcannot\b|\bcan't\b|\binvalid\b|\bpanic\b|-> |\bnil pointer\b|\btimeout\b/i;
const API_PREFIX_RE = /^\/(r?v\d+|admin)\//;
const NOISE_MSG_RE = /^<nil>$|^using local envs$|^No pending news to process\.?$|^ranking$/i;

// Códigos de error del router de Heroku → [categoría, severidad]
const HEROKU_CODES = {
    H10: ['infra', 'critical', 'App caída (H10)'], H12: ['timeout', 'high', 'Timeout de petición (H12)'],
    H13: ['infra', 'high', 'Conexión cerrada sin respuesta (H13)'], H14: ['infra', 'critical', 'Sin dynos web (H14)'],
    H15: ['infra', 'medium', 'Conexión inactiva (H15)'], H18: ['infra', 'medium', 'Petición interrumpida (H18)'],
    H19: ['infra', 'high', 'Timeout de arranque de conexión (H19)'], H20: ['infra', 'critical', 'Timeout de arranque de app (H20)'],
    H27: ['client', 'noise', 'El cliente cortó la petición (H27)'], H28: ['client', 'noise', 'El cliente cortó la conexión (H28)'],
    H80: ['infra', 'low', 'Modo mantenimiento (H80)'], H81: ['infra', 'low', 'App en blanco (H81)'],
    R14: ['infra', 'high', 'Memoria superada (R14)'], R15: ['infra', 'critical', 'Memoria muy superada, dyno reiniciado (R15)'],
    R10: ['infra', 'critical', 'Timeout de arranque (R10)'], R12: ['infra', 'high', 'Timeout de salida (R12)'],
};

const CATEGORY_LABELS = {
    panic: 'Panic', infra: 'Infraestructura', timeout: 'Timeout', payment: 'Pagos', database: 'Base de datos',
    server: 'Error de servidor', validation: 'Validación', auth: 'Autenticación', not_found: 'No encontrado',
    client: 'Cliente', threat: 'Escaneo / bot', slow: 'Lentitud', unknown: 'Otro',
};

function bump(sev, n = 1) { return SEVERITIES[Math.min(SEVERITIES.length - 1, sevRank(sev) + n)]; }
function lower(sev, n = 1) { return SEVERITIES[Math.max(0, sevRank(sev) - n)]; }

function isThreatPath(p) { return !!p && THREAT_RE.test(p); }
function isNoiseMessage(m) { return !m || NOISE_MSG_RE.test(m.trim()); }
function looksLikeError(ev) {
    if (!ev || ev.kind !== 'app') return false;
    if (isNoiseMessage(ev.message)) return false;
    return !!ev.func || !!ev.codeFile || ERRORISH_RE.test(ev.message) || PANIC_RE.test(ev.message) || DB_RE.test(ev.message) || INFRA_RE.test(ev.message);
}

/**
 * Clasifica un incidente ya correlacionado.
 * @param {{status?:number, method?:string, path?:string, serviceMs?:number, routerCode?:string,
 *          causes?:Array<{message?:string, func?:string}>, message?:string, kind:string}} inc
 * @returns {{category:string, severity:string, expected:boolean, reason:string}}
 */
function classify(inc, cfg = {}) {
    const causeText = (inc.causes || []).map(c => `${c.func ? `[${c.func}] ` : ''}${c.message || ''}`).join('\n');
    const text = [inc.message || '', causeText].join('\n');
    const status = inc.status || 0;
    const slowMs = cfg.slowRequestMs || 5000;

    // Una ruta registrada en routes*.go nunca es un sondeo, aunque su nombre se parezca a uno.
    if (inc.path && !inc.handler && isThreatPath(inc.path)) return r('threat', 'noise', true, 'Ruta típica de escáner automático');
    // 404 en una ruta que no existe en routes*.go: fuera de la API es un sondeo; dentro, un cliente
    // (app o panel) llamando a un endpoint que ya no existe, que sí hay que mirar.
    if (inc.kind === 'request' && status === 404 && !inc.handler && !inc.causes?.length) {
        if (API_PREFIX_RE.test(inc.path || '')) return r('not_found', 'medium', false, 'Endpoint inexistente: ¿cliente desactualizado o ruta mal escrita?');
        return r('threat', 'noise', true, 'Ruta fuera de la API (sondeo)');
    }
    if (inc.routerCode && HEROKU_CODES[inc.routerCode]) {
        const [cat, sev, label] = HEROKU_CODES[inc.routerCode];
        return r(cat, sev, cat === 'client', label);
    }
    if (PANIC_RE.test(text)) return r('panic', 'critical', false, 'Panic en el proceso Go');
    if (inc.kind === 'platform') {
        if (/crashed|Process exited with status [1-9]/i.test(text)) return r('infra', 'critical', false, 'El dyno se ha caído');
        return r('infra', 'low', true, 'Evento de plataforma');
    }

    const isPaymentCtx = PAYMENT_RE.test(text) || (inc.path && PAYMENT_PATH_RE.test(inc.path));
    if (isPaymentCtx && EXPECTED_PAYMENT_RE.test(text)) return r('payment', 'low', true, 'Saldo insuficiente (esperado)');

    if (INFRA_RE.test(causeText || inc.message || '')) {
        return r('infra', status >= 500 || !status ? 'high' : 'medium', false, 'Fallo de red o de servicio externo');
    }
    if (isPaymentCtx && (status >= 400 || !status)) {
        if (/webhook had no valid signature/i.test(text)) return r('payment', 'medium', false, 'Webhook de Stripe con firma inválida');
        return r('payment', status >= 500 || /resource_missing|PaymentMethod/i.test(text) ? 'critical' : 'high', false, 'Error en un flujo de pago');
    }
    if (status >= 500) {
        if (DB_RE.test(text) && !NOT_FOUND_RE.test(text)) return r('database', 'critical', false, 'Error de base de datos con 5xx');
        return r('server', 'high', false, `Respuesta ${status}`);
    }
    if (DB_RE.test(text) && !NOT_FOUND_RE.test(text)) {
        return r('database', status ? 'high' : 'medium', false, 'Error de SQL');
    }
    if (status === 401 || status === 403 || AUTH_RE.test(text)) {
        const expected = /no token available|token (is )?expired/i.test(text) || (!causeText && (status === 401 || status === 403));
        return r('auth', expected ? 'low' : 'medium', expected, expected ? 'Sesión ausente o caducada (habitual)' : 'Fallo de autenticación');
    }
    if (status === 404 || NOT_FOUND_RE.test(text)) {
        return r('not_found', status === 400 ? 'medium' : 'low', status === 404 && !causeText, 'Recurso no encontrado');
    }
    if (status === 400 || status === 422 || status === 409 || VALIDATION_RE.test(text)) {
        return r('validation', 'medium', false, 'Petición rechazada por datos inválidos');
    }
    if (status === 499) return r('client', 'noise', true, 'El cliente cerró la conexión');
    if (status >= 400) return r('server', 'low', false, `Respuesta ${status}`);
    if (inc.serviceMs && inc.serviceMs >= slowMs) return r('slow', inc.serviceMs >= slowMs * 4 ? 'high' : 'medium', false, `Petición lenta (${inc.serviceMs} ms)`);
    if (inc.kind === 'app') return r('unknown', ERRORISH_RE.test(text) ? 'medium' : 'low', false, 'Error en segundo plano');
    return r('unknown', 'low', false, '');
}

function r(category, severity, expected, reason) { return { category, severity, expected, reason }; }

module.exports = { classify, isThreatPath, isNoiseMessage, looksLikeError, bump, lower, CATEGORY_LABELS, HEROKU_CODES };
