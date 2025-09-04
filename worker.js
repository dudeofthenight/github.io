/**
 * Cloudflare Worker for Gooblagoon Evidence — Sightings API
 * Storage: D1 (metadata) + KV (images)
 * Auth: Basic Auth for /deymod and /api/admin/* using env.ADMIN_PASSWORD
 * Cron: hourly cleanup of pending >48h
 */

// ---- Global CORS headers attached to (almost) every response ----
const CORS_BASE = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Origin',
  'Vary': 'Origin',
};

export default {
  /** HTTP entry */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // Preflight for all routes
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_BASE });
    }

    try {
      if (pathname === '/api/health') {
        return json({ ok: true });
      }

      // Serve admin UI at /deymod (Basic Auth protected)
      if (request.method === 'GET' && pathname === '/deymod') {
        if (!isAuthorized(request, env)) {
          return new Response('Auth required', { status: 401, headers: { ...CORS_BASE, 'WWW-Authenticate': 'Basic realm="admin"' } });
        }
        return new Response(ADMIN_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_BASE } });
      }

      // Public endpoints
      if (request.method === 'POST' && pathname === '/api/sightings') {
        return handleCreateSighting(request, env);
      }
      if (request.method === 'GET' && pathname === '/api/sightings') {
        return handleListApproved(env, searchParams);
      }

      // Image proxy
      if (request.method === 'GET' && pathname.startsWith('/api/image/')) {
        return handleImage(request, env);
      }

      // Admin endpoints (Basic Auth)
      if (pathname.startsWith('/api/admin/')) {
        if (!isAuthorized(request, env)) {
          return json({ error: 'Unauthorized' }, 401, { 'WWW-Authenticate': 'Basic realm="admin"' });
        }
        if (request.method === 'GET' && pathname === '/api/admin/pending') {
          return handleListPending(env, searchParams);
        }
        if (request.method === 'POST' && /\/api\/admin\/approve\/.+/.test(pathname)) {
          const id = pathname.split('/').pop();
          return handleApprove(env, id);
        }
        if (request.method === 'POST' && /\/api\/admin\/reject\/.+/.test(pathname)) {
          const id = pathname.split('/').pop();
          return handleReject(env, id);
        }
      }

      return json({ error: 'Not Found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'Server error' }, 500);
    }
  },

  /** Scheduled (cron) — clean up pending > 48h */
  async scheduled(event, env, ctx) {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const sql = `DELETE FROM sightings WHERE status = 'pending' AND submitted_at < ?`;
    await env.DB.prepare(sql).bind(cutoff).run();
  },
};

/** ---- Helpers ---- */
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_BASE, ...extraHeaders },
  });
}

function isAuthorized(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Basic ')) return false;
  const creds = atob(auth.replace('Basic ', ''));
  const [user, pass] = creds.split(':');
  return pass === env.ADMIN_PASSWORD;
}

async function handleCreateSighting(request, env) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return json({ error: 'Use multipart/form-data' }, 400);
  }
  const form = await request.formData();

  const title = (form.get('title') || '').toString().trim().slice(0, 120);
  const description = (form.get('description') || '').toString().trim().slice(0, 5000);
  const name = (form.get('name') || '').toString().trim().slice(0, 80) || 'Anonymous';
  const email = (form.get('email') || '').toString().trim().slice(0, 120);
  const meter = Math.max(1, Math.min(10, Number(form.get('suspicious_meter') || '1')));
  const consent = form.get('consent') === 'on' || form.get('consent') === 'true';

  if (!title || !description) return json({ error: 'Missing title/description' }, 400);
  if (!consent) return json({ error: 'Consent required' }, 400);

  // Save images (up to 1 photo) into KV
  const photos = [];
  const files = form.getAll('photos');
  const id = crypto.randomUUID();
  let index = 0;
  for (const file of files.slice(0, 1)) {
    if (typeof file === 'string') continue; // ignore text
    const type = (file.type || '').toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) continue;
    const buf = await file.arrayBuffer();
    if (buf.byteLength > 1 * 1024 * 1024) continue; // 1MB limit
    const key = `img:${id}:${index}`;
    await env.IMAGES.put(key, buf, { metadata: { type }, expirationTtl: 60 * 60 * 24 * 365 });
    photos.push(key);
    index++;
  }

  const submitted_at = Date.now();
  const status = 'pending';
  await env.DB.prepare(
    `INSERT INTO sightings (id, title, description, name, email, suspicious_meter, photos_json, submitted_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, title, description, name, email, meter, JSON.stringify(photos), submitted_at, status).run();

  return json({ ok: true, id }, 201);
}

async function handleListApproved(env, searchParams) {
  const limit = Math.min(50, Number(searchParams.get('limit') || 20));
  const offset = Math.max(0, Number(searchParams.get('offset') || 0));
  const rows = await env.DB.prepare(
    `SELECT id, title, description, name, suspicious_meter, photos_json, submitted_at, approved_at
     FROM sightings WHERE status = 'approved'
     ORDER BY approved_at DESC
     LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();

  const items = rows.results.map(r => ({
    id: r.id,
    title: r.title,
    description: r.description,
    name: r.name || 'Anonymous',
    suspicious_meter: r.suspicious_meter,
    photos: JSON.parse(r.photos_json || '[]'),
    submitted_at: r.submitted_at,
    approved_at: r.approved_at,
  }));
  return json({ items });
}

async function handleListPending(env, searchParams) {
  const rows = await env.DB.prepare(
    `SELECT id, title, description, name, email, suspicious_meter, photos_json, submitted_at
     FROM sightings WHERE status = 'pending'
     ORDER BY submitted_at ASC`
  ).all();
  const items = rows.results.map(r => ({
    id: r.id,
    title: r.title,
    description: r.description,
    name: r.name,
    email: r.email,
    suspicious_meter: r.suspicious_meter,
    photos: JSON.parse(r.photos_json || '[]'),
    submitted_at: r.submitted_at,
  }));
  return json({ items });
}

async function handleApprove(env, id) {
  const now = Date.now();
  const res = await env.DB.prepare(
    `UPDATE sightings SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'pending'`
  ).bind(now, id).run();
  return json({ ok: true, changes: res.meta.changes });
}

async function handleReject(env, id) {
  // delete DB row and its images
  const row = await env.DB.prepare(`SELECT photos_json FROM sightings WHERE id = ?`).bind(id).first();
  const photos = row ? JSON.parse(row.photos_json || '[]') : [];
  await env.DB.prepare(`DELETE FROM sightings WHERE id = ?`).bind(id).run();
  for (const key of photos) {
    await env.IMAGES.delete(key);
  }
  return json({ ok: true });
}

/** Image proxy: serve KV images at /api/image/:key */
export async function handleImage(request, env) {
  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.replace('/api/image/', ''));
  const obj = await env.IMAGES.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!obj || !obj.value) return new Response('Not found', { status: 404, headers: { ...CORS_BASE } });
  return new Response(obj.value, {
    status: 200,
    headers: { 'Content-Type': obj.metadata?.type || 'application/octet-stream', ...CORS_BASE },
  });
}

// ---- Embedded admin UI (kept server-side so it’s behind auth) ----
const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GE Admin — Sightings Queue</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#0b0c0f;color:#e8eef7}
  header{padding:16px 20px;border-bottom:1px solid #334155;background:#111319;position:sticky;top:0}
  .container{max-width:1100px;margin:0 auto;padding:0 20px}
  table{width:100%;border-collapse:collapse;margin:16px 0}
  th,td{border-bottom:1px solid #334155;text-align:left;padding:10px 8px;vertical-align:top}
  button{padding:8px 12px;border-radius:10px;border:1px solid #334155;background:#0ea5e9;color:#fff;font-weight:700;cursor:pointer}
  button.reject{background:#ef4444}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .muted{color:#b9c3d1}
  img{max-width:160px;border-radius:10px;border:1px solid #334155}
</style>
</head>
<body>
  <header><div class="container"><strong>Gooblagoon Evidence — Admin Queue</strong> <span class="muted">(path: /deymod)</span></div></header>
  <main class="container">
    <p class="muted">Approve or reject pending submissions. Refresh to re-auth if needed.</p>
    <div id="list"></div>
  </main>
<script>
function escapeHtml(s){return (s||'').replace(/[&<>\"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]})}

function el(tag, attrs, children){
  var node = document.createElement(tag);
  if(attrs){ for(var k in attrs){ if(k==="className"){ node.className = attrs[k]; } else { node.setAttribute(k, attrs[k]); } } }
  if(children){ for(var i=0;i<children.length;i++){ var ch = children[i]; if(typeof ch==="string"){ node.appendChild(document.createTextNode(ch)); } else { node.appendChild(ch); } } }
  return node;
}

async function load(){
  var listRoot = document.getElementById('list');
  listRoot.textContent = 'Loading…';
  var r = await fetch('/api/admin/pending');
  if(!r.ok){ listRoot.textContent = 'Auth required (refresh)'; return; }
  var data = await r.json();
  if(!data.items || !data.items.length){
    listRoot.innerHTML = '<p class="muted">No pending items.</p>';
    return;
  }
  var table = el('table', null, []);
  var thead = el('thead', null, []);
  var thr = el('tr', null, []);
  ['Title','Sender','Meter','Submitted','Photo','Actions'].forEach(function(h){
    thr.appendChild(el('th', null, [h]));
  });
  thead.appendChild(thr);
  table.appendChild(thead);

  var tbody = el('tbody', null, []);
  data.items.forEach(function(it){
    var tr = el('tr', null, []);

    var tdTitle = el('td', null, []);
    var strong = el('strong', null, [escapeHtml(it.title)]);
    var preview = el('div', { className: 'muted' }, [ (escapeHtml(it.description || '').slice(0,140) + '…') ]);
    tdTitle.appendChild(strong);
    tdTitle.appendChild(preview);

    var tdSender = el('td', null, []);
    tdSender.appendChild(document.createTextNode(it.name || ''));
    var email = el('div', { className: 'muted' }, [it.email || '']);
    tdSender.appendChild(email);

    var tdMeter = el('td', null, [String(it.suspicious_meter || '')]);

    var dt = new Date(it.submitted_at || Date.now()).toLocaleString();
    var tdTime = el('td', null, [dt]);

    var tdImg = el('td', null, []);
    if(it.photos && it.photos[0]){
      var img = el('img', { src: '/api/image/' + encodeURIComponent(it.photos[0]), alt: 'photo' }, []);
      tdImg.appendChild(img);
    } else {
      tdImg.textContent = '—';
    }

    var tdAct = el('td', null, []);
    var row = el('div', { className: 'row' }, []);
    var a = el('button', null, ['Approve']);
    a.onclick = function(){ act('approve', it.id); };
    var b = el('button', { className: 'reject' }, ['Reject']);
    b.onclick = function(){ act('reject', it.id); };
    row.appendChild(a); row.appendChild(b);
    tdAct.appendChild(row);

    [tdTitle, tdSender, tdMeter, tdTime, tdImg, tdAct].forEach(function(cell){ tr.appendChild(cell); });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  listRoot.replaceChildren(table);
}

async function act(kind, id){
  var r = await fetch('/api/admin/' + kind + '/' + id, { method: 'POST' });
  if(r.ok) load();
}

load();
</script>
</body>
</html>`;
