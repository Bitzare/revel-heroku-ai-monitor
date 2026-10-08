'use strict';
// Alertas salientes: POST a un webhook de n8n con la incidencia ya diagnosticada.
// El workflow de ejemplo (n8n/monitor-to-slack.json) la enriquece con nombre/email
// de los usuarios afectados (consulta a Users como el monitor de pagos) y avisa a Slack.
const { sevRank } = require('../config');

class N8nNotifier {
    constructor({ url, token, minSeverity = 'high', publicUrl, log = console }) {
        this.url = url; this.token = token; this.minSeverity = minSeverity; this.publicUrl = publicUrl; this.log = log;
        this.sent = 0; this.failed = 0; this.lastError = null; this.lastSent = new Map(); // issueId → ms
    }
    get enabled() { return !!this.url; }

    /** Decide si avisar: incidencia nueva, reabierta o con pico, y nunca más de una vez cada 30 min. */
    shouldAlert(issue, { isNew, reopened, spiking, analyzed }) {
        if (!this.enabled || issue.state === 'ignored' || issue.expected) return false;
        if (sevRank(issue.severity) < sevRank(this.minSeverity)) return false;
        const last = this.lastSent.get(issue.id) || (issue.alerted_at ? Date.parse(issue.alerted_at) : 0);
        if (Date.now() - last < 30 * 60000 && !reopened) return false;
        return isNew || reopened || spiking || analyzed;
    }

    async send(issue, reason) {
        const a = issue.analysis && typeof issue.analysis === 'object' ? issue.analysis : null;
        const body = {
            source: 'revel-ai-ops-monitor',
            reason,
            issue: {
                id: issue.id, title: a?.title || issue.title, severity: issue.severity, category: issue.category,
                route: issue.route ? `${issue.method} ${issue.route}` : null, status: issue.status_code,
                count: issue.count, firstSeen: issue.first_seen, lastSeen: issue.last_seen,
                regression: !!issue.regression, afterRelease: issue.after_release, spike: !!issue.spike,
                url: this.publicUrl ? `${this.publicUrl}/#/issues/${issue.id}` : null,
            },
            diagnosis: a ? { summary: a.summary, rootCause: a.root_cause, fix: a.fix, confidence: a.confidence, kind: a.kind, location: a.location } : null,
            userIds: Array.isArray(issue.user_ids) ? issue.user_ids : [],
        };
        try {
            const res = await fetch(this.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(this.token ? { 'X-Monitor-Token': this.token } : {}) },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this.sent++; this.lastError = null; this.lastSent.set(issue.id, Date.now());
            return true;
        } catch (e) {
            this.failed++; this.lastError = e.message;
            this.log.warn(`[n8n] No se pudo enviar la alerta de #${issue.id}: ${e.message}`);
            return false;
        }
    }

    status() { return { enabled: this.enabled, sent: this.sent, failed: this.failed, lastError: this.lastError, minSeverity: this.minSeverity }; }
}

module.exports = { N8nNotifier };
