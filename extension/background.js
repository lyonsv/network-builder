/* Network Builder for LinkedIn — background service worker.
 *
 * Talks to the local Network Builder explorer (http://127.0.0.1:<port>/ext/*) with the capture token from pairing.
 * Captures that can't be delivered (app not running, not paired, server error) wait in a queue in chrome.storage and
 * are sent automatically once the app answers. Nothing here calls any AI or any service other than your own machine.
 */

const TIMEOUT_MS = 10_000;
const ALARM = 'nb-flush';

// ---------- storage ----------
const get = async (k, d) => (await chrome.storage.local.get(k))[k] ?? d;
const set = (o) => chrome.storage.local.set(o);

async function getPairing() {
  return get('pairing', null); // { url, token, pairedAt }
}
async function getQueue() {
  return get('queue', []); // [{ id, body, name, account, queuedAt, attempts, state: 'waiting'|'failed', error }]
}
async function saveQueue(q) {
  await set({ queue: q });
  await refreshBadge();
  if (q.some((x) => x.state === 'waiting')) chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  else chrome.alarms.clear(ALARM);
}
async function setStatus(status) {
  await set({ status: { ...status, at: new Date().toISOString() } });
  await refreshBadge();
}

async function refreshBadge() {
  const [pairing, queue, status] = await Promise.all([getPairing(), getQueue(), get('status', null)]);
  const waiting = queue.filter((x) => x.state === 'waiting').length;
  const failed = queue.filter((x) => x.state === 'failed').length;
  let text = '';
  let color = '#3b5bdb';
  let title = 'Network Builder';
  if (!pairing) {
    text = '!';
    color = '#a8670a';
    title = 'Network Builder — not paired yet. Click to pair.';
  } else if (failed) {
    text = String(failed);
    color = '#c2332f';
    title = `Network Builder — ${failed} profile${failed > 1 ? 's' : ''} couldn't be added. Click for details.`;
  } else if (waiting) {
    text = String(waiting);
    color = '#a8670a';
    title = `Network Builder — ${waiting} profile${waiting > 1 ? 's' : ''} waiting to send${status?.kind === 'offline' ? ' (app not running)' : ''}.`;
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}

// ---------- pairing ----------
function decodeCode(code) {
  const c = String(code || '').trim();
  if (!c.startsWith('nb1.')) throw new Error('That isn’t a pairing code. In Network Builder open Accounts → Chrome extension and copy the code (it starts with “nb1.”).');
  let v;
  try {
    const b64 = c.slice(4).replace(/-/g, '+').replace(/_/g, '/');
    v = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
  } catch {
    throw new Error('The pairing code is incomplete — copy it again.');
  }
  if (!v || typeof v.u !== 'string' || typeof v.t !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(v.u)) {
    throw new Error('The pairing code is incomplete — copy it again.');
  }
  return { url: v.u, token: v.t };
}

// ---------- API ----------
/**
 * → { ok: true, data } or { ok: false, kind, message, status }
 * kind: offline (app not running) · unpaired (token rejected) · rejected (bad data — won't succeed on retry) · server (try later)
 */
async function call(path, { method = 'GET', body, pairing } = {}) {
  pairing = pairing ?? (await getPairing());
  if (!pairing) return { ok: false, kind: 'unpaired', message: 'Not paired with Network Builder yet. Click the Network Builder extension icon and paste the pairing code.' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(pairing.url + path, {
      method,
      headers: { 'X-NB-Capture': pairing.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } catch (e) {
    const where = pairing.url.replace('http://', '');
    const message =
      e && e.name === 'AbortError'
        ? `Network Builder didn’t respond (at ${where}). It may be busy — this will be retried.`
        : `Network Builder isn’t running (nothing answered at ${where}). Open the Network Builder app, or run \`network-builder\` in a terminal. If it is running, its port may have changed — pair again from Accounts → Chrome extension.`;
    return { ok: false, kind: 'offline', message };
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (res.ok) return { ok: true, data };
  const msg = (data && data.error) || `HTTP ${res.status}`;
  if (res.status === 401) return { ok: false, kind: 'unpaired', status: 401, message: `Network Builder didn’t accept this browser’s pairing: ${msg}` };
  if (res.status === 404 && msg === 'not found') {
    return { ok: false, kind: 'server', status: 404, message: 'This version of Network Builder doesn’t support the Chrome extension yet — update it, then try again.' };
  }
  if (res.status >= 500 || res.status === 503) return { ok: false, kind: 'server', status: res.status, message: `Network Builder had a problem (${msg}). This will be retried.` };
  return { ok: false, kind: 'rejected', status: res.status, message: msg };
}

async function ping(pairing) {
  const r = await call('/ext/ping', { pairing });
  await setStatus(r.ok ? { kind: 'ok', message: 'Connected' } : { kind: r.kind, message: r.message });
  return r;
}

// ---------- queue ----------
let flushing = null;
async function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    let q = await getQueue();
    const waiting = q.filter((x) => x.state === 'waiting');
    if (!waiting.length) return { sent: 0, failed: 0, waiting: 0 };
    let sent = 0;
    let failed = 0;
    const sentNames = [];
    for (const item of waiting) {
      const r = await call('/ext/capture', { method: 'POST', body: item.body });
      q = await getQueue();
      const cur = q.find((x) => x.id === item.id);
      if (!cur) continue; // removed meanwhile
      if (r.ok) {
        q = q.filter((x) => x.id !== item.id);
        sent++;
        sentNames.push(`${r.data.person.fullName} → ${r.data.account.name}`);
      } else if (r.kind === 'rejected') {
        cur.state = 'failed';
        cur.error = r.message;
        failed++;
      } else {
        cur.attempts = (cur.attempts || 0) + 1;
        cur.error = r.message;
        await saveQueue(q);
        await setStatus({ kind: r.kind, message: r.message });
        break; // app still unreachable / not paired: stop; the alarm retries
      }
      await saveQueue(q);
    }
    if (sent) await setStatus({ kind: 'ok', message: 'Connected' });
    if (sent) {
      notify(
        `Sent ${sent} saved profile${sent > 1 ? 's' : ''} to Network Builder`,
        sentNames.slice(0, 3).join('\n') + (sentNames.length > 3 ? `\n+${sentNames.length - 3} more` : ''),
      );
    }
    if (failed) notify(`${failed} saved profile${failed > 1 ? 's' : ''} couldn’t be added`, 'Click the Network Builder extension icon to see why.');
    return { sent, failed, waiting: (await getQueue()).filter((x) => x.state === 'waiting').length };
  })();
  try {
    return await flushing;
  } finally {
    flushing = null;
  }
}

function notify(title, message) {
  try {
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message: message || '' });
  } catch {
    /* notifications are a nice-to-have */
  }
}

async function enqueue(body, reason) {
  const q = await getQueue();
  const url = body.profile && body.profile.url;
  // one pending capture per person: the newest replaces an older waiting one
  const rest = q.filter((x) => !(x.state === 'waiting' && x.body.profile && x.body.profile.url === url));
  rest.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    body,
    name: (body.profile && body.profile.fullName) || 'Someone',
    account: body.accountName || body.accountLabel || '',
    queuedAt: new Date().toISOString(),
    attempts: 1,
    state: 'waiting',
    error: reason,
  });
  await saveQueue(rest);
}

// ---------- messages from the LinkedIn page and the popup ----------
const handlers = {
  async status() {
    const [pairing, queue, status] = await Promise.all([getPairing(), getQueue(), get('status', null)]);
    return { paired: Boolean(pairing), url: pairing?.url ?? '', pairedAt: pairing?.pairedAt ?? '', queue, status };
  },
  async pair({ code }) {
    const p = decodeCode(code);
    const r = await ping(p);
    if (!r.ok && r.kind !== 'offline') throw new Error(r.message);
    await set({ pairing: { ...p, pairedAt: new Date().toISOString() } });
    await refreshBadge();
    if (r.ok) flush();
    return { ok: true, connected: r.ok, message: r.ok ? 'Paired and connected.' : `Paired — but ${r.message}` };
  },
  async unpair() {
    await chrome.storage.local.remove(['pairing', 'status']);
    await refreshBadge();
    return { ok: true };
  },
  async test() {
    const r = await ping();
    if (r.ok) flush();
    return r;
  },
  async accounts() {
    return call('/ext/accounts');
  },
  async lookup({ url, company, companyUrl }) {
    const qs = new URLSearchParams({ url, company: company || '', companyUrl: companyUrl || '' });
    const r = await call(`/ext/lookup?${qs}`);
    await setStatus(r.ok ? { kind: 'ok', message: 'Connected' } : { kind: r.kind, message: r.message });
    if (r.ok) flush(); // the app is up: deliver anything waiting
    return r;
  },
  async capture({ body }) {
    const r = await call('/ext/capture', { method: 'POST', body });
    if (r.ok) {
      await setStatus({ kind: 'ok', message: 'Connected' });
      flush();
      return r;
    }
    if (r.kind === 'rejected') return r; // fix and retry from the page; queueing won't help
    await enqueue(body, r.message);
    await setStatus({ kind: r.kind, message: r.message });
    return { ...r, queued: true };
  },
  async flush() {
    return flush();
  },
  async retry({ id }) {
    const q = await getQueue();
    for (const x of q) if (!id || x.id === id) x.state = 'waiting';
    await saveQueue(q);
    return flush();
  },
  async remove({ id }) {
    await saveQueue((await getQueue()).filter((x) => x.id !== id));
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = msg && handlers[msg.type];
  if (!h) return false;
  Promise.resolve()
    .then(() => h(msg))
    .then(sendResponse, (e) => sendResponse({ ok: false, kind: 'error', message: (e && e.message) || String(e) }));
  return true; // async response
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) flush();
});
chrome.runtime.onStartup.addListener(() => {
  refreshBadge();
  flush();
});
chrome.runtime.onInstalled.addListener(async (d) => {
  await refreshBadge();
  if (d.reason === 'install' && !(await getPairing())) chrome.action.openPopup?.().catch(() => {});
});
