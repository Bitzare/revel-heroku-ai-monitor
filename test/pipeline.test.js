'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store/db');
const { Pipeline } = require('../src/pipeline/pipeline');
const { CodeIndex } = require('../src/code/index');
const { loadRoutes, matchRoute } = require('../src/code/routes');
const { testConfig, fixtureLines, BACKEND } = require('./helpers');

function run(lines) {
    const cfg = testConfig();
    const store = new Store(':memory:');
    const code = new CodeIndex(BACKEND).build();
    const pipeline = new Pipeline({ store, routes: loadRoutes(BACKEND, cfg), code, cfg });
    const incidents = [];
    pipeline.on('incident', e => incidents.push(e));
    for (const l of lines) pipeline.ingest(l, 'test');
    pipeline.flush();
    return { store, pipeline, incidents, issues: store.listIssues({ state: 'all', includeNoise: true }) };
}

test('tabla de rutas: plantillas, comentarios ignorados y handler exacto', () => {
    const routes = loadRoutes(BACKEND, testConfig());
    assert.equal(routes.length, 5);
    const r = matchRoute(routes, 'GET', '/admin/v1/clubs/3/is-federated');
    assert.equal(r.handler, 'GetIsFederatedClub');
    assert.equal(r.pkgDir, 'handlers/clubs');
    assert.equal(r.pattern, '/admin/v1/clubs/:clubId/is-federated');
    assert.equal(matchRoute(routes, 'GET', '/rv1/payments/old'), null);
});

test('índice de código: funciones, función contenedora de file:line', () => {
    const code = new CodeIndex(BACKEND).build();
    assert.ok(code.find('PostCoinPackIntent'));
    const fn = code.enclosing('/app/handlers/sessions/tokens.go', 9);
    assert.equal(fn.name, 'validateJWTToken');
});

test('fixture mixto: cada problema acaba en su incidencia con su clasificación', () => {
    const { issues, pipeline } = run(fixtureLines('heroku_mixed.log'));
    const by = t => issues.find(i => t(i));

    const pay = by(i => i.category === 'payment' && i.severity === 'critical');
    assert.ok(pay, 'falta la incidencia de pago');
    assert.equal(pay.route, '/rv1/payments/coin_packs/intent');
    assert.equal(pay.func, 'PostCoinPackIntent');
    assert.deepEqual(pay.user_ids, ['4242']);
    assert.equal(pay.count, 1, 'la línea de router duplicada no debe contar dos veces');
    assert.equal(pay.after_release, 'v812');

    const coins = by(i => i.category === 'payment' && i.expected);
    assert.ok(coins, '"insufficient coins" debe ser un pago esperado');

    const panic = by(i => i.category === 'panic');
    assert.equal(panic.func, 'validateJWTToken', 'el panic se atribuye a la función del stack');

    assert.ok(by(i => i.category === 'timeout' && i.route === '/rv1/clubs/bookings'));
    assert.ok(by(i => i.category === 'infra' && /R14/.test(i.title)));
    assert.ok(by(i => i.category === 'infra' && /Redis/.test(i.title)));
    assert.ok(by(i => i.category === 'infra' && i.severity === 'critical' && /crashed/.test(i.title)));
    assert.equal(issues.filter(i => i.category === 'threat').length, 1, 'todos los bots en una sola incidencia');
    assert.equal(by(i => i.category === 'threat').count, 2);

    const auth = by(i => i.category === 'auth');
    assert.equal(auth.route, '/admin/v1/clubs/:clubId/club-payment-types');
    assert.equal(auth.expected, 1);

    // La línea "<nil>" no genera nada
    assert.ok(!issues.some(i => /<nil>/.test(i.title)));
    assert.equal(pipeline.stats.dupes, 1);
});

test('las causas se atribuyen a la petición de su handler aunque se intercalen otras', () => {
    const lines = [
        '2026-10-08T10:00:00.000000+00:00 app[web.1]: 2026/10/08 10:00:00 [GetIsFederatedClub] Failed to get federation info: sql: no rows in result set',
        '2026-10-08T10:00:00.010000+00:00 app[web.1]: [EndPoint] 2026/10/08 10:00:00 \x1b[32m GET \x1b[0m https://h/rv1/profile \x1b[32m (200) \x1b[0m',
        '2026-10-08T10:00:00.010100+00:00 heroku[router]: at=info method=GET path="/rv1/profile" dyno=web.1 service=30ms status=200',
        '2026-10-08T10:00:00.020000+00:00 app[web.1]: [EndPoint] 2026/10/08 10:00:00 \x1b[32m GET \x1b[0m https://h/admin/v1/clubs/3/is-federated \x1b[31m (400) \x1b[0m',
        '2026-10-08T10:00:00.020100+00:00 heroku[router]: at=info method=GET path="/admin/v1/clubs/3/is-federated" dyno=web.1 service=40ms status=400',
    ];
    const { issues } = run(lines);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].func, 'GetIsFederatedClub');
    assert.equal(issues[0].route, '/admin/v1/clubs/:clubId/is-federated');
});

test('una incidencia resuelta que reaparece se reabre como regresión', () => {
    const line = (t) => [
        `2026-10-08T10:0${t}:00.000000+00:00 app[web.1]: 2026/10/08 10:0${t}:00 [GetIsFederatedClub] Failed to get federation info: sql: no rows in result set`,
        `2026-10-08T10:0${t}:00.001000+00:00 heroku[router]: at=info method=GET path="/admin/v1/clubs/3/is-federated" dyno=web.1 service=40ms status=400`,
    ];
    const { store, pipeline } = run(line(1));
    const [issue] = store.listIssues({ state: 'all' });
    store.updateIssue(issue.id, { state: 'resolved' });
    let reopened = false;
    pipeline.on('incident', e => { reopened = e.reopened; });
    for (const l of line(5)) pipeline.ingest(l, 'test');
    pipeline.flush();
    const again = store.getIssue(issue.id);
    assert.equal(again.state, 'open');
    assert.equal(again.regression, 1);
    assert.equal(again.count, 2);
    assert.ok(reopened);
});

test('métricas por minuto y pulso', () => {
    const { store, pipeline } = run(fixtureLines('heroku_mixed.log'));
    const rows = store.metricsSince('2000');
    const total = rows.reduce((a, r) => a + r.requests, 0);
    assert.equal(total, pipeline.stats.requests);
    assert.ok(rows.some(r => r.err5 > 0));
    assert.ok(pipeline.recentRequests.length === total);
});

test('picos: muchas ocurrencias en 5 min suben la severidad y marcan la incidencia', () => {
    const lines = [];
    for (let k = 0; k < 12; k++) {
        const ts = `2026-10-08T11:00:${String(k * 2).padStart(2, '0')}`;
        lines.push(`${ts}.000000+00:00 app[web.1]: 2026/10/08 11:00:00 [GetIsFederatedClub] Failed to get federation info: sql: no rows in result set`);
        lines.push(`${ts}.001000+00:00 heroku[router]: at=info method=GET path="/admin/v1/clubs/${k}/is-federated" dyno=web.1 service=40ms status=400`);
    }
    const { issues } = run(lines);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].count, 12);
    assert.equal(issues[0].spike, 1);
    assert.equal(issues[0].severity, 'high');
});

test('percentil aproximado del histograma de latencias', () => {
    const { latBin, percentile, mergeHist } = require('../src/store/db');
    let h = [];
    for (let i = 0; i < 90; i++) h = mergeHist(h, (() => { const x = []; x[latBin(40)] = 1; return x; })());
    for (let i = 0; i < 10; i++) h = mergeHist(h, (() => { const x = []; x[latBin(2500)] = 1; return x; })());
    assert.ok(percentile(h, 0.5) <= 50);
    assert.ok(percentile(h, 0.95) > 2000 && percentile(h, 0.95) <= 3000);
    assert.equal(percentile([], 0.95), null);
});
