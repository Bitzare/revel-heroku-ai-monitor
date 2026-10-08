'use strict';
// Cliente mínimo de Ollama: /api/chat con salida estructurada (JSON Schema),
// sin "thinking", con timeout real (AbortController) y reintentos con backoff.

class OllamaClient {
    constructor({ url, model, numCtx = 16384, timeoutMs = 180000 }) {
        this.url = url; this.model = model; this.numCtx = numCtx; this.timeoutMs = timeoutMs;
        this.status = { ok: null, checkedAt: null, error: null, modelPresent: null };
    }

    async health() {
        try {
            const res = await fetchWithTimeout(`${this.url}/api/tags`, {}, 4000);
            const data = await res.json();
            const names = (data.models || []).map(m => m.name);
            this.status = { ok: true, checkedAt: new Date().toISOString(), error: null, modelPresent: names.includes(this.model) || names.includes(`${this.model}:latest`) };
            if (!this.status.modelPresent) this.status.error = `El modelo ${this.model} no está descargado (ollama pull ${this.model})`;
        } catch (e) {
            this.status = { ok: false, checkedAt: new Date().toISOString(), error: `Ollama no responde en ${this.url}: ${e.message}`, modelPresent: null };
        }
        return this.status;
    }

    /**
     * @param {Array<{role:string, content:string}>} messages
     * @param {object} schema JSON Schema de la respuesta
     */
    async chatJson(messages, schema, { retries = 2, temperature = 0.1 } = {}) {
        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const res = await fetchWithTimeout(`${this.url}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: this.model, messages, stream: false, think: false, format: schema,
                        keep_alive: '30m',
                        options: { temperature, num_ctx: this.numCtx },
                    }),
                }, this.timeoutMs);
                if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
                const data = await res.json();
                const content = data.message && data.message.content;
                const parsed = parseJsonLoose(content);
                if (!parsed) throw new Error('Respuesta del modelo sin JSON válido');
                return { data: parsed, meta: { evalCount: data.eval_count, promptTokens: data.prompt_eval_count, durationMs: Math.round((data.total_duration || 0) / 1e6) } };
            } catch (e) {
                lastErr = e;
                if (attempt < retries) await sleep(1500 * (attempt + 1));
            }
        }
        throw lastErr;
    }
}

function parseJsonLoose(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { /* sigue */ }
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a !== -1 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* nada */ } }
    return null;
}

async function fetchWithTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(new Error(`timeout tras ${ms} ms`)), ms);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { OllamaClient, parseJsonLoose };
