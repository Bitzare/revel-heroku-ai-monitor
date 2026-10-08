'use strict';
// Fuentes de logs. Todas acaban llamando a pipeline.ingest(línea, nombreFuente).
//  - heroku-api: log-session con tail=true contra la Platform API (solo necesita un token
//    de lectura; no hace falta la CLI, funciona igual en Linux/Windows/VM).
//  - heroku-cli: `heroku logs --tail` como antes, pero con reconexión.
//  - replay:     reproduce un fichero (logs de Heroku guardados o logs/log-*.log del backend).
// El drain de Logplex y el webhook de n8n entran por HTTP (ver server/http.js).
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');

class SourceStatus {
    constructor(name, label) {
        this.name = name; this.label = label;
        this.state = 'idle'; this.since = new Date().toISOString(); this.lastLine = null; this.lines = 0; this.error = null; this.reconnects = 0;
    }
    set(state, error = null) { this.state = state; this.error = error; this.since = new Date().toISOString(); }
    hit() { this.lines++; this.lastLine = new Date().toISOString(); }
}

function backoff(attempt) { return Math.min(60000, 2000 * 2 ** Math.min(attempt, 5)); }

class HerokuApiSource {
    constructor({ app, token, onLine, log = console }) {
        this.app = app; this.token = token; this.onLine = onLine; this.log = log;
        this.status = new SourceStatus('heroku-api', `Heroku API (${app})`);
        this.stopped = false; this.attempt = 0; this.ctrl = null;
    }
    start() { this._loop(); return this; }
    stop() { this.stopped = true; if (this.ctrl) this.ctrl.abort(); this.status.set('stopped'); }

    async _loop() {
        while (!this.stopped) {
            try {
                this.status.set('connecting');
                const res = await fetch(`https://api.heroku.com/apps/${encodeURIComponent(this.app)}/log-sessions`, {
                    method: 'POST',
                    headers: { Accept: 'application/vnd.heroku+json; version=3', Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
                    // lines=200 al reconectar rellena el hueco; el dedupe del pipeline descarta lo repetido.
                    body: JSON.stringify({ tail: true, lines: 200 }),
                });
                if (!res.ok) throw new Error(`log-session HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
                const { logplex_url: url } = await res.json();
                this.ctrl = new AbortController();
                const stream = await fetch(url, { signal: this.ctrl.signal });
                if (!stream.ok || !stream.body) throw new Error(`logplex HTTP ${stream.status}`);
                this.status.set('live'); this.attempt = 0;
                const decoder = new TextDecoder();
                let buf = '';
                for await (const chunk of stream.body) {
                    buf += decoder.decode(chunk, { stream: true });
                    let nl;
                    while ((nl = buf.indexOf('\n')) !== -1) {
                        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
                        if (line.trim()) { this.status.hit(); this.onLine(line, this.status.name); }
                    }
                }
                if (!this.stopped) this.status.set('reconnecting', 'La sesión de logs terminó');
            } catch (e) {
                if (this.stopped) break;
                const auth = /HTTP 401|HTTP 403/.test(e.message);
                this.status.set(auth ? 'error' : 'reconnecting', auth ? 'Token de Heroku inválido o sin permisos sobre la app' : e.message);
                if (auth) return; // no tiene sentido reintentar con un token malo
            }
            this.status.reconnects++;
            await new Promise(r => setTimeout(r, backoff(this.attempt++)));
        }
    }
}

class HerokuCliSource {
    constructor({ app, bin = 'heroku', onLine, log = console }) {
        this.app = app; this.bin = bin; this.onLine = onLine; this.log = log;
        this.status = new SourceStatus('heroku-cli', `Heroku CLI (${app})`);
        this.stopped = false; this.attempt = 0; this.child = null;
    }
    start() { this._spawn(); return this; }
    stop() { this.stopped = true; if (this.child) this.child.kill(); this.status.set('stopped'); }

    _spawn() {
        if (this.stopped) return;
        this.status.set('connecting');
        let stderr = '';
        // En Windows "heroku" es un .cmd: hace falta shell para resolverlo.
        const child = spawn(this.bin, ['logs', '--tail', '--num', '200', '--app', this.app], { shell: process.platform === 'win32', windowsHide: true });
        this.child = child;
        child.on('error', e => { this.status.set('error', e.code === 'ENOENT' ? `No se encuentra "${this.bin}". Instala la Heroku CLI o usa HEROKU_API_TOKEN.` : e.message); });
        child.stderr.on('data', d => { stderr = (stderr + d).slice(-500); });
        readline.createInterface({ input: child.stdout }).on('line', line => {
            if (this.status.state !== 'live') { this.status.set('live'); this.attempt = 0; }
            this.status.hit(); this.onLine(line, this.status.name);
        });
        child.on('close', code => {
            this.child = null;
            if (this.stopped) return;
            const needLogin = /login|credentials|401|Invalid credentials/i.test(stderr);
            this.status.set(needLogin ? 'error' : 'reconnecting', needLogin ? 'La Heroku CLI no tiene sesión: ejecuta "heroku login"' : `heroku logs terminó (código ${code}) ${stderr.trim().split('\n').pop() || ''}`.trim());
            if (this.status.error && /ENOENT|No se encuentra/.test(this.status.error)) return;
            this.status.reconnects++;
            setTimeout(() => this._spawn(), backoff(this.attempt++));
        });
    }
}

class ReplaySource {
    constructor({ file, onLine, speed = 0, onDone }) {
        this.file = file; this.onLine = onLine; this.speed = speed; this.onDone = onDone;
        this.status = new SourceStatus('replay', `Fichero ${require('path').basename(file)}`);
    }
    start() {
        this.status.set('live');
        const rl = readline.createInterface({ input: fs.createReadStream(this.file) });
        rl.on('line', l => { this.status.hit(); this.onLine(l, 'replay'); });
        rl.on('close', () => { this.status.set('done'); if (this.onDone) this.onDone(); });
        return this;
    }
    stop() {}
}

/** Estado de las fuentes que llegan por HTTP (drain y n8n): se "encienden" al recibir datos. */
class PassiveSource {
    constructor(name, label) { this.status = new SourceStatus(name, label); }
    hit(n = 1) { for (let i = 0; i < n; i++) this.status.hit(); if (this.status.state !== 'live') this.status.set('live'); }
    stop() {}
}

module.exports = { HerokuApiSource, HerokuCliSource, ReplaySource, PassiveSource, SourceStatus };
