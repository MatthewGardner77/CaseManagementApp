'use strict';

/* ==========================================================================
   Operator control console (/control)
   Drives the scenario engine and load generator through the gateway REST API.
   Polls state every few seconds so it stays in sync even when scenarios are
   flipped from curl.
   ========================================================================== */

const SCENARIOS = [
  {
    name: 'HIGH_CPU',
    title: 'High CPU',
    svc: 'document-service',
    desc: 'A CPU-bound busy loop runs on every document-service request, raising process CPU and the service’s own response time.',
    knob: 'Busy-loop duration', unit: 'ms', min: 0, max: 2000, step: 50, headline: false
  },
  {
    name: 'DB_FAILURE_RATE',
    title: 'DB failure rate',
    svc: 'case-service → postgres',
    desc: 'A configurable percentage of Postgres queries are forced to fail, spiking the failure rate on case endpoints.',
    knob: 'Error rate', unit: '%', min: 0, max: 100, step: 5, headline: false
  },
  {
    name: 'BACKEND_SLOWDOWN',
    title: 'Backend slowdown',
    svc: 'case-service',
    desc: 'Latency is injected into case responses. The gateway awaits it, so the frontend looks slow while the true root cause sits downstream.',
    knob: 'Injected latency', unit: 'ms', min: 0, max: 5000, step: 100, headline: true
  }
];
const BY_NAME = Object.fromEntries(SCENARIOS.map((s) => [s.name, s]));

function elc(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  kids.forEach((c) => c != null && n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return n;
}
const $$ = (s) => document.querySelector(s);

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const resp = await fetch(path, opts);
  const text = await resp.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (_e) { /* ignore */ }
  if (!resp.ok) throw new Error((data && data.detail) || `HTTP ${resp.status}`);
  return data;
}

function toast(msg, err) {
  const t = elc('div', { class: 't' + (err ? ' err' : '') }, msg);
  $$('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// --- Build scenario cards --------------------------------------------------
function buildCards() {
  const grid = $$('#scenario-grid');
  grid.replaceChildren(...SCENARIOS.map((s) => {
    const toggle = elc('input', { type: 'checkbox', id: 'tg-' + s.name, 'aria-label': s.title + ' enabled' });
    toggle.addEventListener('change', async () => {
      try {
        await api('PUT', '/api/scenarios/' + s.name, { enabled: toggle.checked });
        toast(`${s.name} ${toggle.checked ? 'enabled' : 'disabled'}.`);
        refresh();
      } catch (e) { toast(`Could not update ${s.name}: ${e.message}`, true); toggle.checked = !toggle.checked; }
    });

    const out = elc('output', { id: 'out-' + s.name }, '—');
    const slider = elc('input', {
      type: 'range', id: 'sl-' + s.name, min: s.min, max: s.max, step: s.step, value: s.min,
      'aria-label': s.knob + ' (' + s.unit + ')'
    });
    slider.addEventListener('input', () => { out.textContent = slider.value + ' ' + s.unit; });
    slider.addEventListener('change', async () => {
      try {
        await api('PUT', '/api/scenarios/' + s.name, { intensity: Number(slider.value) });
        toast(`${s.name} intensity set to ${slider.value} ${s.unit}.`);
        refresh();
      } catch (e) { toast(`Could not set intensity: ${e.message}`, true); }
    });

    return elc('section', { class: 'card' + (s.headline ? ' headline' : ''), 'aria-labelledby': 'h-' + s.name },
      s.headline ? elc('span', { class: 'tagline' }, 'HEADLINE RCA SCENARIO') : null,
      elc('div', { class: 'card__head' },
        elc('h2', { class: 'card__title', id: 'h-' + s.name }, s.title),
        elc('span', { class: 'card__svc' }, s.svc)
      ),
      elc('p', { class: 'card__desc' }, s.desc),
      elc('label', { class: 'switch' },
        toggle,
        elc('span', { class: 'switch__track' }, elc('span', { class: 'switch__thumb' })),
        elc('span', { class: 'switch__label' }, 'Scenario off/on')
      ),
      elc('div', { class: 'slider-row' },
        elc('label', { for: 'sl-' + s.name }, s.knob + ' ', out),
        slider
      )
    );
  }));
}

// --- Sync from server ------------------------------------------------------
function isBusy(node) {
  return document.activeElement === node;
}

async function refresh() {
  try {
    const flags = await api('GET', '/api/scenarios');
    $$('#conn-pill').textContent = 'connected';
    $$('#conn-pill').style.color = 'var(--on)';

    const active = [];
    for (const f of flags) {
      const meta = BY_NAME[f.name];
      if (!meta) continue;
      const toggle = $$('#tg-' + f.name);
      const slider = $$('#sl-' + f.name);
      const out = $$('#out-' + f.name);
      if (toggle && !isBusy(toggle)) toggle.checked = f.enabled;
      if (slider && !isBusy(slider)) { slider.value = f.intensity; out.textContent = f.intensity + ' ' + meta.unit; }
      if (f.enabled) active.push({ name: f.name, intensity: f.intensity, unit: meta.unit });
    }
    renderActive(active);
  } catch (e) {
    $$('#conn-pill').textContent = 'disconnected';
    $$('#conn-pill').style.color = 'var(--danger)';
  }

  try {
    const lg = await api('GET', '/api/loadgen');
    const running = $$('#lg-running');
    const rps = $$('#lg-rps');
    if (!isBusy(running)) running.checked = !!lg.running;
    if (!isBusy(rps)) { rps.value = lg.rps; $$('#lg-rps-out').textContent = lg.rps + ' req/s'; }
    $$('#lg-state').textContent = lg.running ? 'on' : 'off';
    $$('#lg-dot').className = 'status-dot' + (lg.running ? ' on' : '');
    $$('#lg-summary').textContent = lg.running ? `${lg.rps} req/s` : 'paused';
  } catch (_e) { /* handled by scenario poll pill */ }
}

function renderActive(active) {
  const banner = $$('#active-banner');
  const list = $$('#active-list');
  if (!active.length) {
    banner.classList.remove('is-active');
    list.replaceChildren(elc('span', { class: 'nominal' }, '● All systems nominal — no scenarios active.'));
    return;
  }
  banner.classList.add('is-active');
  list.replaceChildren(...active.map((a) =>
    elc('span', { class: 'chip' }, a.name + ' ', elc('b', {}, a.intensity + ' ' + a.unit))
  ));
}

// --- Load generator wiring -------------------------------------------------
function wireLoadgen() {
  const running = $$('#lg-running');
  const rps = $$('#lg-rps');
  const out = $$('#lg-rps-out');
  running.addEventListener('change', async () => {
    try { await api('PUT', '/api/loadgen', { running: running.checked }); toast(`Load generator ${running.checked ? 'started' : 'paused'}.`); refresh(); }
    catch (e) { toast('Could not update load generator: ' + e.message, true); running.checked = !running.checked; }
  });
  rps.addEventListener('input', () => { out.textContent = rps.value + ' req/s'; });
  rps.addEventListener('change', async () => {
    try { await api('PUT', '/api/loadgen', { rps: Number(rps.value) }); toast(`Request rate set to ${rps.value} req/s.`); refresh(); }
    catch (e) { toast('Could not set request rate: ' + e.message, true); }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  buildCards();
  wireLoadgen();
  refresh();
  setInterval(refresh, 3000);
});
