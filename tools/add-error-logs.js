#!/usr/bin/env node
'use strict';
// Busca bloques `if err != nil {` del backend Go que no registran el error y
// propone (o inserta, con --apply) un log.Printf("[Func] Failed to ...: %v\n", err)
// generado por el modelo local. Es la versión mantenida de refactor_logs.js:
// multiplataforma, en modo prueba por defecto y sin tocar ficheros sin --apply.
//
//   node tools/add-error-logs.js                  # informe de lo que haría (handlers/)
//   node tools/add-error-logs.js --dir services   # otro subdirectorio
//   node tools/add-error-logs.js --apply          # escribe los cambios (revisa el diff y compila tú)
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { OllamaClient } = require('../src/ai/ollama');

const FUNC_RE = /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)/;
const IF_ERR_RE = /^\s*if\s+err\s*!=\s*nil\s*\{\s*$/;
const HAS_LOG_RE = /\blog\.(Print|Fatal|Panic)|logs\.Log\.|fmt\.Fprint(f|ln)?\(os\.Stderr/;
const SCHEMA = { type: 'object', properties: { line: { type: 'string' } }, required: ['line'] };

function args() {
    const a = process.argv.slice(2);
    const get = k => { const i = a.indexOf(k); return i !== -1 ? a[i + 1] : null; };
    return { apply: a.includes('--apply'), dir: get('--dir') || 'handlers', limit: Number(get('--limit')) || Infinity };
}

function* goFiles(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['vendor', '.git', 'node_modules'].includes(e.name)) yield* goFiles(full); }
        else if (e.name.endsWith('.go') && !e.name.endsWith('_test.go')) yield full;
    }
}

async function main() {
    const opt = args();
    const cfg = config.load();
    const root = path.join(cfg.backendPath, opt.dir);
    if (!fs.existsSync(root)) { console.error(`No existe ${root} (ajusta BACKEND_PATH o --dir)`); process.exit(1); }
    const client = new OllamaClient({ url: cfg.ollamaUrl, model: cfg.model, numCtx: 4096, timeoutMs: 60000 });
    const h = await client.health();
    if (!h.ok || !h.modelPresent) { console.error(h.error); process.exit(1); }

    console.log(`${opt.apply ? '✍️  Aplicando' : '🔎 Modo prueba (usa --apply para escribir)'} en ${root} con ${cfg.model}\n`);
    let found = 0, written = 0;
    for (const file of goFiles(root)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        let fn = 'Unknown', changed = false;
        for (let i = 0; i < lines.length && found < opt.limit; i++) {
            const fm = lines[i].match(FUNC_RE);
            if (fm) fn = fm[1];
            if (!IF_ERR_RE.test(lines[i])) continue;
            // ¿El bloque ya registra el error?
            let logged = false;
            for (let j = i + 1, depth = 1; j < lines.length && depth > 0; j++) {
                depth += (lines[j].match(/{/g) || []).length - (lines[j].match(/}/g) || []).length;
                if (HAS_LOG_RE.test(lines[j])) { logged = true; break; }
            }
            if (logged) continue;
            let k = i - 1; while (k > 0 && !lines[k].trim()) k--;
            const action = lines[k].trim();
            found++;
            const rel = path.relative(cfg.backendPath, file).split(path.sep).join('/');
            try {
                const { data } = await client.chatJson([{ role: 'user', content:
                    `Escribe UNA línea de Go que registre el error con log.Printf. Formato exacto:\nlog.Printf("[${fn}] Failed to <acción en inglés deducida>: %v\\n", err)\nFunción: ${fn}\nLínea que falló: ${action}\nDevuelve solo la línea en "line".` }], SCHEMA, { retries: 1, temperature: 0 });
                const line = String(data.line || '').trim();
                if (!line.startsWith(`log.Printf("[${fn}]`) || !line.endsWith(', err)')) { console.log(`  ⚠️  ${rel}:${i + 1} respuesta descartada: ${line}`); continue; }
                const indent = lines[i].match(/^\s*/)[0] + '\t';
                console.log(`  ${rel}:${i + 1}  ${line}`);
                if (opt.apply) { lines.splice(i + 1, 0, indent + line); i++; changed = true; written++; }
            } catch (e) { console.log(`  ❌ ${rel}:${i + 1} ${e.message}`); }
        }
        if (changed) fs.writeFileSync(file, lines.join('\n'));
    }
    console.log(`\n${found} bloques sin log${opt.apply ? `, ${written} líneas insertadas. Revisa el diff y compila antes de commitear.` : '.'}`);
}

main().catch(e => { console.error(e); process.exit(1); });
