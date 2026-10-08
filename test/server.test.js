'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../src/app');
const { extractN8nLines } = require('../src/server/http');
const { testConfig, fixtureLines, FakeClient } = require('./helpers');

const silent = { info() {}, warn() {}, error() {} };

async function start(over = {}, responder) {
    const cfg = testConfig(over);
    const app = createApp(cfg, { log: silent, client: new FakeClient(responder || (() => ({
        title: 't', summary: 's', root_cause: 'r', exact_error: 'x', kind: 'backend_bug', severity: 'high',
        location: { file: '', function: '', line: 0 }, fix: 'f', fix_steps: [], confidence: 0.5,
    }))) });
    const addr = await app.listen();
    const base = `http://127.0.0.1:${addr.port}`;
    return { app, base };
}

async function req(base, method, path, body, headers = {}) {
    const res = await fetch(base + path, { method, body, headers });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
}

test('ingesta por drain de Logplex, n8n y texto; la API devuelve las incidencias', async (t) => {
    const { app, base } = await start();
    t.after(() => app.stop());
    const lines = fixtureLines('heroku_mixed.log');

    // Drain: tramas octet-counted (las líneas de Heroku sin prefijo syslog también se aceptan)
    const half = lines.slice(0, 12);
    const body = half.map(l => `${Buffer.byteLength(l)} ${l}`).join('');
    const r1 = await req(base, 'POST', '/api/ingest', body, { 'Content-Type': 'application/logplex-1' });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.lines, 12);

    // n8n: formato de items
    const r2 = await req(base, 'POST', '/api/ingest/n8n', JSON.stringify([{ data: lines.slice(12).join('\n') }]), { 'Content-Type': 'application/json' });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.lines, lines.length - 12);

    app.pipeline.flush();
    const { json } = await req(base, 'GET', '/api/issues?range=all&state=all&noise=1');
    assert.ok(json.issues.length >= 9);
    const pay = json.issues.find(i => i.category === 'payment' && i.severity === 'critical');
    assert.ok(pay);

    const detail = await req(base, 'GET', `/api/issues/${pay.id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.json.events.length >= 1);
    assert.match(detail.json.events[0].evidence, /resource_missing/);

    const health = await req(base, 'GET', '/api/health');
    assert.equal(health.json.pipeline.bySource['logplex-drain'].lines, 12);
    assert.ok(health.json.sources.some(s => s.name === 'n8n' && s.state === 'live'));

    const stats = await req(base, 'GET', '/api/stats?range=all');
    assert.ok(stats.json.totals.requests > 0);
    assert.equal(stats.json.releases[0].version, 'v812');
});

test('acciones del dashboard exigen la cabecera X-AIMON', async (t) => {
    const { app, base } = await start();
    t.after(() => app.stop());
    await req(base, 'POST', '/api/ingest/raw', fixtureLines('heroku_mixed.log').join('\n'));
    app.pipeline.flush();
    const { json } = await req(base, 'GET', '/api/issues?range=all&state=all');
    const id = json.issues[0].id;
    const denied = await req(base, 'POST', `/api/issues/${id}/state`, JSON.stringify({ state: 'resolved' }));
    assert.equal(denied.status, 403);
    const ok = await req(base, 'POST', `/api/issues/${id}/state`, JSON.stringify({ state: 'resolved' }), { 'X-AIMON': '1' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.issue.state, 'resolved');
    const bad = await req(base, 'POST', `/api/issues/${id}/state`, JSON.stringify({ state: 'whatever' }), { 'X-AIMON': '1' });
    assert.equal(bad.status, 400);
});

test('con INGEST_TOKEN la ingesta exige el token', async (t) => {
    const { app, base } = await start({ ingestToken: 'secreto' });
    t.after(() => app.stop());
    const line = fixtureLines('heroku_mixed.log')[2];
    assert.equal((await req(base, 'POST', '/api/ingest/raw', line)).status, 401);
    assert.equal((await req(base, 'POST', '/api/ingest/raw', line, { 'X-Monitor-Token': 'malo' })).status, 401);
    assert.equal((await req(base, 'POST', '/api/ingest/raw', line, { 'X-Monitor-Token': 'secreto' })).status, 200);
    assert.equal((await req(base, 'POST', `/api/ingest?token=secreto`, `${Buffer.byteLength(line)} ${line}`)).status, 200);
});

test('alertas a n8n: se envían para incidencias críticas con el payload esperado', async (t) => {
    const received = [];
    const hook = http.createServer((rq, rs) => {
        let b = ''; rq.on('data', c => { b += c; });
        rq.on('end', () => { received.push({ body: JSON.parse(b), token: rq.headers['x-monitor-token'] }); rs.end('ok'); });
    });
    await new Promise(r => hook.listen(0, '127.0.0.1', r));
    t.after(() => hook.close());
    const { app, base } = await start({ n8nWebhookUrl: `http://127.0.0.1:${hook.address().port}/hook`, n8nWebhookToken: 'tok', alertMinSeverity: 'critical', aiEnabled: false });
    t.after(() => app.stop());
    await req(base, 'POST', '/api/ingest/raw', fixtureLines('heroku_mixed.log').join('\n'));
    app.pipeline.flush();
    await new Promise(r => setTimeout(r, 300));
    assert.ok(received.length >= 1, 'no llegó ninguna alerta');
    assert.ok(received.every(r => r.token === 'tok'));
    const pay = received.find(r => r.body.issue.category === 'payment');
    assert.ok(pay, 'falta la alerta de pago');
    assert.deepEqual(pay.body.userIds, ['4242']);
    assert.ok(received.every(r => r.body.issue.severity === 'critical'));
});

test('el dashboard se sirve y las rutas desconocidas caen en el index (SPA)', async (t) => {
    const { app, base } = await start();
    t.after(() => app.stop());
    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Revel Guardia/);
    const deep = await fetch(base + '/algo/que/no/existe');
    assert.match(await deep.text(), /Revel Guardia/);
    const trav = await fetch(base + '/..%2f..%2fpackage.json');
    assert.doesNotMatch(await trav.text(), /"dependencies"|"engines"/);
});

test('extractN8nLines acepta los formatos habituales de n8n', () => {
    const b = s => Buffer.from(typeof s === 'string' ? s : JSON.stringify(s));
    assert.deepEqual(extractN8nLines(b({ lines: ['a', 'b'] })), ['a', 'b']);
    assert.deepEqual(extractN8nLines(b({ logs: 'a\nb' })), ['a', 'b']);
    assert.deepEqual(extractN8nLines(b([{ json: { line: 'a' } }, { data: 'b\nc' }])), ['a', 'b', 'c']);
    assert.deepEqual(extractN8nLines(b('a\r\nb')), ['a', 'b']);
});

test('endpoints, deploys, percentiles y configuración', async (t) => {
    const { app, base } = await start({ aiEnabled: false, herokuApiToken: 'secreto-que-no-debe-salir' });
    t.after(() => app.stop());
    await req(base, 'POST', '/api/ingest/raw', fixtureLines('heroku_mixed.log').join('\n'));
    app.pipeline.flush();

    const routes = (await req(base, 'GET', '/api/routes?range=all')).json.routes;
    const pay = routes.find(r => r.route === '/rv1/payments/coin_packs/intent');
    assert.equal(pay.handler, 'PostCoinPackIntent');
    assert.equal(pay.err5, 1);
    assert.equal(pay.p95 > 0, true);
    assert.ok(!routes.some(r => r.route.includes('wp-admin') || r.route === '/.env'), 'los sondeos no entran en la tabla de endpoints');
    assert.ok(routes.some(r => r.route === '/rv1/this-route-does-not-exist' && r.handler === null), 'las rutas de la API inexistentes sí');

    const stats = (await req(base, 'GET', '/api/stats?range=all')).json;
    assert.ok(stats.totals.p50 != null && stats.totals.p95 >= stats.totals.p50 && stats.totals.p99 >= stats.totals.p95);

    const rel = (await req(base, 'GET', '/api/releases?range=all')).json.releases;
    assert.equal(rel[0].version, 'v812');
    assert.ok(rel[0].newIssues >= 5);
    assert.ok(rel[0].after.requests >= 1);
    assert.ok('ai_title' in rel[0].issues[0]);

    const cfg = (await req(base, 'GET', '/api/config')).json;
    assert.equal(cfg.ingest.herokuApiTokenConfigured, true);
    assert.equal(cfg.routes, 5);
    assert.doesNotMatch(JSON.stringify(cfg), /secreto-que-no-debe-salir/);
});
