'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('../src/store/db');
const { Pipeline } = require('../src/pipeline/pipeline');
const { CodeIndex } = require('../src/code/index');
const { loadRoutes } = require('../src/code/routes');
const { Analyzer } = require('../src/ai/analyzer');
const { AutoFix, unifiedDiff, addMissingImports } = require('../src/ai/autofix');
const { parseJsonLoose } = require('../src/ai/ollama');
const { testConfig, fixtureLines, FakeClient, BACKEND } = require('./helpers');

const GOOD = {
    title: 'Falta manejar sql.ErrNoRows', summary: 's', root_cause: 'rc',
    exact_error: 'sql: no rows in result set', kind: 'backend_bug', severity: 'medium',
    location: { file: 'handlers/clubs/clubs.go', function: 'GetIsFederatedClub', line: 15 },
    fix: 'f', fix_steps: ['a', 'b'], confidence: 0.9,
};

function setup(responder, cfgOver = {}, backend = BACKEND) {
    const cfg = testConfig({ backendPath: backend, ...cfgOver });
    const store = new Store(':memory:');
    const code = new CodeIndex(backend).build();
    const pipeline = new Pipeline({ store, routes: loadRoutes(backend, cfg), code, cfg });
    const client = new FakeClient(responder);
    const autofix = new AutoFix({ code, client, cfg });
    const analyzer = new Analyzer({ store, code, client, cfg, autofix });
    return { cfg, store, code, pipeline, client, analyzer };
}

const federatedLines = [
    '2026-10-08T10:00:00.000000+00:00 app[web.1]: 2026/10/08 10:00:00 [GetIsFederatedClub] Failed to get federation info: sql: no rows in result set',
    '2026-10-08T10:00:00.001000+00:00 heroku[router]: at=info method=GET path="/admin/v1/clubs/3/is-federated" dyno=web.1 service=40ms status=400',
];

function ingest(pipeline, lines) { for (const l of lines) pipeline.ingest(l, 't'); pipeline.flush(); }

test('el prompt incluye evidencias y el handler exacto de la ruta', async () => {
    const { store, pipeline, analyzer, client } = setup(() => GOOD);
    ingest(pipeline, federatedLines);
    const [issue] = store.listIssues({ state: 'all' });
    await analyzer._analyze(issue.id);
    const prompt = client.calls[0].messages[1].content;
    assert.match(prompt, /sql: no rows in result set/);
    assert.match(prompt, /func GetIsFederatedClub/);
    assert.match(prompt, /handlers\/clubs\/clubs\.go/);
    const done = store.getIssue(issue.id);
    assert.equal(done.analysis_state, 'done');
    assert.equal(done.analysis.grounded, true);
    assert.equal(done.analysis.location.function, 'GetIsFederatedClub');
});

test('grounding: error inventado y fichero inexistente bajan la confianza', async () => {
    const { store, pipeline, analyzer } = setup(() => ({ ...GOOD, exact_error: 'kafka consumer exploded badly', location: { file: 'nope/x.go', function: 'Nope', line: 3 } }));
    ingest(pipeline, federatedLines);
    const [issue] = store.listIssues({ state: 'all' });
    await analyzer._analyze(issue.id);
    const a = store.getIssue(issue.id).analysis;
    assert.equal(a.grounded, false);
    assert.ok(a.confidence <= 0.35);
    assert.ok(a.flags.includes('error_no_literal'));
    assert.ok(a.flags.includes('fichero_inventado'));
    // Se recupera la ubicación deducida de la ruta
    assert.equal(a.location.function, 'GetIsFederatedClub');
    assert.equal(a.location.inferred, true);
});

test('la cola omite lo esperado/ruido y prioriza por severidad', () => {
    const { store, pipeline, analyzer } = setup(() => GOOD);
    ingest(pipeline, fixtureLines('heroku_mixed.log'));
    const issues = store.listIssues({ state: 'all', includeNoise: true });
    const threat = issues.find(i => i.category === 'threat');
    const auth = issues.find(i => i.category === 'auth');
    const panic = issues.find(i => i.category === 'panic');
    assert.equal(analyzer.shouldAnalyze(threat), false);
    assert.equal(analyzer.shouldAnalyze(auth), false);
    assert.equal(analyzer.shouldAnalyze(panic), true);
});

test('un fallo del modelo deja la incidencia en "failed" con el motivo', async () => {
    const { store, pipeline, analyzer } = setup(() => { throw new Error('ollama caído'); });
    ingest(pipeline, federatedLines);
    const [issue] = store.listIssues({ state: 'all' });
    await assert.rejects(analyzer._analyze(issue.id));
    const after = store.getIssue(issue.id);
    assert.equal(after.analysis_state, 'failed');
    assert.match(after.analysis_error, /ollama caído/);
});

test('autofix en modo branch: crea la rama sin tocar el working tree ni la rama actual', async (t) => {
    // Copia del backend de fixture en un repo git temporal
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimon-be-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.cpSync(BACKEND, dir, { recursive: true });
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    const before = fs.readFileSync(path.join(dir, 'handlers/clubs/clubs.go'), 'utf8');

    const fixed = `func GetIsFederatedClub(w http.ResponseWriter, req *http.Request, pm httprouter.Params) {
	_, err := lookup()
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			w.WriteHeader(http.StatusOK)
			return
		}
		log.Printf("[GetIsFederatedClub] Failed to get federation info: %v\\n", err)
		w.WriteHeader(http.StatusBadRequest)
		return
	}
}`;
    const { store, pipeline, analyzer } = setup((msgs, schema) => (schema.properties.replacement ? { replacement: fixed, explanation: 'maneja ErrNoRows' } : GOOD), { autofixMode: 'branch' }, dir);
    ingest(pipeline, federatedLines);
    const [issue] = store.listIssues({ state: 'all' });
    await analyzer._analyze(issue.id);
    const done = store.getIssue(issue.id);
    assert.ok(done.patch, `no hay parche: ${done.analysis_error}`);
    assert.match(done.patch, /\+\t\tif errors\.Is\(err, sql\.ErrNoRows\)/);
    assert.match(done.patch, /Imports añadidos: errors, database\/sql/);
    assert.ok(done.patch_branch && done.patch_branch.startsWith('ai-fix/'));

    // Working tree intacto y seguimos en main
    assert.equal(fs.readFileSync(path.join(dir, 'handlers/clubs/clubs.go'), 'utf8'), before);
    assert.equal(git('branch', '--show-current'), 'main');
    assert.equal(git('status', '--porcelain'), '');
    // La rama tiene el cambio
    const onBranch = git('show', `${done.patch_branch}:handlers/clubs/clubs.go`);
    assert.match(onBranch, /sql\.ErrNoRows/);
    assert.match(onBranch, /"database\/sql"/);

    // El diff se aplica limpio con git apply
    const diff = done.patch.split('\n').filter(l => !l.startsWith('# ')).join('\n');
    fs.writeFileSync(path.join(dir, 'p.diff'), diff);
    git('apply', '--check', 'p.diff');
});

test('autofix rechaza parches que cambian la firma', async () => {
    const { store, pipeline, analyzer } = setup((msgs, schema) => (schema.properties.replacement
        ? { replacement: 'func GetIsFederatedClub(x int) {}', explanation: '' } : GOOD), { autofixMode: 'suggest' });
    ingest(pipeline, federatedLines);
    const [issue] = store.listIssues({ state: 'all' });
    await analyzer._analyze(issue.id);
    const done = store.getIssue(issue.id);
    assert.equal(done.patch, null);
    assert.match(done.analysis_error, /firma/);
});

test('unifiedDiff genera hunks separados', () => {
    const a = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n');
    const b = a.replace('l2\n', 'l2\nNEW\n').replace('l30', 'l30x');
    const d = unifiedDiff('f', a, b);
    assert.equal((d.match(/^@@/gm) || []).length, 2);
    assert.match(d, /^@@ -1,6 \+1,7 @@/m);
});

test('addMissingImports añade solo lo que falta', () => {
    const src = 'package x\n\nimport (\n\t"errors"\n)\n\nfunc f() { errors.Is(nil, sql.ErrNoRows); s := "fmt.X" }\n';
    const { added, src: out } = addMissingImports(src);
    assert.deepEqual(added, ['database/sql']);
    assert.match(out, /"database\/sql"/);
});

test('parseJsonLoose tolera texto alrededor del JSON', () => {
    assert.deepEqual(parseJsonLoose('bla {"a":1} bla'), { a: 1 });
    assert.equal(parseJsonLoose('nada'), null);
});

test('AI_LANGUAGE cambia el idioma pedido al modelo', async () => {
    const { systemPrompt } = require('../src/ai/analyzer');
    assert.match(systemPrompt('en'), /inglés \(English\)/);
    assert.match(systemPrompt('es'), /SIEMPRE en español/);
    const { store, pipeline, analyzer, client } = setup(() => GOOD, { aiLanguage: 'en' });
    ingest(pipeline, federatedLines);
    const [issue] = store.listIssues({ state: 'all' });
    await analyzer._analyze(issue.id);
    assert.match(client.calls[0].messages[0].content, /English/);
});

test('explicaciones de varias líneas no rompen el diff', () => {
    const { explanationLines } = require('../src/ai/autofix');
    const lines = explanationLines('Cambia el manejo de error.\n1. Paso uno\nAntes:\n```go\nfunc x() {}\n```\nFin.');
    assert.deepEqual(lines, ['Cambia el manejo de error.', '1. Paso uno', 'Antes:', 'Fin.']);
    assert.ok(lines.every((l) => !l.includes('func x')));
});

test('las notas del parche quedan en texto plano', () => {
    const { explanationLines } = require('../src/ai/autofix');
    assert.deepEqual(explanationLines('1. **Inspección**: algo\n* viñeta'), ['1. Inspección: algo', '• viñeta']);
});
