'use strict';
const path = require('path');
const fs = require('fs');
const config = require('../src/config');

const FIXTURES = path.join(__dirname, 'fixtures');
const BACKEND = path.join(FIXTURES, 'backend');

function testConfig(overrides = {}) {
    return config.load({
        dbFile: ':memory:', backendPath: BACKEND, port: 0, host: '127.0.0.1', sources: ['none'],
        aiEnabled: true, autofixMode: 'off', ingestToken: '', n8nWebhookUrl: '', ...overrides,
    });
}

function fixtureLines(name) {
    return fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter(Boolean);
}

/** Ollama falso: devuelve respuestas predefinidas y registra los prompts. */
class FakeClient {
    constructor(responder) {
        this.model = 'fake-model';
        this.calls = [];
        this.responder = responder || (() => ({}));
        this.status = { ok: true, modelPresent: true, error: null };
    }
    async health() { return this.status; }
    async chatJson(messages, schema) {
        this.calls.push({ messages, schema });
        const data = await this.responder(messages, schema, this.calls.length);
        return { data, meta: { durationMs: 5, evalCount: 10, promptTokens: 20 } };
    }
}

module.exports = { testConfig, fixtureLines, FakeClient, BACKEND, FIXTURES };
