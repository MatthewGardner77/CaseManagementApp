'use strict';

// ============================================================================
// gateway
// ----------------------------------------------------------------------------
// Serves the citizen-facing frontend (static files) and acts as the
// backend-for-frontend. Every UI API call lands here; the gateway fans out to
// case-service and (for some flows) document-service over HTTP, then returns.
//
// The gateway holds NO database connection and injects NO failures of its own.
// All frontend-perceived latency and errors are INHERITED from downstream
// services — which is precisely the cross-service root-cause story Davis AI
// surfaces: the frontend looks slow/broken, but the gateway is just waiting on
// case-service or document-service.
// ============================================================================

const path = require('path');
const express = require('express');
const morgan = require('morgan');

const PORT = parseInt(process.env.PORT || '8080', 10);
const CASE_SERVICE_URL = process.env.CASE_SERVICE_URL || 'http://case-service:3001';
const DOCUMENT_SERVICE_URL = process.env.DOCUMENT_SERVICE_URL || 'http://document-service:3002';

const app = express();
app.use(express.json());
app.use(morgan('combined'));

// Call a downstream service and parse JSON. Non-2xx responses are turned into
// errors that carry the upstream status so it propagates to the frontend
// (failure-rate scenarios show up on gateway endpoints too).
async function call(base, endpoint, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(base + endpoint, opts);
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_e) {
    data = { raw: text };
  }
  if (!resp.ok) {
    const err = new Error(`downstream ${resp.status} from ${endpoint}`);
    err.status = resp.status;
    err.body = data;
    throw err;
  }
  return data;
}

const caseSvc = (endpoint, opts) => call(CASE_SERVICE_URL, endpoint, opts);
const docSvc = (endpoint, opts) => call(DOCUMENT_SERVICE_URL, endpoint, opts);

const queryString = (req) => {
  const i = req.originalUrl.indexOf('?');
  return i >= 0 ? req.originalUrl.slice(i) : '';
};

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('/control', (_req, res) => res.sendFile(path.join(publicDir, 'control.html')));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'gateway' }));

// ---------------------------------------------------------------------------
// Citizen UI API (BFF)
// ---------------------------------------------------------------------------

// Dashboard — single downstream call to case-service aggregations.
app.get('/api/dashboard', async (_req, res, next) => {
  try {
    res.json(await caseSvc('/cases/stats'));
  } catch (err) {
    next(err);
  }
});

// Case queue — forwards filters/pagination straight through.
app.get('/api/cases', async (req, res, next) => {
  try {
    res.json(await caseSvc('/cases' + queryString(req)));
  } catch (err) {
    next(err);
  }
});

// Case detail — fans out to case-service (the record) AND document-service
// (processed documents) in parallel. Documents are best-effort so a slow/over
// -loaded document-service degrades, but never blanks, the page.
app.get('/api/cases/:id', async (req, res, next) => {
  try {
    const [record, docs] = await Promise.all([
      caseSvc(`/cases/${encodeURIComponent(req.params.id)}`),
      docSvc(`/documents/case/${encodeURIComponent(req.params.id)}`).catch((e) => ({
        documents: [],
        documentServiceError: e.message
      }))
    ]);
    record.documents = docs.documents || [];
    if (docs.documentServiceError) record.documentServiceError = docs.documentServiceError;
    res.json(record);
  } catch (err) {
    next(err);
  }
});

// Create case — validate the attachment in document-service (CPU-bound),
// then persist the case in case-service.
app.post('/api/cases', async (req, res, next) => {
  try {
    const validation = await docSvc('/documents/validate', {
      method: 'POST',
      body: { fileName: (req.body && req.body.fileName) || 'application.pdf' }
    });
    const created = await caseSvc('/cases', { method: 'POST', body: req.body });
    created.attachmentValidation = validation;
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

app.patch('/api/cases/:id/status', async (req, res, next) => {
  try {
    res.json(await caseSvc(`/cases/${encodeURIComponent(req.params.id)}/status`, {
      method: 'PATCH',
      body: req.body
    }));
  } catch (err) {
    next(err);
  }
});

app.post('/api/cases/:id/notes', async (req, res, next) => {
  try {
    res.status(201).json(await caseSvc(`/cases/${encodeURIComponent(req.params.id)}/notes`, {
      method: 'POST',
      body: req.body
    }));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Operator controls (proxied to case-service, which owns the write path)
// ---------------------------------------------------------------------------
app.get('/api/scenarios', async (_req, res, next) => {
  try {
    res.json(await caseSvc('/scenarios'));
  } catch (err) {
    next(err);
  }
});

app.put('/api/scenarios/:name', async (req, res, next) => {
  try {
    res.json(await caseSvc(`/scenarios/${encodeURIComponent(req.params.name)}`, {
      method: 'PUT',
      body: req.body
    }));
  } catch (err) {
    next(err);
  }
});

app.get('/api/loadgen', async (_req, res, next) => {
  try {
    res.json(await caseSvc('/loadgen'));
  } catch (err) {
    next(err);
  }
});

app.put('/api/loadgen', async (req, res, next) => {
  try {
    res.json(await caseSvc('/loadgen', { method: 'PUT', body: req.body }));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Error handler — propagate the upstream status (so a downstream 5xx becomes a
// gateway 5xx the frontend/RUM can see), default to 502 when unreachable.
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  const status = err.status && err.status >= 400 ? err.status : 502;
  console.error(`[gateway] ${status}: ${err.message}`);
  res.status(status).json({ error: 'gateway upstream error', detail: err.message, upstream: err.body });
});

app.listen(PORT, () => console.log(`[gateway] listening on :${PORT}`));
