'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../src/pipeline/classify');
const { fingerprint, normalizeMessage, normalizePath } = require('../src/pipeline/fingerprint');

const req = (o) => ({ kind: 'request', method: 'GET', path: '/rv1/x', handler: 'X', causes: [], ...o });
const cause = (message, func) => ({ message, func });

test('bots y sondeos son ruido', () => {
    assert.equal(classify(req({ path: '/.env', status: 404, handler: null })).category, 'threat');
    assert.equal(classify(req({ path: '/wp-admin/install.php', status: 404, handler: null })).severity, 'noise');
    // 404 fuera de la API sin ruta conocida: sondeo
    assert.equal(classify(req({ path: '/blog', status: 404, handler: null })).category, 'threat');
});

test('404 dentro de la API sin ruta: cliente llamando a un endpoint inexistente', () => {
    const c = classify(req({ path: '/rv1/no-existe', status: 404, handler: null }));
    assert.equal(c.category, 'not_found');
    assert.equal(c.severity, 'medium');
});

test('401 por token ausente es esperado y de baja severidad', () => {
    const c = classify(req({ status: 401, causes: [cause('Failed to validate session: not authorized: no token available', 'X')] }));
    assert.equal(c.category, 'auth');
    assert.equal(c.severity, 'low');
    assert.equal(c.expected, true);
});

test('401 devuelto por un sql: no rows no es esperado', () => {
    const c = classify(req({ status: 401, causes: [cause('sql: no rows in result set')] }));
    assert.equal(c.expected, false);
});

test('pagos: resource_missing es crítico y "insufficient coins" esperado', () => {
    const crit = classify(req({ path: '/rv1/payments/coin_packs/intent', status: 500, causes: [cause("resource_missing: No such PaymentMethod: 'pm_1'", 'PostCoinPackIntent')] }));
    assert.equal(crit.category, 'payment');
    assert.equal(crit.severity, 'critical');
    const exp = classify(req({ path: '/rv1/payments/coin_packs/intent', status: 400, causes: [cause('insufficient coins', 'PostCoinPackIntent')] }));
    assert.equal(exp.expected, true);
    assert.equal(exp.severity, 'low');
});

test('panic, infraestructura y códigos de Heroku', () => {
    assert.equal(classify({ kind: 'panic', message: 'http: panic serving 1.2.3.4: runtime error: nil pointer' }).severity, 'critical');
    assert.equal(classify({ kind: 'app', message: 'redis auth error: dial tcp 1.2.3.4:1: i/o timeout' }).category, 'infra');
    assert.equal(classify(req({ status: 503, routerCode: 'H12' })).category, 'timeout');
    assert.equal(classify(req({ status: 503, routerCode: 'H10' })).severity, 'critical');
    assert.equal(classify({ kind: 'platform', message: 'State changed from up to crashed' }).severity, 'critical');
});

test('base de datos: errores SQL reales frente a "no rows"', () => {
    assert.equal(classify(req({ status: 500, causes: [cause("Error 1062: Duplicate entry '1' for key 'PRIMARY'")] })).category, 'database');
    assert.equal(classify(req({ status: 400, causes: [cause('sql: no rows in result set', 'X')] })).category, 'not_found');
});

test('petición lenta sin error', () => {
    const c = classify(req({ status: 200, serviceMs: 12000 }), { slowRequestMs: 5000 });
    assert.equal(c.category, 'slow');
});

test('la huella agrupa IDs, emails y valores distintos', () => {
    assert.equal(normalizeMessage("user 123 pm_ABC 'x' a@b.com 1.2.3.4:80"), "user <n> pm_<id> '<s>' <email> <ip>");
    assert.equal(normalizePath('/admin/v1/clubs/9/events/'), '/admin/v1/clubs/:id/events');
    const a = fingerprint({ category: 'validation', method: 'GET', path: '/rv1/clubs/1', status: 400, causes: [cause('bad id 1', 'F')] });
    const b = fingerprint({ category: 'validation', method: 'GET', path: '/rv1/clubs/2', status: 400, causes: [cause('bad id 999', 'F')] });
    const c = fingerprint({ category: 'validation', method: 'GET', path: '/rv1/clubs/2', status: 400, causes: [cause('other error', 'F')] });
    assert.equal(a, b);
    assert.notEqual(a, c);
    // Todos los bots en una incidencia
    assert.equal(fingerprint({ category: 'threat', path: '/.env' }), fingerprint({ category: 'threat', path: '/wp-admin' }));
});

test('rutas legítimas de la API no se confunden con sondeos', () => {
    assert.notEqual(classify(req({ path: '/rv1/users/credentials', status: 400, handler: 'PostCredentials' })).category, 'threat');
    assert.notEqual(classify(req({ path: '/rv1/shellfish', status: 404, handler: null })).category, 'threat');
    assert.equal(classify(req({ path: '/.aws/credentials', status: 404, handler: null })).category, 'threat');
});
