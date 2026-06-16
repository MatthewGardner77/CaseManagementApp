'use strict';

/* ==========================================================================
   Citizen Services Case Management — frontend controller
   Plain ES (no framework). Every data interaction is a real fetch() to the
   gateway, so a Dynatrace RUM agent correlates these user actions with the
   backend distributed traces they trigger.
   ========================================================================== */

// --- Tiny DOM helper -------------------------------------------------------
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const kid of kids) {
    if (kid == null) continue;
    node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return node;
}

const $ = (sel) => document.querySelector(sel);
const dateFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '—');
const slug = (s) => String(s).toLowerCase().replace(/\s+/g, '-');

// --- API layer -------------------------------------------------------------
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(path, opts);
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_e) { data = { raw: text }; }
  if (!resp.ok) {
    const err = new Error((data && data.detail) || `Request failed (${resp.status})`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

// --- Feedback --------------------------------------------------------------
function toast(message, kind = '') {
  const region = $('#toast-region');
  const t = el('div', { class: 'toast' + (kind ? ' toast--' + kind : ''), role: 'status' }, message);
  region.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

function showGlobalAlert(message) {
  $('#global-alert-text').textContent = message;
  $('#global-alert').hidden = false;
}
function clearGlobalAlert() { $('#global-alert').hidden = true; }

// --- View switching --------------------------------------------------------
const VIEWS = ['dashboard', 'queue', 'case'];
function showView(name) {
  for (const v of VIEWS) $('#view-' + v).hidden = v !== name;
  document.querySelectorAll('.primary-nav__link').forEach((a) => {
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  clearGlobalAlert();
  $('#main-content').focus();
}

// --- Tags ------------------------------------------------------------------
function statusTag(status) {
  return el('span', { class: 'tag tag--' + slug(status), text: status });
}
function priorityTag(priority) {
  return el('span', { class: 'prio prio--' + slug(priority) },
    el('span', { class: 'prio__dot', 'aria-hidden': 'true' }),
    el('span', { text: priority })
  );
}

/* ==========================================================================
   Dashboard
   ========================================================================== */
async function loadDashboard() {
  showView('dashboard');
  const grid = $('#stat-grid');
  grid.setAttribute('aria-busy', 'true');
  grid.replaceChildren(el('p', { class: 'loading', text: 'Loading indicators…' }));
  try {
    const d = await api('GET', '/api/dashboard');
    grid.replaceChildren(
      statCard(d.total, 'Total cases', '', 'All time'),
      statCard(d.open, 'Open cases', 'open', 'Not yet resolved'),
      statCard(d.slaBreaches, 'Past SLA', 'breach', 'Open & overdue'),
      statCard(d.avgDaysToClose != null ? d.avgDaysToClose + 'd' : '—', 'Avg time to close', 'sla', 'Resolved cases')
    );
    grid.setAttribute('aria-busy', 'false');
    renderBars('#by-status-list', d.byStatus);
    renderBars('#by-type-list', d.byType);
  } catch (err) {
    grid.setAttribute('aria-busy', 'false');
    grid.replaceChildren();
    showGlobalAlert('We could not load the dashboard indicators. ' + err.message);
  }
}

function statCard(value, label, mod, sub) {
  return el('div', { class: 'stat-card' + (mod ? ' stat-card--' + mod : '') },
    el('span', { class: 'stat-card__value', text: String(value) }),
    el('span', { class: 'stat-card__label', text: label }),
    sub ? el('span', { class: 'stat-card__sub', text: sub }) : null
  );
}

function renderBars(sel, counts) {
  const list = $(sel);
  const entries = Object.entries(counts || {});
  const max = Math.max(1, ...entries.map(([, c]) => c));
  list.replaceChildren(...entries.map(([label, count]) =>
    el('li', {},
      el('div', { class: 'bar-list__row' },
        el('span', { text: label }),
        el('span', { class: 'bar-list__count', text: String(count) })
      ),
      el('div', { class: 'bar-track', 'aria-hidden': 'true' },
        el('div', { class: 'bar-fill', style: `width:${Math.round((count / max) * 100)}%` })
      )
    )
  ));
}

/* ==========================================================================
   Case queue
   ========================================================================== */
const queueState = { q: '', status: '', type: '', priority: '', slaBreached: false, page: 1, pageSize: 25 };

async function loadQueue() {
  showView('queue');
  const body = $('#queue-body');
  body.setAttribute('aria-busy', 'true');
  body.replaceChildren(el('tr', {}, el('td', { colspan: '8', class: 'loading', text: 'Loading cases…' })));

  const params = new URLSearchParams();
  if (queueState.q) params.set('q', queueState.q);
  if (queueState.status) params.set('status', queueState.status);
  if (queueState.type) params.set('type', queueState.type);
  if (queueState.priority) params.set('priority', queueState.priority);
  if (queueState.slaBreached) params.set('slaBreached', 'true');
  params.set('page', String(queueState.page));
  params.set('pageSize', String(queueState.pageSize));

  try {
    const data = await api('GET', '/api/cases?' + params.toString());
    renderQueue(data);
  } catch (err) {
    body.setAttribute('aria-busy', 'false');
    body.replaceChildren(el('tr', {}, el('td', { colspan: '8', class: 'empty', text: 'Unable to load cases right now. Please try again.' })));
    $('#queue-meta').textContent = '';
    showGlobalAlert('The case queue could not be loaded. ' + err.message);
  }
}

function renderQueue(data) {
  const body = $('#queue-body');
  const { items, total, page, pageSize } = data;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  $('#queue-meta').textContent = `Showing ${from}–${to} of ${total} case${total === 1 ? '' : 's'}`;

  if (!items.length) {
    body.replaceChildren(el('tr', {}, el('td', { colspan: '8', class: 'empty', text: 'No cases match these filters.' })));
  } else {
    body.replaceChildren(...items.map((c) =>
      el('tr', {},
        el('td', {}, el('a', { class: 'case-link', href: '#', 'data-id': c.id, onclick: openCaseFromEvent, text: c.case_number })),
        el('td', { text: c.citizen_name }),
        el('td', { text: c.case_type }),
        el('td', {}, statusTag(c.status)),
        el('td', {}, priorityTag(c.priority)),
        el('td', { class: c.assigned_officer ? '' : 'muted', text: c.assigned_officer || 'Unassigned' }),
        el('td', {}, c.sla_breached
          ? el('span', { class: 'sla-flag', text: fmtDate(c.sla_due_date) })
          : el('span', { text: fmtDate(c.sla_due_date) })),
        el('td', {}, el('a', { class: 'case-link', href: '#', 'data-id': c.id, onclick: openCaseFromEvent, text: 'View' }))
      )
    ));
  }
  body.setAttribute('aria-busy', 'false');
  renderPagination(total, page, pageSize);
}

function renderPagination(total, page, pageSize) {
  const nav = $('#pagination');
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) { nav.replaceChildren(); return; }
  const go = (p) => () => { queueState.page = p; loadQueue(); };

  const kids = [];
  kids.push(el('button', { type: 'button', onclick: go(page - 1), disabled: page <= 1, 'aria-label': 'Previous page' }, '‹ Prev'));

  const start = Math.max(1, page - 2);
  const end = Math.min(pages, start + 4);
  for (let p = start; p <= end; p++) {
    kids.push(el('button', {
      type: 'button',
      onclick: go(p),
      'aria-current': p === page ? 'true' : false,
      'aria-label': `Page ${p}`
    }, String(p)));
  }
  kids.push(el('button', { type: 'button', onclick: go(page + 1), disabled: page >= pages, 'aria-label': 'Next page' }, 'Next ›'));
  nav.replaceChildren(...kids);
}

/* ==========================================================================
   Case detail
   ========================================================================== */
function openCaseFromEvent(e) {
  e.preventDefault();
  loadCase(e.currentTarget.dataset.id);
}

async function loadCase(id) {
  showView('case');
  const container = $('#case-detail');
  container.setAttribute('aria-busy', 'true');
  container.replaceChildren(el('p', { class: 'loading', text: 'Loading case…' }));
  try {
    const c = await api('GET', '/api/cases/' + encodeURIComponent(id));
    renderCase(c);
  } catch (err) {
    container.replaceChildren(el('p', { class: 'empty', text: 'This case could not be loaded. ' + err.message }));
  } finally {
    container.setAttribute('aria-busy', 'false');
  }
}

const STATUSES = ['New', 'In Review', 'Pending Info', 'Approved', 'Denied', 'Closed'];

function renderCase(c) {
  const container = $('#case-detail');

  const head = el('div', { class: 'case-head' },
    el('div', {},
      el('div', { class: 'case-head__num', text: c.case_number }),
      el('h1', { text: c.citizen_name }),
      el('div', {}, statusTag(c.status), ' ', priorityTag(c.priority),
        c.sla_breached ? el('span', { class: 'sla-flag', text: 'Past SLA' }) : null)
    )
  );

  const meta = el('dl', { class: 'case-meta' },
    metaItem('Case type', c.case_type),
    metaItem('Assigned officer', c.assigned_officer || 'Unassigned'),
    metaItem('SLA due', fmtDate(c.sla_due_date)),
    metaItem('Opened', fmtDate(c.created_at)),
    metaItem('Last updated', fmtDate(c.updated_at)),
    metaItem('Closed', fmtDate(c.closed_at))
  );

  // Workflow control
  const statusSelect = el('select', { id: 'wf-status', name: 'status' },
    ...STATUSES.map((s) => el('option', { selected: s === c.status }, s)));
  const workflow = el('div', { class: 'workflow' },
    el('div', { class: 'field' }, el('label', { for: 'wf-status', text: 'Change status' }), statusSelect),
    el('button', {
      class: 'btn btn--primary',
      type: 'button',
      onclick: () => changeStatus(c.id, statusSelect.value)
    }, 'Update status')
  );

  // Notes
  const notesList = el('ul', { class: 'notes' },
    ...(c.notes && c.notes.length
      ? c.notes.map((n) => el('li', { class: 'note' },
          el('div', { class: 'note__meta', text: `${n.author} · ${fmtDate(n.created_at)}` }),
          el('p', { class: 'note__body', text: n.body })))
      : [el('li', { class: 'muted', text: 'No notes on this case yet.' })]));

  const noteInput = el('textarea', { id: 'note-body', rows: '2', placeholder: 'Add a case note…', style: 'width:100%;font:inherit;padding:.5rem;border:1px solid var(--border-strong);border-radius:4px;' });
  const addNote = el('div', { class: 'field', style: 'margin-top:.75rem;' },
    el('label', { for: 'note-body', text: 'New note' }),
    noteInput,
    el('button', { class: 'btn btn--outline', type: 'button', style: 'margin-top:.5rem;align-self:flex-start;',
      onclick: () => submitNote(c.id, noteInput.value) }, 'Add note'));

  // Documents
  const docs = el('ul', { class: 'docs' },
    ...(c.documents && c.documents.length
      ? c.documents.map((d) => el('li', {},
          el('span', { text: d.name }),
          el('span', { class: 'muted', text: `${d.pages} pp · ${d.status}` })))
      : [el('li', { class: 'muted', text: c.documentServiceError ? 'Document service unavailable.' : 'No documents.' })]));

  const left = el('div', {},
    el('h2', { class: 'panel__title', text: 'Case details' }), meta,
    el('h2', { class: 'panel__title', style: 'margin-top:1.5rem;', text: 'Case notes' }), notesList, addNote);
  const right = el('div', {},
    el('section', { class: 'panel' }, el('h2', { class: 'panel__title', text: 'Status workflow' }), workflow),
    el('section', { class: 'panel', style: 'margin-top:1.25rem;' },
      el('h2', { class: 'panel__title', text: 'Documents' }), docs));

  container.replaceChildren(head, el('div', { class: 'case-grid' }, left, right));
}

function metaItem(label, value) {
  return el('div', {}, el('dt', { class: 'meta__label', text: label }), el('dd', { class: 'meta__value', text: value }));
}

async function changeStatus(id, status) {
  try {
    await api('PATCH', `/api/cases/${id}/status`, { status });
    toast(`Status updated to "${status}".`, 'success');
    loadCase(id);
  } catch (err) {
    toast('Could not update status. ' + err.message, 'error');
  }
}

async function submitNote(id, body) {
  if (!body.trim()) { toast('Enter a note before adding it.', 'error'); return; }
  try {
    await api('POST', `/api/cases/${id}/notes`, { author: 'Case Officer', body: body.trim() });
    toast('Note added.', 'success');
    loadCase(id);
  } catch (err) {
    toast('Could not add note. ' + err.message, 'error');
  }
}

/* ==========================================================================
   Create case (native <dialog>)
   ========================================================================== */
function wireCreateDialog() {
  const dialog = $('#create-dialog');
  const form = $('#create-form');
  $('#new-case-btn').addEventListener('click', () => { form.reset(); dialog.showModal(); });
  $('#create-cancel').addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const submitBtn = $('#create-submit');
    submitBtn.disabled = true;
    const payload = {
      citizenName: form.citizenName.value.trim(),
      caseType: form.caseType.value,
      priority: form.priority.value,
      fileName: form.fileName.value.trim() || 'application.pdf'
    };
    try {
      const created = await api('POST', '/api/cases', payload);
      dialog.close();
      toast(`Case ${created.case_number} filed for ${created.citizen_name}.`, 'success');
      loadCase(created.id);
    } catch (err) {
      toast('Could not file the case. ' + err.message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });
}

/* ==========================================================================
   Wiring
   ========================================================================== */
function wireBanner() {
  const btn = $('.usa-banner__button');
  const content = $('#gov-banner-content');
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    content.hidden = open;
  });
}

function wireNav() {
  document.querySelectorAll('[data-view]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const v = a.dataset.view;
      if (v === 'dashboard') loadDashboard();
      else if (v === 'queue') { queueState.page = 1; loadQueue(); }
    });
  });
}

function wireFilters() {
  const form = $('#filter-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    queueState.q = $('#f-q').value.trim();
    queueState.status = $('#f-status').value;
    queueState.type = $('#f-type').value;
    queueState.priority = $('#f-priority').value;
    queueState.slaBreached = $('#f-sla').checked;
    queueState.page = 1;
    loadQueue();
  });
  $('#filter-reset').addEventListener('click', () => {
    form.reset();
    Object.assign(queueState, { q: '', status: '', type: '', priority: '', slaBreached: false, page: 1 });
    loadQueue();
  });
}

function wireMastheadSearch() {
  $('.masthead__search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#masthead-search').value.trim();
    Object.assign(queueState, { q, status: '', type: '', priority: '', slaBreached: false, page: 1 });
    $('#f-q').value = q;
    loadQueue();
  });
}

function wireBackLink() {
  $('#back-to-queue').addEventListener('click', (e) => { e.preventDefault(); loadQueue(); });
}

document.addEventListener('DOMContentLoaded', () => {
  wireBanner();
  wireNav();
  wireFilters();
  wireMastheadSearch();
  wireBackLink();
  wireCreateDialog();
  loadDashboard();
});
