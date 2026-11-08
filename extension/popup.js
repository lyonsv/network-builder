/* Network Builder popup: pairing, connection status and the queue of profiles waiting to be sent. */
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function flash(kind, text) {
  const d = document.createElement('div');
  d.className = `msg ${kind}`;
  d.textContent = text;
  $('flash').replaceChildren(d);
}

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

async function render() {
  const st = await send({ type: 'status' });
  const pill = $('pill');
  const kind = st.status?.kind;
  if (!st.paired) {
    pill.className = 'pill warn';
    pill.textContent = 'Not paired';
  } else if (kind === 'ok') {
    pill.className = 'pill ok';
    pill.textContent = 'Connected';
  } else if (kind === 'offline') {
    pill.className = 'pill warn';
    pill.textContent = 'App not running';
  } else if (kind) {
    pill.className = 'pill err';
    pill.textContent = kind === 'unpaired' ? 'Pairing rejected' : 'Problem';
  } else {
    pill.className = 'pill';
    pill.textContent = '';
  }
  $('pairSec').hidden = st.paired;
  $('connSec').hidden = !st.paired;
  if (st.paired) {
    $('where').textContent = st.url.replace('http://', '');
    const m = document.createElement('div');
    m.className = `msg ${kind === 'ok' ? 'ok' : kind === 'offline' ? 'warn' : kind ? 'err' : 'warn'}`;
    m.textContent = kind === 'ok' ? `Connected to Network Builder${st.status?.at ? ` (checked ${ago(st.status.at)})` : ''}.` : st.status?.message || 'Not checked yet — click Test connection.';
    $('connMsg').replaceChildren(m);
  }

  const q = st.queue || [];
  const box = $('queue');
  if (!q.length) {
    box.innerHTML = '<div class="empty">Nothing waiting — everything you added has been delivered.</div>';
  } else {
    box.replaceChildren(
      ...q.map((x) => {
        const d = document.createElement('div');
        d.className = `q ${x.state}`;
        const t = document.createElement('div');
        t.className = 't';
        const b = document.createElement('b');
        b.textContent = `${x.name}${x.account ? ` → ${x.account}` : ''}`;
        const when = document.createElement('span');
        when.className = 'muted';
        when.textContent = ago(x.queuedAt);
        const rm = document.createElement('button');
        rm.className = 'link';
        rm.textContent = 'Remove';
        rm.title = 'Discard this saved profile';
        rm.onclick = async () => {
          await send({ type: 'remove', id: x.id });
          render();
        };
        t.append(b, when, rm);
        if (x.state === 'failed') {
          const re = document.createElement('button');
          re.className = 'link';
          re.textContent = 'Retry';
          re.onclick = async () => {
            await send({ type: 'retry', id: x.id });
            render();
          };
          t.append(re);
        }
        const e = document.createElement('div');
        e.className = 'e muted';
        e.textContent = x.state === 'failed' ? `Couldn’t add: ${x.error}` : x.error ? `Waiting: ${x.error}` : 'Waiting to send';
        d.append(t, e);
        return d;
      }),
    );
  }
  $('queueActions').hidden = !q.length;
}

$('pairBtn').onclick = async () => {
  const r = await send({ type: 'pair', code: $('code').value });
  if (r && r.ok) {
    flash(r.connected ? 'ok' : 'warn', r.message);
    $('code').value = '';
  } else flash('err', (r && r.message) || 'Pairing failed.');
  render();
};
$('testBtn').onclick = async () => {
  $('testBtn').disabled = true;
  const r = await send({ type: 'test' });
  $('testBtn').disabled = false;
  flash(r.ok ? 'ok' : r.kind === 'offline' ? 'warn' : 'err', r.ok ? 'Connected — Network Builder is running.' : r.message);
  render();
};
$('repairBtn').onclick = () => {
  $('pairSec').hidden = false;
  $('code').focus();
};
$('unpairBtn').onclick = async () => {
  await send({ type: 'unpair' });
  flash('warn', 'Unpaired. Saved profiles stay here until you pair again.');
  render();
};
$('retryAll').onclick = async () => {
  const r = await send({ type: 'retry' });
  if (r && typeof r.sent === 'number') {
    flash(r.sent ? 'ok' : 'warn', r.sent ? `Sent ${r.sent}.` : 'Still waiting — see the message on each item.');
  }
  render();
};

render();
send({ type: 'test' }).then(render);
