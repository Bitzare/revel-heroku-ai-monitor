'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, parseLogplexFrames, urlPath } = require('../src/pipeline/parse');

test('línea del router de Heroku', () => {
    const ev = parseLine('2026-10-08T14:07:04.410064+00:00 heroku[router]: at=info method=GET path="/rv1/profile?x=1" host=api.revel.cool request_id=a8eb dyno=web.1 connect=0ms service=468ms status=200 bytes=2571');
    assert.equal(ev.kind, 'router');
    assert.equal(ev.method, 'GET');
    assert.equal(ev.path, '/rv1/profile');
    assert.equal(ev.status, 200);
    assert.equal(ev.serviceMs, 468);
    assert.equal(ev.dyno, 'web.1');
    assert.equal(ev.requestId, 'a8eb');
});

test('error del router con código H12', () => {
    const ev = parseLine('2026-10-08T10:00:05.000000+00:00 heroku[router]: at=error code=H12 desc="Request timeout" method=GET path="/rv1/x" dyno=web.1 service=30000ms status=503');
    assert.equal(ev.routerCode, 'H12');
    assert.equal(ev.status, 503);
});

test('[EndPoint] con colores ANSI, con y sin el carácter ESC', () => {
    for (const esc of ['\x1b', '']) {
        const ev = parseLine(`2026-10-08T14:08:40.779379+00:00 app[web.1]: [EndPoint] 2026/10/08 14:08:40 ${esc}[32m GET ${esc}[0m https://api.revel.cool/admin/v1/clubs/9? ${esc}[31m (401) ${esc}[0m`);
        assert.equal(ev.kind, 'endpoint');
        assert.equal(ev.method, 'GET');
        assert.equal(ev.path, '/admin/v1/clubs/9');
        assert.equal(ev.status, 401);
    }
});

test('línea de error de la app con función, file:line y user_id', () => {
    const ev = parseLine('2026-10-08T10:00:02.000100+00:00 app[web.1]: 2026/10/08 10:00:02 [GetClubPaymentTypes] Failed to validate session user_id=42: not authorized: /handlers/sessions/tokens.go:106 -> no token available');
    assert.equal(ev.kind, 'app');
    assert.equal(ev.func, 'GetClubPaymentTypes');
    assert.equal(ev.codeFile, 'handlers/sessions/tokens.go');
    assert.equal(ev.codeLine, 106);
    assert.equal(ev.userId, '42');
    assert.match(ev.message, /^Failed to validate session/);
});

test('ruido: cors y cabeceras de fecha del logger', () => {
    assert.equal(parseLine('2026-10-08T14:08:40.512005+00:00 app[web.1]: [cors] 2026/10/08 14:08:40 Handler: Actual request').kind, 'noise');
    assert.equal(parseLine('2026/10/07 09:23:40 ------- 2026-10-07 -------').kind, 'noise');
});

test('formato de fichero local del backend (sin prefijo de Heroku)', () => {
    const ev = parseLine('2026/10/07 12:30:21 [GetClubPaymentTypes] Failed to validate session: x');
    assert.equal(ev.kind, 'app');
    assert.equal(ev.dyno, 'local');
    assert.equal(ev.func, 'GetClubPaymentTypes');
});

test('deploys y eventos de plataforma', () => {
    const rel = parseLine('2026-10-08T10:00:00.100000+00:00 app[api]: Release v812 created by user dev@example.com');
    assert.equal(rel.kind, 'release');
    assert.equal(rel.release, 'v812');
    assert.equal(parseLine('2026-10-08T10:00:00.100000+00:00 app[api]: Log session created by user x').kind, 'info');
    const r14 = parseLine('2026-10-08T10:00:06.000000+00:00 heroku[web.1]: Error R14 (Memory quota exceeded)');
    assert.equal(r14.kind, 'platform');
    assert.equal(r14.routerCode, 'R14');
});

test('tramas de Logplex con longitud en bytes (tildes y emoji incluidos)', () => {
    const msgs = [
        '<190>1 2026-10-08T10:00:00.000000+00:00 host app web.1 - Café ☕ falló',
        '<158>1 2026-10-08T10:00:01.000000+00:00 host heroku router - at=info method=GET path="/" status=200',
    ];
    const body = msgs.map(m => `${Buffer.byteLength(m)} ${m}`).join('');
    const frames = parseLogplexFrames(Buffer.from(body));
    assert.deepEqual(frames, msgs);
    const ev = parseLine(frames[1]);
    assert.equal(ev.kind, 'router');
    assert.equal(parseLine(frames[0]).message, 'Café ☕ falló');
});

test('urlPath quita esquema, host y query', () => {
    assert.equal(urlPath('https://api.revel.cool/rv1/x?y=1'), '/rv1/x');
    assert.equal(urlPath('/a/b?c'), '/a/b');
    assert.equal(urlPath('https://host'), '/');
});
