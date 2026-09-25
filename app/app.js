/* X reply sidekick - Android PWA.
 * Talks only to the sidekick server (/api/*) with the app password.
 * SAFETY: never posts. "Reply" copies a draft and opens the post in the X app;
 * you paste and press Reply yourself.
 * All post text comes from X and is untrusted: it is only ever set via
 * textContent, never innerHTML.
 */
const $ = (id) => document.getElementById(id);
const LS = {
  get(k, d = '') { try { return localStorage.getItem('sk_' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sk_' + k, v); } catch { /* private mode */ } },
};
const ACTIVE = ['created', 'fired', 'working', 'fetching', 'scoring'];
const state = { items: [], outreach: [], jobs: [], blocked: [], scout: null, seg: 'ready', filter: 'all', picked: new Set(), pollTimer: null };

/* ---------------- api ---------------- */

function serverBase() {
  return (LS.get('server') || location.origin).replace(/\/$/, '');
}

async function api(path, body) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const res = await fetch(serverBase() + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidekick-Key': LS.get('password'),
        'ngrok-skip-browser-warning': 'true',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    let data = {};
    try { data = await res.json(); } catch { data = { error: 'server sent non-JSON (' + res.status + ')' }; }
    if (!res.ok) {
      const err = new Error(data.error || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('server timed out');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- helpers ---------------- */

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) n.append(kid);
  return n;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function banner(msg, isErr = false) {
  const b = $('banner');
  b.hidden = !msg;
  if (msg) { b.textContent = msg; b.className = 'banner' + (isErr ? ' err' : ''); }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = el('textarea'); ta.value = text; document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

function ago(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - new Date(String(ts).replace(' ', 'T')).getTime()) / 60000);
  if (!isFinite(m)) return '';
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  if (m < 1440) return Math.round(m / 60) + 'h';
  return Math.round(m / 1440) + 'd';
}

function agoText(ts) {
  const a = ago(ts);
  return a === 'now' ? 'just now' : a ? a + ' ago' : '';
}

function num(n) {
  if (n === null || n === undefined) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function handleOf(x) { return String(x || '').replace(/^@/, ''); }
function busy(btn, label) {
  const prev = btn.textContent; btn.disabled = true; btn.textContent = label;
  return () => { btn.disabled = false; btn.textContent = prev; };
}
function postText(it) { return it.tweet_text || it.title || it.text || ''; }
function postUrl(it) { return it.tweet_url || it.url || ''; }

/* Action sheet (the ⋯ menu). */
function sheet(title, actions) {
  const body = $('sheetBody');
  body.replaceChildren(el('div', { class: 'sheet-title', text: title }));
  for (const a of actions) {
    body.append(el('button', { class: a.danger ? 'danger' : '', text: a.label, onclick: () => { closeSheet(); a.run(); } }));
  }
  body.append(el('button', { text: 'Cancel', onclick: closeSheet }));
  $('sheet').hidden = false;
}
function closeSheet() { $('sheet').hidden = true; }
$('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

/* ---------------- navigation ---------------- */

const TITLES = { replies: 'Replies', scout: 'Scout', outreach: 'Outreach', settings: 'Settings' };
function showTab(name) {
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  $('title').textContent = TITLES[name];
  LS.set('tab', name);
  updateActionbar();
  if (name === 'scout') loadScout();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function currentTab() { return document.querySelector('.tabbar button.on').dataset.tab; }

function showSeg(name) {
  state.seg = name;
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.seg === name));
  document.querySelectorAll('[data-segpanel]').forEach((p) => { p.hidden = p.dataset.segpanel !== name; });
}
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => showSeg(b.dataset.seg)));

/* ---------------- load ---------------- */

async function refresh() {
  const needsServer = !LS.get('server') && location.hostname.endsWith('github.io');
  if (!LS.get('password') || needsServer) {
    banner('Add the server URL and password in Settings.');
    $('dot').className = 'dot';
    showTab('settings');
    return;
  }
  try {
    const [h, q, o, j, b] = await Promise.all([api('/api/health'), api('/api/queue'), api('/api/outreach'), api('/api/jobs'), api('/api/blocklist').catch(() => ({ items: [] }))]);
    state.items = q.items || [];
    state.outreach = o.items || [];
    state.jobs = j.jobs || [];
    state.blocked = b.items || [];
    $('dot').className = 'dot ok';
    const warn = [];
    if (!h.routine) warn.push('Claude routine is not connected, so drafting is off.');
    if (!h.armory) warn.push('Armory is not connected, so scouting is off.');
    banner(warn.join(' '));
    renderReplies();
    renderOutreach();
    renderSettingsLists();
    schedulePoll();
  } catch (e) {
    $('dot').className = 'dot err';
    banner(e.status === 401 ? 'Wrong password. Fix it in Settings.' : 'Server unreachable: ' + e.message, true);
  }
}

function activeJobs(kind) {
  return state.jobs.filter((j) => (!kind || j.kind === kind) && ACTIVE.includes(j.status) && j.expires * 1000 > Date.now());
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (activeJobs().length) state.pollTimer = setTimeout(async () => {
    await refresh();
    if (currentTab() === 'scout') loadScout();
  }, 10000);
}

/* ---------------- replies ---------------- */

function avatar(name) {
  return el('div', { class: 'avatar', text: (handleOf(name)[0] || '?').toUpperCase() });
}

function whoRow(author, sub, onMore) {
  return el('div', { class: 'who' },
    avatar(author),
    el('div', { class: 'who-name' }, el('b', { text: author ? '@' + handleOf(author) : 'post' }), el('span', { text: sub })),
    onMore ? el('button', { class: 'more-btn', 'aria-label': 'More', text: '⋯', onclick: onMore }) : null);
}

function postBlock(text, cls = 'post') {
  const p = el('div', { class: cls, text: text || 'Text not fetched yet. Claude will fetch it.' });
  p.addEventListener('click', () => p.classList.toggle('open'));
  return p;
}

function itemMenu(it) {
  const h = handleOf(it.author);
  const actions = [];
  if (postUrl(it)) actions.push({ label: 'Open post on X', run: () => window.open(postUrl(it), '_blank', 'noopener') });
  if (it.status === 'queued') actions.push({ label: 'Draft just this one', run: () => askDraft([it.id]) });
  if (it.status === 'queued' || it.status === 'drafted') actions.push({ label: 'Skip', run: () => setStatus(it, 'skipped') });
  if (it.status === 'posted' || it.status === 'skipped') actions.push({ label: 'Move back to waiting', run: () => setStatus(it, 'queued') });
  if (h) actions.push({ label: 'Block @' + h, danger: true, run: () => blockUser(h) });
  sheet(h ? '@' + h : 'Post', actions);
}

function voiceLabel(angle) {
  const first = String(angle || '').split(/\s[·\-–|]\s/)[0].trim();
  return first && first.length <= 24 ? first : 'Draft';
}

function draftCard(it) {
  const card = el('div', { class: 'card' },
    whoRow(it.author, ago(it.ts) + (it.author_followers ? ' · ' + num(it.author_followers) + ' followers' : ''), () => itemMenu(it)),
    postBlock(postText(it)));
  if (it.agent_note) card.append(el('div', { class: 'flag' }, el('b', { text: '!' }), el('span', { text: it.agent_note })));

  let chosen = typeof it.chosen_index === 'number' ? it.chosen_index : null;
  const sent = el('textarea', { rows: 2, placeholder: 'What you actually sent (teaches Claude your voice)' });
  if (it.posted_text) { sent.value = it.posted_text; sent.dataset.dirty = '1'; }
  sent.addEventListener('input', () => { sent.dataset.dirty = '1'; });
  const sentWrap = el('div', { class: 'sent-edit' }, sent);
  sentWrap.hidden = !it.posted_text;

  const drafts = el('div', { class: 'drafts' });
  (it.drafts || []).forEach((d, idx) => {
    const angle = el('div', { class: 'angle', text: d.angle || '' });
    angle.hidden = true;
    const box = el('div', { class: 'draft' + (chosen === idx ? ' chosen' : '') },
      el('div', { class: 'draft-text', text: d.text }));
    const pick = () => {
      chosen = idx;
      drafts.querySelectorAll('.draft').forEach((n, k) => n.classList.toggle('chosen', k === idx));
      if (!sent.dataset.dirty) sent.value = d.text;
    };
    box.append(el('div', { class: 'draft-foot' },
      el('button', { class: 'voice', text: voiceLabel(d.angle), title: 'Why this reply', onclick: () => { angle.hidden = !angle.hidden; } }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn sm', text: 'Copy', onclick: async () => { pick(); toast((await copy(d.text)) ? 'Copied' : 'Copy failed', false); } }),
      el('button', { class: 'btn sm primary', text: 'Reply', onclick: async () => {
        pick();
        const ok = await copy(d.text);
        toast(ok ? 'Copied. Paste it on X.' : 'Copy failed. Long-press the text.', !ok);
        if (postUrl(it)) window.open(postUrl(it), '_blank', 'noopener');
      } })), angle);
    drafts.append(box);
  });
  card.append(drafts);

  card.append(sentWrap, el('div', { class: 'card-foot' },
    el('button', { class: 'btn primary', text: 'Posted', onclick: (e) => {
      const text = sent.value || (chosen !== null ? it.drafts[chosen].text : '');
      finish(it, 'posted', text, chosen, e.target);
    } }),
    el('button', { class: 'btn', text: sentWrap.hidden ? 'Edit sent text' : 'Save text', onclick: async (e) => {
      if (sentWrap.hidden) { sentWrap.hidden = false; e.target.textContent = 'Save text'; sent.focus(); return; }
      try { await api('/api/queue/update', { id: it.id, posted_text: sent.value }); toast('Saved'); } catch (err) { toast(err.message, true); }
    } })));
  return card;
}

function waitingCard(it) {
  const card = el('div', { class: 'card' },
    whoRow(it.author, it.drafting_job ? 'Claude is drafting…' : ago(it.ts), () => itemMenu(it)),
    postBlock(postText(it), 'post short'));
  if (it.agent_note) card.append(el('div', { class: 'flag' }, el('b', { text: '!' }), el('span', { text: it.agent_note })));
  return card;
}

function doneRow(it) {
  return el('div', { class: 'row-card' }, avatar(it.author),
    el('div', { class: 'grow' },
      el('b', { text: '@' + handleOf(it.author) + ' · ' + it.status }),
      el('div', { class: 'line', text: it.posted_text || postText(it) })),
    el('button', { class: 'more-btn', text: '⋯', onclick: () => itemMenu(it) }));
}

function renderReplies() {
  const ready = state.items.filter((i) => i.status === 'drafted');
  const waiting = state.items.filter((i) => i.status === 'queued');
  const done = state.items.filter((i) => i.status === 'posted' || i.status === 'skipped').slice(0, 40);
  $('readyCount').textContent = ready.length || '';
  $('waitingCount').textContent = waiting.length || '';
  $('navBadge').textContent = ready.length || '';
  $('draftAllBtn').disabled = !waiting.length || activeJobs('draft').length > 0;
  $('draftAllBtn').textContent = waiting.length ? 'Draft all ' + waiting.length + ' with Claude' : 'Nothing waiting';

  const job = activeJobs('draft')[0] || state.jobs.find((j) => j.kind === 'draft' && j.status === 'failed' && Date.now() - new Date(j.ts.replace(' ', 'T')).getTime() < 3600e3);
  const pill = $('jobPill');
  pill.hidden = !job;
  pill.replaceChildren();
  if (job) {
    if (ACTIVE.includes(job.status)) pill.append(el('span', { class: 'spin' }), 'Claude is drafting…');
    else pill.append('Drafting failed: ' + (job.error || 'see session'));
    if (job.session_url) pill.append(el('a', { href: job.session_url, target: '_blank', rel: 'noopener', text: 'Watch' }));
  }

  const fill = (id, list, fn, emptyText) => {
    const box = $(id);
    box.replaceChildren(...(list.length ? list.map(fn) : [el('div', { class: 'empty', text: emptyText })]));
  };
  fill('readyList', ready, draftCard, job && ACTIVE.includes(job.status) ? 'Drafts will show up here in a few minutes.' : 'No drafts yet. Share a post from X, or run Scout.');
  fill('waitingList', waiting, waitingCard, 'Nothing waiting.');
  fill('doneList', done, doneRow, 'Nothing here yet.');
}

async function finish(it, status, postedText, chosen, btn) {
  const done = busy(btn, '…');
  try {
    const body = { id: it.id, status };
    if (typeof postedText === 'string') body.posted_text = postedText;
    if (typeof chosen === 'number') body.chosen_index = chosen;
    await api('/api/queue/update', body);
    toast(status === 'posted' ? 'Nice. Marked posted.' : 'Skipped');
    await refresh();
  } catch (e) { toast(e.message, true); done(); }
}

async function setStatus(it, status) {
  try { await api('/api/queue/update', { id: it.id, status }); await refresh(); } catch (e) { toast(e.message, true); }
}

async function blockUser(handle) {
  try {
    const r = await api('/api/block', { handle });
    toast('Blocked @' + handle + (r.skipped ? ' · removed ' + r.skipped : ''));
    await refresh();
    if (currentTab() === 'scout') renderScout();
  } catch (e) { toast(e.message, true); }
}

async function askDraft(ids, btn) {
  const done = btn ? busy(btn, 'Asking Claude…') : () => {};
  try {
    const r = await api('/api/draft', { ids, account: LS.get('account', 'abhiijayVinayak') });
    if (r.job && r.job.status === 'failed') toast(r.job.error || 'Claude run failed', true);
    else toast('Claude is drafting. Takes a few minutes.');
    showSeg('ready');
  } catch (e) { toast(e.message, true); }
  done();
  await refresh();
}

$('draftAllBtn').addEventListener('click', (e) => askDraft(null, e.target));
$('clearDoneBtn').addEventListener('click', async () => {
  try { const r = await api('/api/queue/clear-done', {}); toast('Removed ' + r.removed); refresh(); } catch (e) { toast(e.message, true); }
});

/* ---------------- add / share ---------------- */

async function addLink(url, note, draft) {
  const r = await api('/api/share', { url, note });
  let msg = r.kind === 'outreach'
    ? (r.duplicate ? '@' + r.handle + ' is already in outreach' : 'Added @' + r.handle + ' to outreach')
    : (r.duplicate ? 'Already queued' : 'Queued');
  if (draft && r.kind === 'reply' && r.id) {
    const d = await api('/api/draft', { ids: [r.id], account: LS.get('account', 'abhiijayVinayak') });
    msg += d.job && d.job.status === 'failed' ? '. Claude failed: ' + d.job.error : '. Claude is drafting.';
  }
  return msg;
}

$('addBtn').addEventListener('click', async (e) => {
  const url = $('addUrl').value.trim();
  if (!url) return;
  const done = busy(e.target, '…');
  try { toast(await addLink(url, '', false)); $('addUrl').value = ''; await refresh(); } catch (err) { toast(err.message, true); }
  done();
});

function handleShareLaunch() {
  const p = new URLSearchParams(location.search);
  if (!p.has('text') && !p.has('url') && !p.has('title') && !location.pathname.includes('/share')) return;
  const raw = [p.get('url'), p.get('text'), p.get('title')].filter(Boolean).join(' ');
  const m = raw.match(/https?:\/\/\S+/);
  const url = m ? m[0] : '';
  history.replaceState(null, '', location.pathname.replace(/share\/?$/, ''));
  const isProfile = url && !/\/status\//.test(url);
  $('shareSheet').hidden = false;
  $('shareUrl').textContent = url || raw || '(nothing shared)';
  $('shareQueueDraft').hidden = !!isProfile;
  $('shareQueue').textContent = isProfile ? 'Add to outreach' : 'Just add';
  const go = async (draft, btn) => {
    const done = busy(btn, '…');
    try {
      $('shareResult').textContent = await addLink(url, $('shareNote').value.trim(), draft);
      setTimeout(() => { $('shareSheet').hidden = true; }, 1600);
      await refresh();
    } catch (e) { $('shareResult').textContent = e.message; }
    done();
  };
  $('shareQueue').onclick = (e) => go(false, e.target);
  $('shareQueueDraft').onclick = (e) => go(true, e.target);
  $('shareCancel').onclick = () => { $('shareSheet').hidden = true; };
}

/* ---------------- scout ---------------- */

function scoutRows() {
  const run = state.scout && state.scout.run;
  if (!run) return [];
  const blocked = new Set(state.blocked.map((b) => handleOf(b.handle).toLowerCase()));
  const rows = (run.shortlist && run.shortlist.length ? run.shortlist : run.candidates || [])
    .filter((c) => !blocked.has(handleOf(c.author).toLowerCase()));
  return rows;
}

async function loadScout() {
  try {
    state.scout = await api('/api/scout');
    renderScout();
    const j = state.scout.job;
    clearTimeout(state.scoutTimer);
    if (j && ACTIVE.includes(j.status)) state.scoutTimer = setTimeout(loadScout, 10000);
  } catch (e) { $('scoutStatus').textContent = e.message; }
}

const SCOUT_STATUS = { created: 'Starting…', fetching: 'Fetching posts', scoring: 'Claude is scoring', fired: 'Claude is scoring', working: 'Claude is scoring', done: 'Done', failed: 'Failed' };

function renderScout() {
  const { run, job } = state.scout || {};
  const running = job && ACTIVE.includes(job.status);
  $('scoutBtn').disabled = !!running;
  $('scoutBtn').textContent = running ? 'Running…' : 'Run scout';
  const bits = [];
  if (job) bits.push((SCOUT_STATUS[job.status] || job.status) + (job.progress && running ? ' · ' + job.progress : '') + ' · ' + agoText(job.ts));
  if (run && run.credits_remaining != null) bits.push(num(run.credits_remaining) + ' credits left');
  $('scoutStatus').textContent = job && job.error ? 'Failed: ' + job.error : bits.join(' · ');

  const all = scoutRows();
  const gapCount = all.filter((c) => c.high_view_low_eng).length;
  $('fAll').textContent = all.length || '';
  $('fGap').textContent = gapCount || '';
  $('scoutToolbar').hidden = !all.length;
  const rows = state.filter === 'gap' ? all.filter((c) => c.high_view_low_eng) : all;
  const live = new Set(all.map((c) => c.url));
  for (const u of [...state.picked]) if (!live.has(u)) state.picked.delete(u);

  const list = $('scoutList');
  if (!run) { list.replaceChildren(el('div', { class: 'empty', text: 'Run the scout to find posts worth replying to.' })); updateActionbar(); return; }
  if (!rows.length) { list.replaceChildren(el('div', { class: 'empty', text: running ? 'Looking for posts…' : 'Nothing found in the last 24h.' })); updateActionbar(); return; }
  list.replaceChildren(...rows.map(scoutCard));
  const allOn = rows.every((c) => state.picked.has(c.url));
  $('selectAll').textContent = allOn ? 'Clear' : 'Select all';
  updateActionbar();
}

function scoutCard(c) {
  const card = el('div', { class: 'card scout-card' + (state.picked.has(c.url) ? ' sel' : '') });
  const stats = el('div', { class: 'stats' });
  if (c.high_view_low_eng) stats.append(el('span', { class: 'stat gap', text: 'High views, low engagement' }));
  if (c.views != null) stats.append(el('span', { class: 'stat', text: num(c.views) + ' views' }));
  if (c.replies != null) stats.append(el('span', { class: 'stat', text: num(c.replies) + ' replies' }));
  if (c.likes != null) stats.append(el('span', { class: 'stat', text: num(c.likes) + ' likes' }));
  if (c.suggested_move) stats.append(el('span', { class: 'stat move', text: c.suggested_move }));
  const body = el('div', { class: 'scout-body' },
    whoRow(c.author, c.age_hours + 'h' + (c.author_followers ? ' · ' + num(c.author_followers) + ' followers' : ''), (e) => {
      e.stopPropagation();
      const h = handleOf(c.author);
      sheet('@' + h, [
        { label: 'Open post on X', run: () => window.open(c.url, '_blank', 'noopener') },
        { label: 'Block @' + h, danger: true, run: () => blockUser(h) },
      ]);
    }),
    c.summary ? el('div', { class: 'summary', text: c.summary }) : null,
    postBlock(c.text, 'post short'),
    stats);
  card.append(el('div', { class: 'check', text: '✓' }), body);
  card.addEventListener('click', (e) => {
    if (e.target.closest('.more-btn')) return;
    if (e.target.closest('.post')) return; // tapping text expands it
    state.picked.has(c.url) ? state.picked.delete(c.url) : state.picked.add(c.url);
    card.classList.toggle('sel', state.picked.has(c.url));
    updateActionbar();
  });
  return card;
}

function updateActionbar() {
  const n = state.picked.size;
  $('scoutActions').hidden = currentTab() !== 'scout' || !n;
  $('scoutPickDraft').textContent = 'Draft ' + n + ' selected';
  const rows = state.filter === 'gap' ? scoutRows().filter((c) => c.high_view_low_eng) : scoutRows();
  $('selectAll').textContent = rows.length && rows.every((c) => state.picked.has(c.url)) ? 'Clear' : 'Select all';
}

$('selectAll').addEventListener('click', () => {
  const rows = state.filter === 'gap' ? scoutRows().filter((c) => c.high_view_low_eng) : scoutRows();
  const allOn = rows.every((c) => state.picked.has(c.url));
  rows.forEach((c) => (allOn ? state.picked.delete(c.url) : state.picked.add(c.url)));
  renderScout();
});

document.querySelectorAll('.chip[data-filter]').forEach((b) => b.addEventListener('click', () => {
  state.filter = b.dataset.filter;
  document.querySelectorAll('.chip[data-filter]').forEach((x) => x.classList.toggle('on', x === b));
  renderScout();
}));

$('scoutBtn').addEventListener('click', async (e) => {
  const done = busy(e.target, 'Starting…');
  try { await api('/api/scout', {}); toast('Scout started'); } catch (err) { toast(err.message, true); }
  done();
  loadScout();
});

async function pickScout(draft, btn) {
  const urls = [...state.picked];
  if (!urls.length) return;
  const done = busy(btn, '…');
  try {
    const r = await api('/api/scout/pick', { run_id: state.scout.run.id, urls, draft, account: LS.get('account', 'abhiijayVinayak') });
    toast(draft ? (r.draft_error ? 'Queued, but drafting failed: ' + r.draft_error : 'Claude is drafting ' + urls.length) : 'Queued ' + r.added, !!r.draft_error);
    state.picked.clear();
    await refresh();
    renderScout();
    if (draft && !r.draft_error) { showTab('replies'); showSeg('ready'); }
  } catch (e) { toast(e.message, true); }
  done();
}
$('scoutPickDraft').addEventListener('click', (e) => pickScout(true, e.target));
$('scoutPick').addEventListener('click', (e) => pickScout(false, e.target));

/* ---------------- outreach + settings ---------------- */

function renderOutreach() {
  const rows = state.outreach.filter((o) => o.status === 'queued');
  $('outreachList').replaceChildren(...(rows.length ? rows.map((o) => el('div', { class: 'row-card' }, avatar(o.handle),
    el('div', { class: 'grow' },
      el('b', { text: '@' + o.handle }),
      el('div', { class: 'line', text: o.bio || o.display_name || o.followers_text || '' })),
    el('a', { class: 'link', href: o.profile_url, target: '_blank', rel: 'noopener', text: 'Open' })))
    : [el('div', { class: 'empty', text: 'No profiles saved.' })]));
}

const JOB_TEXT = { created: 'starting', fired: 'started', working: 'working', fetching: 'fetching', scoring: 'scoring', done: 'done', failed: 'failed' };
function renderSettingsLists() {
  $('blockList').replaceChildren(...(state.blocked.length ? state.blocked.map((b) => el('div', { class: 'row-card' }, avatar(b.handle),
    el('div', { class: 'grow' }, el('b', { text: '@' + b.handle }), el('div', { class: 'line', text: 'blocked ' + agoText(b.ts) })),
    el('button', { class: 'link', text: 'Unblock', onclick: async () => {
      try { await api('/api/unblock', { handle: b.handle }); toast('Unblocked @' + b.handle); refresh(); } catch (e) { toast(e.message, true); }
    } })))
    : [el('div', { class: 'hint', text: 'Nobody blocked. Use ⋯ on a post to block someone.' })]));
  $('jobsList').replaceChildren(...(state.jobs.length ? state.jobs.slice(0, 8).map((j) => el('div', { class: 'row-card' },
    el('div', { class: 'grow' },
      el('b', { text: (j.kind === 'draft' ? 'Drafting' : 'Scout') + ' · ' + (JOB_TEXT[j.status] || j.status) }),
      el('div', { class: 'line', text: j.error || j.report || agoText(j.ts) })),
    j.session_url ? el('a', { class: 'link', href: j.session_url, target: '_blank', rel: 'noopener', text: 'Open' }) : null))
    : [el('div', { class: 'hint', text: 'No runs yet.' })]));
}

$('serverUrl').value = LS.get('server');
$('password').value = LS.get('password');
$('account').value = LS.get('account', 'abhiijayVinayak');
$('account').addEventListener('change', () => LS.set('account', $('account').value));
$('saveSettings').addEventListener('click', async (e) => {
  LS.set('server', $('serverUrl').value.trim());
  LS.set('password', $('password').value);
  LS.set('account', $('account').value);
  const done = busy(e.target, 'Testing…');
  try {
    const h = await api('/api/health');
    $('settingsResult').textContent = 'Connected · Armory ' + (h.armory ? 'on' : 'off') + ' · Claude ' + (h.routine ? 'on' : 'off');
    await refresh();
  } catch (err) {
    $('settingsResult').textContent = err.status === 401 ? 'Wrong password.' : 'Failed: ' + err.message;
  }
  done();
});

$('refreshBtn').addEventListener('click', () => { refresh(); if (currentTab() === 'scout') loadScout(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

/* ---------------- boot ---------------- */

(function takeServerParam() {
  const p = new URLSearchParams(location.search);
  const s = p.get('server');
  if (s && /^https:\/\//.test(s)) {
    LS.set('server', s.replace(/\/$/, ''));
    $('serverUrl').value = LS.get('server');
    p.delete('server');
    history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : ''));
  }
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
handleShareLaunch();
const startTab = LS.get('tab', 'replies');
showTab(startTab === 'settings' && LS.get('password') ? 'replies' : startTab);
refresh();
