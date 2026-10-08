'use strict';
/* Revel Guardia: cliente del dashboard. Sin frameworks ni dependencias externas. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
// Texto del modelo: escapa y convierte `código` en <code>.
const rich = v => esc(v).replace(/`([^`\n]{1,160})`/g, '<code>$1</code>');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SEV_LABEL = { critical: 'Crítica', high: 'Alta', medium: 'Media', low: 'Baja', noise: 'Ruido' };
const STATE_LABEL = { open: 'Abierta', ack: 'Reconocida', resolved: 'Resuelta', ignored: 'Ignorada' };
const KIND_LABEL = {
    backend_bug: 'Bug del backend', client_error: 'Error del cliente', expected: 'Comportamiento esperado',
    infrastructure: 'Infraestructura', data: 'Datos inconsistentes', configuration: 'Configuración', attack: 'Ataque o abuso',
};
const FLAG_LABEL = {
    error_no_literal: 'El error citado no aparece literalmente en los logs',
    fichero_inventado: 'El modelo citó un fichero que no existe en el backend',
    funcion_no_encontrada: 'La función citada no está en el índice de código',
};
const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'noise'];

const S = {
    tab: 'issues', meta: { categories: {} }, health: null,
    issues: [], selectedId: null, detail: null,
    f: { state: 'active', range: '24h', q: '', noise: false, category: null },
    pulse: [], pulseWin: 15, releases: [], tail: [], livePaused: false, liveFilter: '',
    vitals: null,
};

// ------------------------------------------------------------------ util
async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-AIMON': '1', ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}
function ago(iso) {
    if (!iso) return '';
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (s < 0) return 'ahora';
    if (s < 60) return `hace ${s} s`;
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
    return `hace ${Math.round(s / 86400)} d`;
}
function clock(iso, withDate = false) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const t = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: withDate ? undefined : '2-digit' });
    return withDate ? `${d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}, ${t}` : t;
}
const fmtN = n => (n == null ? '—' : Number(n).toLocaleString('es-ES'));
const fmtPct = n => (n == null ? '—' : `${(n * 100).toLocaleString('es-ES', { maximumFractionDigits: n < 0.01 ? 2 : 1 })} %`);
function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ------------------------------------------------------------------ router
function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [tab, id] = h.split('/');
    S.tab = ['issues', 'live', 'sources'].includes(tab) ? tab : 'issues';
    for (const v of $$('.view')) v.hidden = v.id !== `view-${S.tab}`;
    $$('.tabs a').forEach(a => { if (a.dataset.tab === S.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (S.tab === 'issues' && id && Number(id) !== S.selectedId) selectIssue(Number(id), false);
    if (S.tab === 'live') renderTail();
    if (S.tab === 'sources') renderSources();
}

// ------------------------------------------------------------------ veredicto y vitales
function renderVerdict() {
    const h = S.health;
    const el = $('#verdict');
    if (!h) return;
    el.dataset.s = h.status;
    let text;
    if (h.status === 'critical') {
        text = h.criticalOpen ? `${h.criticalOpen} ${h.criticalOpen === 1 ? 'incidencia crítica activa' : 'incidencias críticas activas'}` : `${fmtPct(h.window.errorRate)} de respuestas 5xx`;
    } else if (h.status === 'warning') {
        text = h.highOpen ? `${h.highOpen} ${h.highOpen === 1 ? 'incidencia grave en los últimos 15 min' : 'incidencias graves en los últimos 15 min'}` : 'Servicio degradado';
    } else if (h.status === 'ok') {
        text = 'Todo en calma';
    } else {
        text = 'Sin datos recientes: revisa las fuentes';
    }
    $('.verdict-text', el).textContent = text;
    $('#appName').textContent = `${h.app} en Heroku`;
    document.title = h.status === 'critical' ? `● ${text} · Revel Guardia` : 'Revel Guardia';
}

async function loadVitals() {
    try {
        let st = await api('/api/stats?range=1h');
        if (!st.totals.requests && st.latestTs) st = await api('/api/stats?range=1h&anchor=latest');
        S.vitals = st;
        S.releases = st.releases || [];
        renderVitals();
    } catch { /* el servidor puede estar reiniciándose */ }
}
function renderVitals() {
    const t = S.vitals ? S.vitals.totals : null;
    const active = S.issues.filter(i => i.state === 'open' || i.state === 'ack').length;
    const rate5 = t && t.requests ? t.err5 / t.requests : null;
    const items = [
        ['Peticiones en la última hora', fmtN(t && t.requests), ''],
        ['Respuestas 5xx', fmtPct(rate5), rate5 > 0.05 ? 'bad' : rate5 > 0.01 ? 'meh' : ''],
        ['Respuestas 4xx', fmtPct(t && t.requests ? t.err4 / t.requests : null), ''],
        ['Apdex (T = 500 ms)', t && t.apdex != null ? t.apdex.toLocaleString('es-ES', { maximumFractionDigits: 2 }) : '—', t && t.apdex < 0.7 ? 'bad' : t && t.apdex < 0.85 ? 'meh' : ''],
        ['Latencia media', t && t.avgMs != null ? `${fmtN(t.avgMs)} ms` : '—', ''],
        ['Incidencias activas', fmtN(active), ''],
    ];
    $('#vitals').innerHTML = items.map(([k, v, c]) => `<div><dt>${esc(k)}</dt><dd class="${c}">${esc(v)}</dd></div>`).join('');
}

// ------------------------------------------------------------------ pulso
const pulse = { canvas: null, ctx: null, w: 0, h: 150, hits: [], anchor: Date.now(), live: true };
function setupPulse() {
    pulse.canvas = $('#pulse');
    pulse.ctx = pulse.canvas.getContext('2d');
    const ro = new ResizeObserver(() => sizePulse());
    ro.observe(pulse.canvas);
    sizePulse();
    pulse.canvas.addEventListener('mousemove', pulseHover);
    pulse.canvas.addEventListener('mouseleave', () => { $('#pulseTip').hidden = true; });
    for (const b of $$('[data-pw]')) b.addEventListener('click', () => {
        S.pulseWin = Number(b.dataset.pw);
        $$('[data-pw]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        drawPulse();
    });
    setInterval(drawPulse, 1000);
}
function sizePulse() {
    const dpr = window.devicePixelRatio || 1;
    const r = pulse.canvas.getBoundingClientRect();
    pulse.w = r.width; pulse.h = r.height;
    pulse.canvas.width = Math.round(r.width * dpr); pulse.canvas.height = Math.round(r.height * dpr);
    pulse.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPulse();
}
function drawPulse() {
    const { ctx, w, h } = pulse;
    if (!ctx || !w) return;
    const win = S.pulseWin * 60000;
    const lastT = S.pulse.length ? S.pulse[S.pulse.length - 1].t : 0;
    // Si no hay tráfico reciente (p.ej. tras un replay de logs antiguos), anclamos al último dato.
    pulse.live = !lastT || Date.now() - lastT < win;
    pulse.anchor = pulse.live ? Date.now() : lastT + 5000;
    const start = pulse.anchor - win;
    const top = 16, axis = 20, base = Math.round((h - axis) * 0.64);
    const up = base - top, down = h - axis - base - 4;
    const C = { ok: cssVar('--ok'), warn: cssVar('--warn'), crit: cssVar('--crit'), info: cssVar('--info'), line: cssVar('--line'), faint: cssVar('--faint'), soft: cssVar('--line-soft') };
    const x = t => ((t - start) / win) * w;
    ctx.clearRect(0, 0, w, h);

    // rejilla temporal
    const stepMin = S.pulseWin <= 5 ? 1 : S.pulseWin <= 15 ? 3 : 10;
    ctx.font = `11px ${cssVar('--font-mono') || 'monospace'}`;
    ctx.textBaseline = 'alphabetic';
    const firstTick = Math.ceil(start / (stepMin * 60000)) * stepMin * 60000;
    for (let t = firstTick; t <= pulse.anchor; t += stepMin * 60000) {
        const xx = Math.round(x(t)) + 0.5;
        ctx.strokeStyle = C.soft; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xx, top - 6); ctx.lineTo(xx, h - axis); ctx.stroke();
        ctx.fillStyle = C.faint;
        const label = new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        const tw = ctx.measureText(label).width;
        if (xx - tw / 2 > 0 && xx + tw / 2 < w) ctx.fillText(label, xx - tw / 2, h - 5);
    }
    // línea base
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, base + 0.5); ctx.lineTo(w, base + 0.5); ctx.stroke();

    // deploys
    for (const r of S.releases) {
        const t = Date.parse(r.ts);
        if (t < start || t > pulse.anchor) continue;
        const xx = Math.round(x(t)) + 0.5;
        ctx.strokeStyle = C.info; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(xx, top - 8); ctx.lineTo(xx, h - axis); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = C.info; ctx.fillText(r.version || 'deploy', Math.min(xx + 4, w - 40), top - 4);
    }

    // peticiones
    pulse.hits = [];
    const logMax = Math.log10(1 + 10000);
    for (const r of S.pulse) {
        if (r.t < start) continue;
        const xx = x(r.t);
        let y0, y1, color;
        const bad5 = r.s >= 500 || r.h;
        if (bad5) { color = C.crit; y0 = base + 1; y1 = base + down; }
        else if (r.s >= 400) { color = C.warn; y0 = base + 1; y1 = base + down * 0.5; }
        else {
            const frac = r.ms == null ? 0.18 : Math.max(0.05, Math.min(1, Math.log10(1 + r.ms) / logMax));
            color = r.ms != null && r.ms >= 5000 ? C.warn : C.ok;
            y0 = base - 1; y1 = base - up * frac;
        }
        ctx.strokeStyle = color; ctx.globalAlpha = bad5 || r.s >= 400 ? 0.95 : 0.7; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(xx, y0); ctx.lineTo(xx, y1); ctx.stroke();
        pulse.hits.push({ x: xx, y: Math.min(y0, y1), r });
    }
    ctx.globalAlpha = 1;
    $('#pulseEmpty').hidden = S.pulse.length > 0;
    if (!pulse.live && S.pulse.length) {
        ctx.fillStyle = C.faint;
        const msg = `Sin tráfico nuevo: últimos datos ${ago(new Date(lastT).toISOString())}`;
        ctx.fillText(msg, w - ctx.measureText(msg).width - 4, top - 4);
    }
}
function pulseHover(e) {
    const r = pulse.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    let best = null, bd = 5;
    for (const hpt of pulse.hits) { const d = Math.abs(hpt.x - mx); if (d < bd || (d === bd && best && hpt.r.s > best.r.s)) { bd = d; best = hpt; } }
    const tip = $('#pulseTip');
    if (!best) { tip.hidden = true; return; }
    const q = best.r;
    tip.innerHTML = `<b>${esc(q.m || '')} ${esc(q.r || '')}</b> → ${esc(q.h || q.s)}${q.ms != null ? `, ${fmtN(q.ms)} ms` : ''}<br><span style="color:var(--muted)">${clock(new Date(q.t).toISOString())}</span>`;
    tip.style.left = `${Math.max(90, Math.min(r.width - 90, best.x))}px`;
    tip.style.top = `${Math.max(46, best.y - 6)}px`;
    tip.hidden = false;
}

// ------------------------------------------------------------------ lista de incidencias
async function loadIssues() {
    const p = new URLSearchParams({ state: S.f.state, range: S.f.range });
    if (S.f.q) p.set('q', S.f.q);
    if (S.f.noise) p.set('noise', '1');
    try {
        const { issues } = await api(`/api/issues?${p}`);
        S.issues = issues;
        renderIssues(); renderVitals();
        if (!S.selectedId && issues.length && S.tab === 'issues' && window.innerWidth > 1080) selectIssue(pickDefault(issues).id, false);
        if (!issues.length && !S.selectedId) renderDetail();
    } catch (e) { $('#issues').innerHTML = `<li class="empty"><strong>No se pudo cargar la lista</strong>${esc(e.message)}</li>`; }
}
function pickDefault(list) {
    return [...list].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || Date.parse(b.last_seen) - Date.parse(a.last_seen))[0];
}
function visibleIssues() { return S.f.category ? S.issues.filter(i => i.category === S.f.category) : S.issues; }

function renderCats() {
    const counts = {};
    for (const i of S.issues) counts[i.category] = (counts[i.category] || 0) + 1;
    const cats = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (S.f.category && !counts[S.f.category]) S.f.category = null;
    $('#cats').innerHTML = cats.length > 1 || S.f.category ? [
        `<button type="button" class="cat" data-cat="" aria-pressed="${!S.f.category}">Todas <b>${S.issues.length}</b></button>`,
        ...cats.map(([c, n]) => `<button type="button" class="cat" data-cat="${esc(c)}" aria-pressed="${S.f.category === c}">${esc(S.meta.categories[c] || c)} <b>${n}</b></button>`),
    ].join('') : '';
}
function issueTags(i) {
    const t = [];
    if (i.regression) t.push('<span class="tag reg">Regresión</span>');
    if (i.spike) t.push('<span class="tag spike">Pico</span>');
    if (i.after_release) t.push(`<span class="tag rel">Tras ${esc(i.after_release)}</span>`);
    if (i.analysis_state === 'done') t.push(`<span class="tag ai">${i.has_patch ? 'IA + parche' : 'Diagnosticada'}</span>`);
    else if (i.analysis_state === 'queued' || i.analysis_state === 'running') t.push('<span class="tag ai run">Analizando</span>');
    else if (i.analysis_state === 'failed') t.push('<span class="tag ai fail">IA falló</span>');
    if (i.state === 'ack') t.push('<span class="tag">Reconocida</span>');
    if (i.expected) t.push('<span class="tag">Esperado</span>');
    return t.join('');
}
function renderIssues() {
    renderCats();
    const list = visibleIssues();
    const el = $('#issues');
    if (!list.length) {
        const msg = S.f.state === 'active'
            ? '<strong>No hay incidencias activas</strong>Prueba con otro periodo o marca «Mostrar ruido» para ver 401 habituales y bots.'
            : '<strong>Nada por aquí</strong>Cambia los filtros para ver más.';
        el.innerHTML = `<li class="empty">${msg}</li>`;
        return;
    }
    el.innerHTML = list.map(i => `
        <li class="issue" role="option" tabindex="0" data-id="${i.id}" data-sev="${esc(i.severity)}" data-state="${esc(i.state)}" aria-selected="${i.id === S.selectedId}">
            <span class="rail"></span>
            <div class="issue-title">${rich(i.ai_title || i.title)}</div>
            <div class="issue-count">${fmtN(i.count)}<small>${i.count === 1 ? 'vez' : 'veces'}</small></div>
            <div class="issue-meta">
                <span class="sev sev-${esc(i.severity)}">${SEV_LABEL[i.severity] || i.severity}</span>
                <span>${esc(S.meta.categories[i.category] || i.category)}</span>
                <span title="${esc(clock(i.last_seen, true))}">${esc(ago(i.last_seen))}</span>
                ${i.users ? `<span>${i.users} ${i.users === 1 ? 'usuario' : 'usuarios'}</span>` : ''}
                ${issueTags(i)}
            </div>
        </li>`).join('');
}

// ------------------------------------------------------------------ detalle
async function selectIssue(id, push = true) {
    S.selectedId = id;
    $$('.issue').forEach(li => li.setAttribute('aria-selected', String(Number(li.dataset.id) === id)));
    if (push && location.hash !== `#/issues/${id}`) history.replaceState(null, '', `#/issues/${id}`);
    try {
        S.detail = await api(`/api/issues/${id}`);
        if (S.selectedId === id) renderDetail();
        if (window.innerWidth <= 1080 && push) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { $('#detail').innerHTML = `<div class="detail-empty"><h2>No se pudo abrir la incidencia</h2>${esc(e.message)}</div>`; }
}

function renderDetail() {
    const el = $('#detail');
    if (!S.detail || !S.selectedId) {
        el.innerHTML = `<div class="detail-empty"><h2>Elige una incidencia</h2>Verás aquí el diagnóstico, las líneas de log que la explican, el código implicado y el parche propuesto.</div>`;
        return;
    }
    const { issue: i, events, histogram } = S.detail;
    const a = i.analysis && typeof i.analysis === 'object' ? i.analysis : null;
    const aiTitle = a && a.title && a.title !== i.title ? a.title : null;
    const ev = events[0];
    const actions = [];
    if (i.state === 'open') actions.push('<button class="btn" data-act="ack">Reconocer</button>');
    if (i.state !== 'resolved') actions.push('<button class="btn primary" data-act="resolved">Marcar resuelta</button>');
    if (i.state !== 'ignored') actions.push('<button class="btn" data-act="ignored">Ignorar</button>');
    if (i.state === 'resolved' || i.state === 'ignored') actions.push('<button class="btn" data-act="open">Reabrir</button>');
    actions.push(`<button class="btn" data-act="analyze" ${i.analysis_state === 'queued' || i.analysis_state === 'running' ? 'disabled' : ''}>${a ? 'Volver a analizar' : 'Analizar con IA'}</button>`);

    el.innerHTML = `
        <div class="d-kicker">
            <span class="sev sev-${esc(i.severity)}">${SEV_LABEL[i.severity]}</span>
            <span>${esc(S.meta.categories[i.category] || i.category)}</span>
            <span>${esc(STATE_LABEL[i.state] || i.state)}</span>
            ${issueTags({ ...i, has_patch: !!i.patch, users: 0 })}
        </div>
        <h2 class="d-title">${rich(aiTitle || i.title)}</h2>
        ${aiTitle ? `<div class="d-route">${esc(i.title)}</div>` : ''}
        ${i.handler || i.func ? `<div class="d-route">${i.handler ? `Handler ${esc(i.handler)}${i.handler_dir ? ` en ${esc(i.handler_dir)}` : ''}` : `Función ${esc(i.func)}`}</div>` : ''}
        <div class="d-actions">${actions.join('')}</div>
        <dl class="d-facts">
            <div><dt>Ocurrencias</dt><dd>${fmtN(i.count)}</dd></div>
            <div><dt>Usuarios afectados</dt><dd>${fmtN((i.user_ids || []).length)}</dd></div>
            <div><dt>Primera vez</dt><dd title="${esc(i.first_seen)}">${esc(clock(i.first_seen, true))}</dd></div>
            <div><dt>Última vez</dt><dd title="${esc(i.last_seen)}">${esc(ago(i.last_seen))}</dd></div>
            ${i.after_release ? `<div><dt>Apareció tras</dt><dd>${esc(i.after_release)}</dd></div>` : ''}
        </dl>
        ${diagnosisHtml(i, a)}
        ${evidenceHtml(ev, a)}
        ${codeHtml(i, a)}
        ${patchHtml(i)}
        ${histHtml(histogram)}
        ${eventsHtml(events)}
    `;
}

function diagnosisHtml(i, a) {
    let body;
    if (i.analysis_state === 'queued' || i.analysis_state === 'running') {
        body = `<div class="ai-wait"><span class="spin"></span>${i.analysis_state === 'running' ? 'El modelo está leyendo los logs y el código…' : 'En cola para el análisis con IA.'}</div>`;
    } else if (a) {
        const c = a.confidence || 0;
        const cls = c >= 0.75 ? '' : c >= 0.45 ? 'mid' : 'low';
        body = `
            <p class="d-summary">${rich(a.summary)}</p>
            <p class="cause">${rich(a.root_cause)}</p>
            <h3 style="margin-top:18px">Cómo arreglarlo</h3>
            ${fixHtml(a)}
            <div class="conf" style="margin-top:14px">
                <span>${esc(KIND_LABEL[a.kind] || a.kind)}</span>
                <span class="conf-bar ${cls}" role="img" aria-label="Confianza ${Math.round(c * 100)} %"><i style="width:${Math.round(c * 100)}%"></i></span>
                <span>confianza ${Math.round(c * 100)} %</span>
                ${a.meta ? `<span>${esc(a.meta.model)}, ${(a.meta.durationMs / 1000).toFixed(1)} s</span>` : ''}
            </div>
            ${(a.flags || []).map(f => `<p class="flag">${esc(FLAG_LABEL[f] || f)}</p>`).join('')}
            ${i.analysis_error ? `<p class="flag">${esc(i.analysis_error)}</p>` : ''}`;
    } else if (i.analysis_state === 'failed') {
        body = `<p class="flag">El análisis falló: ${esc(i.analysis_error)}</p><p>Comprueba que Ollama está en marcha en la pestaña Fuentes y vuelve a intentarlo.</p>`;
    } else {
        const why = i.expected ? 'parece un comportamiento esperado' : i.severity === 'noise' || i.category === 'threat' ? 'es ruido de bots' : 'su severidad está por debajo del umbral de análisis automático';
        body = `<p>${esc(i.reason || '')}${i.reason ? '. ' : ''}No se analizó automáticamente porque ${why}. Pulsa «Analizar con IA» si quieres el diagnóstico igualmente.</p>`;
    }
    return `<section class="d-sec"><h3>Diagnóstico</h3>${body}</section>`;
}

// Si "fix" ya es una lista numerada ("1. ... 2. ..."), se muestra como lista y no se repiten los pasos.
function fixHtml(a) {
    const fix = String(a.fix || '');
    const parts = fix.split(/(?:^|\s)\d\.\s+/).map(x => x.trim()).filter(Boolean);
    const steps = (a.fix_steps || []).filter(s => s.length > 3);
    if (parts.length >= 2) return `<ol class="steps">${parts.map(x => `<li>${rich(x)}</li>`).join('')}</ol>`;
    return `<p>${rich(fix)}</p>${steps.length ? `<ol class="steps">${steps.map(x => `<li>${rich(x)}</li>`).join('')}</ol>` : ''}`;
}

function evidenceHtml(ev, a) {
    if (!ev) return '';
    let text = esc(ev.evidence || ev.message || '');
    const needle = a && a.exact_error && a.grounded ? esc(a.exact_error) : '';
    if (needle && needle.length > 4) text = text.split(needle).join(`<mark>${needle}</mark>`);
    return `<section class="d-sec"><h3>Líneas de log de la última vez <button class="btn copy" data-copy="evidence">Copiar</button></h3><pre class="logs" id="evidence">${text}</pre></section>`;
}

function codeHtml(i, a) {
    const loc = a && a.location;
    const blame = i.blame && typeof i.blame === 'object' ? i.blame : null;
    if (!loc && !blame && !i.code_file) return '';
    const where = loc ? `${loc.file}${loc.line ? `:${loc.line}` : ''}${loc.function ? `, función ${loc.function}` : ''}` : `${i.code_file}:${i.code_line}`;
    return `<section class="d-sec"><h3>Código implicado</h3>
        <div class="loc">${esc(where)}${loc && loc.inferred ? ' <span style="color:var(--muted)">(deducido de la ruta)</span>' : ''}</div>
        ${blame ? `<div class="blame">Último cambio: ${esc(blame.author)}, ${esc(blame.date)}, ${esc(blame.sha)} «${esc(blame.summary)}»</div>` : ''}
    </section>`;
}

function patchHtml(i) {
    if (!i.patch) return '';
    const lines = i.patch.split('\n').map(l => {
        const e = esc(l);
        if (l.startsWith('# ')) return `<span class="note">${esc(l.slice(2))}</span>`;
        if (l.startsWith('+++') || l.startsWith('---')) return `<span>${e}</span>`;
        if (l.startsWith('@@')) return `<span class="hunk">${e}</span>`;
        if (l.startsWith('+')) return `<span class="add">${e}</span>`;
        if (l.startsWith('-')) return `<span class="del">${e}</span>`;
        return `<span>${e}</span>`;
    }).join('\n');
    return `<section class="d-sec"><h3>Parche propuesto <button class="btn copy" data-copy="patch">Copiar diff</button></h3>
        <p style="color:var(--muted);font-size:13.5px">Revísalo y compílalo tú antes de aplicarlo: <code>git apply</code> con el diff copiado.${i.patch_branch ? ` También está en la rama <code>${esc(i.patch_branch)}</code> (creada sin tocar tu working tree).` : ''}</p>
        <pre class="diff" id="patch">${lines}</pre></section>`;
}

function histHtml(h) {
    const keys = Object.keys(h || {});
    if (!keys.length) return '';
    const now = Date.now(), step = 30 * 60000, n = 48;
    const start = Math.floor((now - n * step) / step) * step;
    const vals = Array.from({ length: n }, (_, k) => h[new Date(start + (k + 1) * step).toISOString()] || 0);
    const max = Math.max(1, ...vals);
    return `<section class="d-sec"><h3>Últimas 24 horas</h3>
        <div class="hist" role="img" aria-label="Ocurrencias por media hora en las últimas 24 horas">${vals.map(v => `<i style="height:${Math.round((v / max) * 100)}%" title="${v}"></i>`).join('')}</div>
        <div class="hist-axis"><span>hace 24 h</span><span>ahora</span></div></section>`;
}

function eventsHtml(events) {
    if (!events || events.length < 2) return '';
    return `<section class="d-sec"><h3>Ocurrencias recientes</h3><ol class="tail">${events.slice(0, 15).map(e => `
        <li><time>${esc(clock(e.ts))}</time><span class="dyno">${esc(e.dyno || '')}</span>
        <span class="txt">${esc([e.method, e.path, e.status_code ? `→ ${e.status_code}` : '', e.service_ms != null ? `${e.service_ms} ms` : '', e.user_id ? `user ${e.user_id}` : ''].filter(Boolean).join(' ') || (e.message || '').slice(0, 160))}</span></li>`).join('')}</ol></section>`;
}

async function issueAction(act) {
    const id = S.selectedId;
    try {
        if (act === 'analyze') {
            await api(`/api/issues/${id}/analyze`, { method: 'POST', body: '{}' });
            toast('Enviada al análisis con IA');
        } else {
            await api(`/api/issues/${id}/state`, { method: 'POST', body: JSON.stringify({ state: act }) });
            toast({ ack: 'Incidencia reconocida', resolved: 'Incidencia marcada como resuelta', ignored: 'Incidencia ignorada', open: 'Incidencia reabierta' }[act]);
        }
        await Promise.all([selectIssue(id, false), loadIssues()]);
    } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------------ en directo
function renderTail() {
    if (S.tab !== 'live') return;
    const f = S.liveFilter.toLowerCase();
    const rows = S.tail.filter(t => !f || t.text.toLowerCase().includes(f)).slice(-250).reverse();
    $('#tail').innerHTML = rows.length ? rows.map(t => `<li data-l="${esc(t.level)}"><time>${esc(clock(t.ts))}</time><span class="dyno">${esc(t.dyno || '')}</span><span class="txt">${esc(t.text)}</span></li>`).join('')
        : '<li class="empty" style="display:block"><strong>Sin errores recientes</strong>Aquí aparecerán en cuanto lleguen.</li>';
}

// ------------------------------------------------------------------ fuentes
const SRC_STATE = { live: 'Recibiendo', connecting: 'Conectando', reconnecting: 'Reconectando', error: 'Error', idle: 'En espera', done: 'Terminado', stopped: 'Parada' };
function renderSources() {
    if (S.tab !== 'sources') return;
    const h = S.health;
    if (!h) return;
    const cards = h.sources.map(s => `
        <div class="src"><h3>${esc(s.label)}</h3><div class="state" data-s="${esc(s.state)}">${esc(SRC_STATE[s.state] || s.state)}${s.state === 'live' && s.lastLine ? `, última línea ${esc(ago(s.lastLine))}` : ''}</div>
        <dl><dt>Líneas</dt><dd>${fmtN(s.lines)}</dd><dt>Reconexiones</dt><dd>${fmtN(s.reconnects)}</dd></dl>
        ${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}</div>`);
    const ai = h.ai;
    cards.push(`<div class="src"><h3>IA local</h3><div class="state" data-s="${ai.enabled ? (ai.ok ? 'live' : ai.ok === false ? 'error' : 'connecting') : 'idle'}">${ai.enabled ? (ai.ok ? 'Ollama responde' : ai.ok === false ? 'Ollama no responde' : 'Comprobando') : 'Desactivada'}</div>
        <dl><dt>Modelo</dt><dd>${esc(ai.model)}</dd><dt>En cola</dt><dd>${fmtN(ai.queue.queued)}${ai.queue.running ? ` + #${ai.queue.running} en curso` : ''}</dd>
        <dt>Analizadas</dt><dd>${fmtN(ai.queue.processed)}</dd><dt>Fallidas</dt><dd>${fmtN(ai.queue.failed)}</dd><dt>Parches</dt><dd>${esc(h.autofixMode)}</dd></dl>
        ${ai.error ? `<div class="err">${esc(ai.error)}</div>` : ''}</div>`);
    const n = h.notifier;
    cards.push(`<div class="src"><h3>Alertas por n8n</h3><div class="state" data-s="${n.enabled ? (n.lastError ? 'error' : 'live') : 'idle'}">${n.enabled ? (n.lastError ? 'Último envío fallido' : 'Activas') : 'Sin configurar'}</div>
        <dl><dt>Desde severidad</dt><dd>${esc(SEV_LABEL[n.minSeverity] || n.minSeverity)}</dd><dt>Enviadas</dt><dd>${fmtN(n.sent)}</dd><dt>Fallidas</dt><dd>${fmtN(n.failed)}</dd></dl>
        ${n.lastError ? `<div class="err">${esc(n.lastError)}</div>` : ''}</div>`);
    const p = h.pipeline;
    cards.push(`<div class="src"><h3>Procesado</h3><div class="state" data-s="live">Desde ${esc(clock(h.startedAt, true))}</div>
        <dl><dt>Líneas</dt><dd>${fmtN(p.lines)}</dd><dt>Duplicadas</dt><dd>${fmtN(p.dupes)}</dd><dt>Peticiones</dt><dd>${fmtN(p.requests)}</dd><dt>Ocurrencias</dt><dd>${fmtN(p.incidents)}</dd></dl></div>`);
    const origin = location.origin;
    $('#sources').innerHTML = `<div class="src-grid">${cards.join('')}</div>
        <div class="howto">
            <h2>Conectar más fuentes</h2>
            <p>La forma más fiable es la API de Heroku en streaming: crea un token de solo lectura y ponlo en <code>.env</code>.</p>
            <pre>heroku authorizations:create -d "revel-guardia" --scope read
HEROKU_API_TOKEN=...   LOG_SOURCES=heroku-api</pre>
            <p>Desde n8n (la VM revel-test-db), importa <code>n8n/heroku-logs-to-monitor.json</code>: cada minuto lee los logs con la API de log-sessions y los envía aquí.</p>
            <pre>POST ${esc(origin)}/api/ingest/n8n
X-Monitor-Token: &lt;INGEST_TOKEN&gt;</pre>
            <p>Como drain de Logplex (necesita una URL pública, p.ej. un túnel):</p>
            <pre>heroku drains:add "https://TU-TUNEL/api/ingest?token=&lt;INGEST_TOKEN&gt;" -a ${esc(h.app)}</pre>
        </div>`;
}

// ------------------------------------------------------------------ tiempo real
function connectStream() {
    const es = new EventSource('/api/stream');
    es.addEventListener('hello', e => { S.health = JSON.parse(e.data).health; renderVerdict(); renderSources(); });
    es.addEventListener('health', e => { S.health = JSON.parse(e.data); renderVerdict(); renderSources(); });
    es.addEventListener('req', e => {
        const batch = JSON.parse(e.data);
        S.pulse.push(...batch);
        if (S.pulse.length > 8000) S.pulse.splice(0, S.pulse.length - 6000);
    });
    es.addEventListener('tail', e => {
        if (S.livePaused) return;
        S.tail.push(JSON.parse(e.data));
        if (S.tail.length > 600) S.tail.splice(0, 200);
        renderTailSoon();
    });
    es.addEventListener('release', e => { S.releases.push(JSON.parse(e.data)); });
    es.addEventListener('issue', e => {
        const { issue, isNew } = JSON.parse(e.data);
        const idx = S.issues.findIndex(x => x.id === issue.id);
        if (idx !== -1) S.issues[idx] = issue; else if (isNew) reloadIssuesSoon();
        renderIssuesSoon();
        if (issue.id === S.selectedId) refreshDetailSoon();
        if (isNew && (issue.severity === 'critical' || issue.severity === 'high') && !issue.expected) toast(`Nueva incidencia: ${issue.title.slice(0, 80)}`);
    });
    es.onerror = () => { $('#verdict').dataset.s = 'unknown'; $('.verdict-text').textContent = 'Reconectando con el monitor…'; };
}
const renderTailSoon = debounce(renderTail, 250);
const renderIssuesSoon = debounce(() => { renderIssues(); renderVitals(); }, 300);
const reloadIssuesSoon = debounce(loadIssues, 800);
const refreshDetailSoon = debounce(() => S.selectedId && selectIssue(S.selectedId, false), 600);

// ------------------------------------------------------------------ arranque
function bind() {
    window.addEventListener('hashchange', route);
    $$('[data-state]').forEach(b => b.addEventListener('click', () => {
        S.f.state = b.dataset.state;
        $$('[data-state]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        loadIssues();
    }));
    $('#range').addEventListener('change', e => { S.f.range = e.target.value; loadIssues(); });
    $('#q').addEventListener('input', debounce(e => { S.f.q = e.target.value.trim(); loadIssues(); }, 250));
    $('#noise').addEventListener('change', e => { S.f.noise = e.target.checked; loadIssues(); });
    $('#cats').addEventListener('click', e => {
        const b = e.target.closest('[data-cat]'); if (!b) return;
        S.f.category = b.dataset.cat || null; renderIssues();
    });
    const issuesEl = $('#issues');
    issuesEl.addEventListener('click', e => { const li = e.target.closest('.issue'); if (li) selectIssue(Number(li.dataset.id)); });
    issuesEl.addEventListener('keydown', e => {
        const li = e.target.closest('.issue'); if (!li) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectIssue(Number(li.dataset.id)); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const sib = e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling;
            if (sib && sib.classList.contains('issue')) { sib.focus(); selectIssue(Number(sib.dataset.id)); }
        }
    });
    $('#detail').addEventListener('click', async e => {
        const b = e.target.closest('[data-act]');
        if (b) return issueAction(b.dataset.act);
        const c = e.target.closest('[data-copy]');
        if (c) {
            const src = c.dataset.copy === 'patch' ? (S.detail.issue.patch || '').split('\n').filter(l => !l.startsWith('# ')).join('\n') : $('#evidence').textContent;
            try { await navigator.clipboard.writeText(src); toast('Copiado al portapapeles'); } catch { toast('No se pudo copiar'); }
        }
    });
    $('#liveFilter').addEventListener('input', debounce(e => { S.liveFilter = e.target.value; renderTail(); }, 200));
    $('#livePause').addEventListener('click', e => {
        S.livePaused = !S.livePaused;
        e.currentTarget.setAttribute('aria-pressed', String(S.livePaused));
        e.currentTarget.textContent = S.livePaused ? 'Reanudar' : 'Pausar';
    });
    $('#themeBtn').addEventListener('click', () => {
        const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        const next = cur === 'light' ? 'dark' : 'light';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem('aimon-theme', next); } catch { /* sin storage */ }
        drawPulse();
    });
}

async function init() {
    bind();
    setupPulse();
    try { S.meta = await api('/api/meta'); } catch { /* sigue con valores por defecto */ }
    try { S.pulse = (await api('/api/pulse')).requests; } catch { /* vacío */ }
    try { S.tail = (await api('/api/tail')).tail; } catch { /* vacío */ }
    try { S.health = await api('/api/health'); renderVerdict(); } catch { /* llegará por SSE */ }
    route();
    await Promise.all([loadIssues(), loadVitals()]);
    renderDetail();
    if (S.selectedId) selectIssue(S.selectedId, false);
    connectStream();
    setInterval(loadVitals, 15000);
    setInterval(() => { renderIssues(); }, 30000); // refresca los «hace X min»
}
init();
