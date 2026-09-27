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
/* `action` is optional: {label, run} renders an inline button, used for undoing
 * a skip. Without it this behaves exactly as before. */
function toast(msg, isErr = false, action = null) {
  const t = $('toast');
  t.replaceChildren(document.createTextNode(msg));
  if (action) {
    t.append(el('button', {
      class: 'toast-action',
      text: action.label,
      onclick: () => { t.hidden = true; clearTimeout(toastTimer); action.run(); },
    }));
  }
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 2600);
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
  $('toast').hidden = true;   // a leftover toast would cover the sheet's title
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

const TITLES = { replies: 'Replies', scout: 'Scout', linkedin: 'LinkedIn', xdm: 'X DMs', settings: 'Settings' };
function showTab(name) {
  if (!TITLES[name]) name = 'replies';   // e.g. the old "outreach" tab saved in storage
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  $('title').textContent = TITLES[name];
  LS.set('tab', name);
  updateActionbar();
  if (name === 'scout') loadScout();
  dmTicker();
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
    const [h, q, o, j, b, d] = await Promise.all([api('/api/health'), api('/api/queue'), api('/api/outreach'), api('/api/jobs'),
      api('/api/blocklist').catch(() => ({ items: [] })),
      // An older server has no /api/dm: the DM tabs then say it needs a restart.
      api('/api/dm').catch((e) => ({ __error: e }))]);
    state.items = q.items || [];
    state.outreach = o.items || [];
    state.jobs = j.jobs || [];
    state.blocked = b.items || [];
    takeDm(d);
    $('dot').className = 'dot ok';
    if (h.sends != null) $('sendsCount').textContent = 'Replies Claude learns from: ' + h.sends;
    const warn = [];
    if (!h.routine) warn.push('Claude routine is not connected, so drafting is off.');
    if (!h.armory) warn.push('Armory is not connected, so scouting is off.');
    banner(warn.join(' '));
    renderReplies();
    renderDmAll();
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
  // Auto-save: at 100 replies a day a separate Save tap per item is friction the
  // learning loop cannot afford, and an unsaved edit teaches nothing.
  let sentTimer;
  const saveSent = async (quiet) => {
    if (sent.dataset.dirty !== '1' || sent.value === (it.posted_text || '')) return;
    const text = sent.value;
    try {
      await api('/api/queue/update', { id: it.id, posted_text: text, sent_verbatim: false });
      it.posted_text = text;
      if (!quiet) toast('Saved to your voice corpus');
    } catch (e) { toast(e.message, true); }
  };
  sent.addEventListener('input', () => {
    sent.dataset.dirty = '1';
    clearTimeout(sentTimer);
    sentTimer = setTimeout(() => saveSent(true), 1200);
  });
  sent.addEventListener('blur', () => { clearTimeout(sentTimer); saveSent(true); });
  // Always visible. This used to be hidden until posted_text already existed,
  // which meant there was no way to enter it in the first place, and "Posted"
  // silently stored the draft as if it were what he sent - teaching the writer
  // its own output back.
  const sentWrap = el('div', { class: 'sent-edit' },
    el('label', { class: 'sent-label', text: 'What you actually sent' }), sent);

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
      el('button', { class: 'btn sm', text: 'Reject', title: 'Bad reply - drop it and record why',
        onclick: () => rejectDraft(it, idx, d) }),
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
      const typed = sent.value.trim();
      if (typed) { finish(it, 'posted', typed, chosen, e.target, sent.dataset.dirty === '1' ? false : null); return; }
      // Nothing typed. Ask instead of assuming the draft is what he sent - that
      // assumption is what filled the corpus with the writer's own output.
      const draft = chosen !== null ? it.drafts[chosen] : (it.drafts || [])[0];
      sheet('What did you send?', [
        ...(draft ? [{ label: 'Sent a draft word for word',
          run: () => finish(it, 'posted', draft.text, chosen, e.target, true) }] : []),
        { label: 'I wrote my own - let me paste it',
          run: () => { sent.focus(); toast('Paste it, then tap Posted again'); } },
        { label: 'Just mark posted (do not learn from it)',
          run: () => finish(it, 'posted', undefined, chosen, e.target) },
      ]);
    } }),
    el('button', { class: 'btn', text: 'Save now', onclick: async (e) => {
      const done = busy(e.target, '…');
      sent.dataset.dirty = '1';
      await saveSent(false);
      done();
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

async function finish(it, status, postedText, chosen, btn, verbatim) {
  const done = busy(btn, '…');
  try {
    const body = { id: it.id, status };
    if (typeof postedText === 'string') body.posted_text = postedText;
    if (typeof chosen === 'number') body.chosen_index = chosen;
    if (typeof verbatim === 'boolean') body.sent_verbatim = verbatim;
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
  const who = r.platform === 'linkedin' ? r.handle : '@' + r.handle;
  const where = r.platform === 'linkedin' ? 'LinkedIn' : 'X DM';
  let msg = r.kind === 'outreach'
    ? (r.duplicate ? who + ' is already saved' : 'Saved ' + who + ' (' + where + ' tab, Saved)')
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
  const isProfile = url && (/linkedin\.com\/in\//i.test(url)
    || (/(?:x|twitter)\.com\//i.test(url) && !/\/status\//.test(url)));
  $('shareSheet').hidden = false;
  $('shareUrl').textContent = url || raw || '(nothing shared)';
  $('shareQueueDraft').hidden = !!isProfile;
  $('shareQueue').textContent = isProfile ? 'Save for outreach' : 'Just add';
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

/* Reject one draft. The reason is the useful part: it is what turns a thrown-away
 * draft into something the writer can learn a tell from. */
const REJECT_REASONS = [
  'Sounds like AI',
  'Not his voice',
  'Claims something untrue',
  'Same point as another draft',
  'Wrong read of the post',
];

function rejectDraft(it, idx, d) {
  sheet('Reject this reply?', REJECT_REASONS.map((r) => ({
    label: r, run: () => sendReject(it, idx, r),
  })).concat([{ label: 'Just reject it', run: () => sendReject(it, idx, '') }]));
}

async function sendReject(it, idx, reason) {
  try {
    const r = await api('/api/draft/reject', { id: it.id, index: idx, reason });
    it.drafts.splice(idx, 1);
    toast(r.left ? 'Rejected · ' + r.left + ' left' : 'Rejected · back to waiting');
    await refresh();
  } catch (e) { toast(e.message, true); }
}

/* Log a reply sent straight from X. Without this the corpus only ever learns
 * from posts that happened to pass through the queue. */
$('addSend').addEventListener('click', async (e) => {
  const text = $('sendText').value.trim();
  if (!text) { toast('Paste the reply you sent', true); $('sendText').focus(); return; }
  const done = busy(e.target, 'Adding…');
  try {
    const r = await api('/api/sends/add', { posted_text: text, post: $('sendPost').value.trim() });
    $('sendText').value = ''; $('sendPost').value = '';
    $('addSendResult').textContent = r.duplicate
      ? 'Already in your corpus.' : 'Added. Claude learns from ' + r.total + ' of your replies.';
    toast(r.duplicate ? 'Already saved' : 'Added to your voice');
    refresh();
  } catch (err) { toast(err.message, true); }
  done();
});

/* ---------------- scout ---------------- */

function scoutRows() {
  const run = state.scout && state.scout.run;
  if (!run) return [];
  const blocked = new Set(state.blocked.map((b) => handleOf(b.handle).toLowerCase()));
  // A used-up shortlist is not the same as no shortlist: falling back to raw
  // candidates there would re-offer posts Claude deliberately did not rank.
  const base = run.shortlist && run.shortlist.length ? run.shortlist
    : (run.shortlist_done ? [] : run.candidates || []);
  const rows = base
    .filter((c) => !blocked.has(handleOf(c.author).toLowerCase()))
    .filter((c) => !c.dismissed);
  return rows;
}

/* Skip one post without blocking its author. Blocking used to be the only way
 * to clear a card, which is a much bigger decision than "not this one". */
async function skipScout(c) {
  const run = state.scout && state.scout.run;
  c.dismissed = true;
  state.picked.delete(c.url);
  renderScout();
  try {
    await api('/api/scout/dismiss', { url: c.url, run_id: run && run.id });
    toast('Skipped', false, { label: 'Undo', run: () => unskipScout(c) });
  } catch (e) {
    c.dismissed = false;
    renderScout();
    toast(e.message);
  }
}

async function unskipScout(c) {
  const run = state.scout && state.scout.run;
  delete c.dismissed;
  renderScout();
  try { await api('/api/scout/undismiss', { url: c.url, run_id: run && run.id }); }
  catch (e) { c.dismissed = true; renderScout(); toast(e.message); }
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
  if (!rows.length) {
    const msg = running ? 'Looking for posts…'
      : run.shortlist_done ? 'All ' + (run.handled_hidden || '') + ' posts from this run are done. Run the scout again for fresh ones.'
      : 'Nothing found in the last 24h.';
    list.replaceChildren(el('div', { class: 'empty', text: msg }));
    updateActionbar(); return;
  }
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
        { label: 'Skip this post', run: () => skipScout(c) },
        { label: 'Block @' + h, danger: true, run: () => blockUser(h) },
      ]);
    }),
    c.summary ? el('div', { class: 'summary', text: c.summary }) : null,
    postBlock(c.text, 'post short'),
    stats);
  const skipBtn = el('button', {
    class: 'scout-skip', text: 'Skip', title: 'Not this post (does not block the author)',
    onclick: (e) => { e.stopPropagation(); skipScout(c); },
  });
  card.append(el('div', { class: 'check', text: '✓' }), body, skipBtn);
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

/* ---------------- DM outreach: the LinkedIn and X DM tabs ----------------
 * One message per person, changed with one Shuffle tap:
 *  - X leads compose it here from a line library (hook + proof + CTA), with the
 *    same follow-on rules as the desktop copy boards;
 *  - LinkedIn leads carry written variants (e.g. Video pitch / Feedback ask).
 * SAFETY: never sends. "Copy + open" puts the message on the clipboard and opens
 * the profile or DM screen; he presses Send in LinkedIn or X himself.
 * Learning loop: "Sent" stores the exact text that went out, and whether it was
 * edited - asked, never assumed, same lesson as posted_text on replies.
 * All lead text is set via textContent only.
 */
const DM_CH = ['linkedin', 'x'];
const DM_NAME = { linkedin: 'LinkedIn', x: 'X' };
const DM_SEGS = [['send', 'To send'], ['sent', 'Sent'], ['done', 'Done'], ['saved', 'Saved']];
const dm = {
  loaded: false, missing: false, error: '', leads: [], libs: {}, stats: {},
  seg: { linkedin: LS.get('dmseg_linkedin', 'send'), x: LS.get('dmseg_x', 'send') },
  camp: { linkedin: LS.get('dmcamp_linkedin', ''), x: LS.get('dmcamp_x', '') },
  defaults: {}, pending: {}, timer: null,
};

function takeDm(d) {
  if (d && d.__error) {
    dm.missing = d.__error.status === 404;
    dm.error = dm.missing ? '' : d.__error.message;
    return;
  }
  dm.loaded = true; dm.missing = false; dm.error = '';
  dm.leads = d.leads || [];
  dm.libs = d.libraries || {};
  dm.stats = d.stats || {};
  buildDmDefaults();
}

/* -- pacing (warnings, never blocks) -- */
function paceCfg(ch) {
  const n = (k, d) => { const v = parseInt(LS.get(k, ''), 10); return Number.isFinite(v) && v >= 0 ? v : d; };
  const min = n('gapmin', 1);
  return { cap: n('cap_' + ch, 20) || 20, min, max: Math.max(min, n('gapmax', 9)) };
}
function strHash(x) { let h = 2166136261; for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function tsMs(ts) { return new Date(String(ts).replace(' ', 'T')).getTime(); }
/* The gap is derived from the last send's timestamp, so it is random but the
 * same on every reload and every device, with nothing extra to store. */
function nextDue(ch) {
  const s = dm.stats[ch] || {};
  if (!s.last_sent_ts) return 0;
  const c = paceCfg(ch);
  return tsMs(s.last_sent_ts) + (c.min + strHash(ch + s.last_sent_ts) % (c.max - c.min + 1)) * 60000;
}
function mmss(ms) { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function paceState(ch) {
  const s = dm.stats[ch] || {};
  const c = paceCfg(ch);
  const now = Date.now();
  const today = (s.sent_today || 0) + '/' + c.cap + ' today';
  if (s.cooldown_until && s.cooldown_until * 1000 > now) {
    return { cls: 'err', text: 'Cooling down ' + mmss(s.cooldown_until * 1000 - now) + ' · ' + DM_NAME[ch] + ' said Failed. Stop the batch.', cool: true };
  }
  if ((s.sent_today || 0) >= c.cap) return { cls: 'warn', text: today + ' · daily cap reached, stop for today', capped: true };
  const due = nextDue(ch);
  if (due > now) return { cls: 'wait', text: today + ' · next one in ' + mmss(due - now), wait: due - now };
  return { cls: 'ok', text: today + ' · ready for the next one' };
}
/* Returns a warning to confirm before copying, or null when it is fine to send. */
function paceGate(ch) {
  const p = paceState(ch);
  if (p.cool) return { title: DM_NAME[ch] + ' blocked a send. Sending during the cooldown risks a longer block or a label.', go: 'Send anyway' };
  if (p.capped) return { title: "That's your daily cap. More today raises the spam risk.", go: 'Send anyway' };
  if (p.wait) return { title: 'The next one is due in ' + mmss(p.wait) + '. The random gap keeps this looking human.', go: 'Send early' };
  return null;
}
function dmTicker() {
  clearInterval(dm.timer);
  const tab = currentTab();
  const ch = tab === 'linkedin' ? 'linkedin' : tab === 'xdm' ? 'x' : null;
  if (!ch) return;
  dm.timer = setInterval(() => {
    const box = document.querySelector('#dm-' + ch + ' .pace');
    if (!box || document.hidden) return;
    const p = paceState(ch);
    box.className = 'pace ' + p.cls;
    box.querySelector('.pace-text').textContent = p.text;
  }, 1000);
}

/* -- the line library composer (port of the copy-board rules) -- */
function libOf(l) { return l.library && !(l.variants && l.variants.length) ? dm.libs[l.library] || null : null; }
function lineFits(item, l) {
  if (!item) return true;
  if (item.maxFollowers && (l.followers || 0) >= item.maxFollowers) return false;
  if (item.name && !String((l.fields || {}).n || '').trim()) return false;
  return true;
}
function libHooks(lib, l) { const all = Object.keys(lib.hooks); const a = all.filter((h) => lineFits(lib.hooks[h], l)); return a.length ? a : all; }
function badProofs(lib, hook) {
  const g = lib.hooks[hook] && lib.hooks[hook].promises;
  return g ? Object.keys(lib.proofs).filter((k) => lib.proofs[k].promises === g) : [];
}
function libProofs(lib, hook, l) {
  const bad = badProofs(lib, hook);
  const base = (lib.hooks[hook].proofs || Object.keys(lib.proofs)).filter((x) => lib.proofs[x] && !bad.includes(x));
  const a = base.filter((x) => lineFits(lib.proofs[x], l));
  if (a.length) return a;
  if (base.length) return base;
  return Object.keys(lib.proofs).filter((x) => !bad.includes(x));
}
function badCtas(lib, hook) {
  const g = lib.hooks[hook] && lib.hooks[hook].gives;
  return g ? Object.keys(lib.ctas).filter((c) => lib.ctas[c].gives === g) : [];
}
function libCtas(lib, hook, proof, l) {
  const bad = badCtas(lib, hook);
  const ok = (x) => lib.ctas[x] && !bad.includes(x) && lineFits(lib.ctas[x], l);
  const pc = (lib.proofs[proof] && lib.proofs[proof].ctas) || Object.keys(lib.ctas);
  const a = pc.filter(ok);
  const b = (lib.hooks[hook].ctas || pc).filter(ok);
  const both = a.filter((x) => b.includes(x));
  if (both.length) return both;
  if (a.length) return a;
  if (b.length) return b;
  return pc.filter((x) => lib.ctas[x] && !bad.includes(x));
}
function fillLine(t, l, sal) {
  const f = l.fields || {};
  return String(t).split('{s}').join(sal || '').split('{p}').join(f.p || l.product || '')
    .split('{plat}').join(f.plat || '').split('{n}').join(f.n || 'there')
    .split('{q}').join(f.q || '').split('{cat}').join(f.cat || '');
}
function composeLines(lib, l, k) {
  return [lib.hooks[k.hook].t, lib.proofs[k.proof].t, lib.ctas[k.cta].t]
    .map((t) => fillLine(t, l, k.sal).trim()).join(lib.join === undefined ? '\n\n' : lib.join);
}
function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function drawLines(lib, l, rand) {
  const one = (a) => a[Math.floor(rand() * a.length) % a.length];
  const hook = one(libHooks(lib, l));
  const proof = one(libProofs(lib, hook, l));
  const cta = one(libCtas(lib, hook, proof, l));
  const sals = lib.salutations && lib.salutations.length ? lib.salutations : [''];
  return { hook, proof, cta, sal: one(sals) };
}
function byOrder(a, b) { return (a.order || 0) - (b.order || 0) || (a.n || 0) - (b.n || 0); }
/* Default lines per lead: seeded by the lead id, and redrawn until no two
 * waiting leads would get byte-identical copy - identical DMs at volume are
 * exactly what X throttles. */
function buildDmDefaults() {
  dm.defaults = {};
  const seen = new Set();
  for (const l of dm.leads.filter((x) => x.status === 'ready' && libOf(x)).sort(byOrder)) {
    const lib = libOf(l);
    let k = null;
    for (let t = 0; t < 60; t++) {
      const r = seeded(strHash(l.id + '|' + t)); r(); r();
      k = drawLines(lib, l, r);
      if (!seen.has(composeLines(lib, l, k))) break;
    }
    seen.add(composeLines(lib, l, k));
    dm.defaults[l.id] = k;
  }
}
/* The lines in use: his explicit pick over the default. A line he picked
 * stands even if it is off-pattern; only a line that no longer exists, or
 * one that repeats what the hook already said, is repaired. */
function linesOf(l) {
  const lib = libOf(l);
  if (!lib) return null;
  const man = l.pick || {};
  const k = Object.assign({}, dm.defaults[l.id] || drawLines(lib, l, seeded(strHash(l.id))), man);
  if (!lib.hooks[k.hook]) k.hook = libHooks(lib, l)[0];
  if (!lib.proofs[k.proof] || badProofs(lib, k.hook).includes(k.proof)
      || (!man.proof && !libProofs(lib, k.hook, l).includes(k.proof))) k.proof = libProofs(lib, k.hook, l)[0];
  if (!lib.ctas[k.cta] || badCtas(lib, k.hook).includes(k.cta)
      || (!man.cta && !libCtas(lib, k.hook, k.proof, l).includes(k.cta))) k.cta = libCtas(lib, k.hook, k.proof, l)[0];
  if (k.sal === undefined) k.sal = (lib.salutations || [''])[0];
  return k;
}
function baseMessage(l) {
  if (l.variants && l.variants.length) return l.variants[(l.variant_index || 0) % l.variants.length].text || '';
  const lib = libOf(l);
  return lib ? composeLines(lib, l, linesOf(l)) : '';
}
function messageOf(l) { return typeof l.draft_text === 'string' ? l.draft_text : baseMessage(l); }
function linesLabel(l) {
  if (l.variants && l.variants.length) {
    const v = l.variants[(l.variant_index || 0) % l.variants.length];
    return (v.label || 'Message') + (l.variants.length > 1 ? ' · ' + ((l.variant_index || 0) % l.variants.length + 1) + '/' + l.variants.length : '');
  }
  const k = linesOf(l);
  return k ? k.hook + ' · ' + k.proof + ' · ' + k.cta : 'Message';
}
function openUrl(l) {
  if (l.channel === 'x') {
    return l.recipient_id ? 'https://x.com/messages/compose?recipient_id=' + encodeURIComponent(l.recipient_id)
      : 'https://x.com/' + encodeURIComponent(handleOf(l.handle));
  }
  return l.profile_url;
}
function profileUrl(l) { return l.channel === 'x' ? 'https://x.com/' + encodeURIComponent(handleOf(l.handle)) : l.profile_url; }
function dmWho(l) { return l.channel === 'x' ? '@' + handleOf(l.handle) : (l.name || 'LinkedIn lead'); }
/* Rule checks shown on the card. X: no link in message one, <2k followers. */
function dmRuleWarnings(l, text) {
  const out = [];
  if (l.channel === 'x' && /https?:\/\/|www\.|beamcite\s*\.?\s*com/i.test(text)) out.push('Link in an X first message. X flags this as spam: move it to message two.');
  if (l.channel === 'x' && (l.followers || 0) >= 2000) out.push(num(l.followers) + ' followers: outside the under-2k green zone, big accounts rarely see cold DMs.');
  return out;
}

/* -- copied text is remembered across the app being killed while X is open -- */
function setCopied(id, text, early) { LS.set('dmcopied_' + id, JSON.stringify({ text, early: !!early })); }
function getCopied(id) { try { return JSON.parse(LS.get('dmcopied_' + id, 'null')); } catch { return null; } }
function clearCopied(id) { try { localStorage.removeItem('sk_dmcopied_' + id); } catch { /* ignore */ } }

/* -- server writes -- */
/* Update in place, so the card handlers that hold this lead keep seeing it. */
function mergeLead(lead, stats) {
  const cur = dm.leads.find((x) => x.id === lead.id);
  if (cur) {
    for (const k of Object.keys(cur)) if (!(k in lead)) delete cur[k];
    Object.assign(cur, lead);
  } else dm.leads.push(lead);
  if (stats) dm.stats = stats;
}
async function dmSave(l, body, quiet) {
  try {
    const r = await api('/api/dm/update', Object.assign({ id: l.id }, body));
    mergeLead(r.lead, r.stats);
    return r.lead;
  } catch (e) { if (!quiet) toast(e.message, true); throw e; }
}
async function dmStatus(l, status, extra, msg, undoStatus) {
  const prev = l.status;
  try {
    await dmSave(l, Object.assign({ status }, extra || {}));
    if (status === 'sent') clearCopied(l.id);
    buildDmDefaults();
    renderDm(l.channel);
    updateDmBadges();
    toast(msg, false, { label: 'Undo', run: async () => {
      try { await dmSave(l, { status: undoStatus || prev }); buildDmDefaults(); renderDm(l.channel); updateDmBadges(); toast('Undone'); } catch { /* toasted */ }
    } });
  } catch { /* toasted */ }
}

/* -- actions -- */
async function dmCopyOpen(l, ta) {
  const go = async (early) => {
    const text = ta.value;
    const ok = await copy(text);
    setCopied(l.id, text, early);
    toast(ok ? 'Copied. Paste it in ' + DM_NAME[l.channel] + ' and press Send.' : 'Copy failed. Long-press the text.', !ok);
    const url = openUrl(l);
    if (url) window.open(url, '_blank', 'noopener');
  };
  const gate = paceGate(l.channel);
  if (gate) sheet(gate.title, [{ label: gate.go, run: () => go(true) }]);
  else go(false);
}

function dmMarkSent(l, ta) {
  const text = ta.value.trim();
  const copied = getCopied(l.id);
  const edited = text !== baseMessage(l).trim();
  const base = { sent_lines: linesLabel(l), sent_early: !!(copied && copied.early) };
  const done = (t, verbatim) => dmStatus(l, 'sent', Object.assign(base, { sent_text: t, sent_verbatim: verbatim }),
    'Marked sent to ' + dmWho(l), 'ready');
  if (copied && String(copied.text).trim() === text) { done(text, !edited); return; }
  // Not copied from here (or changed since): ask. Assuming would teach the
  // writer its own output, which is the exact failure the reply corpus hit.
  sheet('What did you send to ' + dmWho(l) + '?', [
    { label: 'The message in the box', run: () => done(text, !edited) },
    { label: 'Something else - let me paste it', run: () => { ta.focus(); ta.select(); toast('Paste what you sent over it, then tap Sent'); } },
    { label: 'Just mark sent (do not learn from it)', run: () => dmStatus(l, 'sent', { sent_lines: linesLabel(l), sent_early: base.sent_early }, 'Marked sent', 'ready') },
  ]);
}

async function dmShuffle(l) {
  const prev = { pick: l.pick || null, variant_index: l.variant_index || 0, draft_text: typeof l.draft_text === 'string' ? l.draft_text : null };
  const lib = libOf(l);
  if (l.variants && l.variants.length > 1) {
    l.variant_index = ((l.variant_index || 0) + 1) % l.variants.length;
  } else if (lib) {
    const cur = messageOf(l);
    const taken = new Set(dm.leads.filter((x) => x.status === 'ready' && x.id !== l.id).map(messageOf));
    let k = null;
    for (let t = 0; t < 60; t++) {
      k = drawLines(lib, l, Math.random);
      const txt = composeLines(lib, l, k);
      if (txt !== cur && !taken.has(txt)) break;
    }
    l.pick = k;
  } else { toast('There is only one message for ' + dmWho(l)); return; }
  delete l.draft_text;
  renderDm(l.channel);
  try {
    await dmSave(l, { pick: l.pick || null, variant_index: l.variant_index || 0, draft_text: null }, false);
    toast('New message', false, { label: 'Undo', run: async () => {
      l.pick = prev.pick; l.variant_index = prev.variant_index;
      if (prev.draft_text === null) delete l.draft_text; else l.draft_text = prev.draft_text;
      renderDm(l.channel);
      try { await dmSave(l, prev); } catch { /* toasted */ }
    } });
  } catch { /* toasted */ }
}

function dmFailed(l) {
  sheet(l.channel === 'x' ? 'X said "Failed, try again"? That is a spam block.' : 'LinkedIn warned you or hit a limit?', [
    { label: 'Yes - stop and start the cooldown', run: async () => {
      try {
        const r = await api('/api/dm/failed', { channel: l.channel, id: l.id });
        dm.stats = r.stats;
        renderDm(l.channel);
        toast('Cooldown started. Wait it out, then vary the copy before the next one.', true);
      } catch (e) { toast(e.message, true); }
    } },
  ]);
}

function dmMenu(l) {
  const acts = [{ label: 'Open profile', run: () => window.open(profileUrl(l), '_blank', 'noopener') }];
  if (l.channel === 'x' && l.recipient_id) acts.push({ label: 'Open DM screen', run: () => window.open(openUrl(l), '_blank', 'noopener') });
  if (l.status === 'ready') {
    if (typeof l.draft_text === 'string') acts.push({ label: 'Reset my edits', run: async () => { delete l.draft_text; renderDm(l.channel); try { await dmSave(l, { draft_text: null }); } catch { /* toasted */ } } });
    acts.push({ label: l.channel === 'x' ? 'X said "Failed, try again"' : 'LinkedIn showed a warning or limit',
      danger: true, run: () => dmFailed(l) });
  }
  if (l.status === 'sent') acts.push({ label: 'Undo sent (back to To send)', run: () => dmStatus(l, 'ready', {}, 'Back in To send', 'sent') });
  if (l.status === 'replied') acts.push({ label: 'Not a reply (back to Sent)', run: () => dmStatus(l, 'sent', {}, 'Back in Sent', 'replied') });
  if (l.status === 'skipped' || l.status === 'cant_dm') acts.push({ label: 'Back to To send', run: () => dmStatus(l, 'ready', {}, 'Back in To send', l.status) });
  sheet(dmWho(l) + (l.product ? ' · ' + l.product : ''), acts);
}

/* -- cards -- */
function dmSub(l) {
  return [l.product, l.channel === 'x' && l.followers != null ? num(l.followers) + ' followers' : null, l.meta]
    .filter(Boolean).join(' · ');
}
function dmFlags(l, text) {
  const box = el('div', { class: 'dm-flags' });
  const add = (t, cls) => box.append(el('div', { class: 'flag' + (cls ? ' ' + cls : '') }, el('b', { text: '!' }), el('span', { text: t })));
  if (l.drop) add('Not advised. Read the note before sending.', 'bad');
  if (l.flag) add(l.flag);
  if (l.note) add(l.note);
  for (const w of dmRuleWarnings(l, text)) add(w, 'bad');
  return box;
}

function linesPanel(l) {
  const lib = libOf(l);
  const k = linesOf(l);
  const panel = el('div', { class: 'lines-panel' });
  const make = (field, label, keys, map, allowed, deny) => {
    const s = el('select', { 'aria-label': label });
    const good = keys.filter((x) => allowed.includes(x) && !deny.includes(x));
    const rest = keys.filter((x) => !good.includes(x) && !deny.includes(x));
    for (const x of good) s.append(el('option', { value: x, text: map ? (map[x].label || x) : x }));
    if (rest.length) {
      const g = el('optgroup', { label: 'off-pattern, still sendable' });
      for (const x of rest) g.append(el('option', { value: x, text: '· ' + (map ? (map[x].label || x) : x) }));
      s.append(g);
    }
    s.value = k[field];
    s.addEventListener('change', async () => {
      const np = Object.assign({}, k, { [field]: s.value });
      // A new hook or proof can rule out what followed it: let those refill.
      if (field === 'hook' && !libProofs(lib, np.hook, l).includes(np.proof)) delete np.proof;
      if ((field === 'hook' || field === 'proof') && np.proof
          && !libCtas(lib, np.hook, np.proof, l).includes(np.cta)) delete np.cta;
      l.pick = np;
      l.pick = linesOf(l);
      delete l.draft_text;
      s.blur();
      renderDm(l.channel, l.id);
      try { await dmSave(l, { pick: l.pick, draft_text: null }, false); } catch { /* toasted */ }
    });
    return el('label', { class: 'line-pick' }, el('span', { text: label }), s);
  };
  const hooks = Object.keys(lib.hooks);
  panel.append(
    make('hook', 'Hook', hooks, lib.hooks, libHooks(lib, l), []),
    make('proof', 'Proof', Object.keys(lib.proofs), lib.proofs, libProofs(lib, k.hook, l), badProofs(lib, k.hook)),
    make('cta', 'Ask', Object.keys(lib.ctas), lib.ctas, libCtas(lib, k.hook, k.proof, l), badCtas(lib, k.hook)));
  if (lib.salutations && lib.salutations.length > 1) {
    panel.append(make('sal', 'Hi', lib.salutations, null, lib.salutations, []));
  }
  return panel;
}

function dmSendCard(l, isNext, openLines) {
  const text = messageOf(l);
  const card = el('div', { class: 'card dm-card' + (isNext ? ' next' : '') + (l.drop ? ' drop' : ''), 'data-lead': l.id });
  const tags = el('div', { class: 'tagrow' });
  if (isNext) tags.append(el('span', { class: 'tag next', text: 'Next' }));
  if (l.batch) tags.append(el('span', { class: 'tag', text: l.batch + (l.n ? ' · #' + l.n : '') }));
  if (l.drop) tags.append(el('span', { class: 'tag bad', text: 'Not advised' }));
  card.append(whoRow(l.channel === 'x' ? handleOf(l.handle) : (l.name || '?'), dmSub(l), () => dmMenu(l)), tags);
  if (l.channel === 'linkedin') card.querySelector('.who-name b').textContent = l.name || 'LinkedIn lead';

  let flags = dmFlags(l, text);
  card.append(flags);

  const ta = el('textarea', { class: 'dm-msg', rows: 8, spellcheck: 'true' });
  ta.value = text;
  const count = el('span', { class: 'chars', text: text.trim().length + ' chars' });
  let saveTimer;
  const saveDraft = async () => {
    const v = ta.value;
    const body = v === baseMessage(l) ? { draft_text: null } : { draft_text: v };
    if ((body.draft_text ?? null) === (typeof l.draft_text === 'string' ? l.draft_text : null)) return;
    if (body.draft_text === null) delete l.draft_text; else l.draft_text = v;
    try { await dmSave(l, body, true); } catch { /* quiet autosave */ }
  };
  ta.addEventListener('input', () => {
    count.textContent = ta.value.trim().length + ' chars';
    const nf = dmFlags(l, ta.value);
    flags.replaceWith(nf);
    flags = nf;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 1000);
  });
  ta.addEventListener('blur', () => { clearTimeout(saveTimer); saveDraft(); });

  const lib = libOf(l);
  const label = el('button', { class: 'voice', text: linesLabel(l) + (lib ? ' ▾' : ''), title: lib ? 'Change single lines' : 'Which message this is' });
  const panel = lib ? linesPanel(l) : null;
  if (panel) {
    panel.hidden = !openLines;
    label.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  }
  card.append(el('div', { class: 'dm-meta' }, label, el('span', { class: 'spacer' }), count));
  if (panel) card.append(panel);
  card.append(ta);

  const canShuffle = (l.variants && l.variants.length > 1) || !!lib;
  card.append(el('div', { class: 'dm-row' },
    canShuffle ? el('button', { class: 'btn', text: '↻ Shuffle', title: 'Another message', onclick: () => dmShuffle(l) }) : null,
    el('button', { class: 'btn', text: 'Copy', onclick: async () => {
      const ok = await copy(ta.value); setCopied(l.id, ta.value, false);
      toast(ok ? 'Copied' : 'Copy failed. Long-press the text.', !ok);
    } }),
    el('button', { class: 'btn primary grow', text: 'Copy + open ' + DM_NAME[l.channel], onclick: () => dmCopyOpen(l, ta) })));
  card.append(el('div', { class: 'dm-row' },
    el('button', { class: 'btn ok grow', text: '✓ Sent', onclick: () => dmMarkSent(l, ta) }),
    el('button', { class: 'btn', text: l.channel === 'x' ? "Can't DM" : "Can't message",
      onclick: () => dmStatus(l, 'cant_dm', { reason: 'messages closed' }, dmWho(l) + ': can’t message, moved to Done', 'ready') }),
    el('button', { class: 'btn', text: 'Skip', onclick: () => dmStatus(l, 'skipped', { reason: 'skipped on phone' }, 'Skipped ' + dmWho(l), 'ready') })));
  return card;
}

function dmSentCard(l) {
  const card = el('div', { class: 'card dm-card slim' });
  card.append(whoRow(l.channel === 'x' ? handleOf(l.handle) : (l.name || '?'),
    'sent ' + agoText(l.sent_ts) + (l.product ? ' · ' + l.product : '') + (l.sent_early ? ' · early' : ''), () => dmMenu(l)));
  if (l.channel === 'linkedin') card.querySelector('.who-name b').textContent = l.name || 'LinkedIn lead';
  card.append(postBlock(l.sent_text || '(sent text not recorded)', 'post short'));
  const replyBox = el('div', { class: 'reply-box' });
  replyBox.hidden = true;
  const rt = el('textarea', { rows: 3, placeholder: 'Paste their reply (optional, helps Claude draft your answer)' });
  replyBox.append(rt, el('div', { class: 'dm-row' },
    el('button', { class: 'btn primary grow', text: 'Save reply', onclick: () => dmStatus(l, 'replied', { reply_text: rt.value.trim() }, dmWho(l) + ' replied, moved to Done', 'sent') }),
    el('button', { class: 'btn', text: 'Cancel', onclick: () => { replyBox.hidden = true; } })));
  card.append(replyBox, el('div', { class: 'dm-row' },
    el('button', { class: 'btn grow', text: 'They replied', onclick: () => { replyBox.hidden = false; rt.focus(); } }),
    el('button', { class: 'btn', text: 'Open', onclick: () => window.open(openUrl(l), '_blank', 'noopener') })));
  return card;
}

const DONE_TEXT = { replied: 'replied', skipped: 'skipped', cant_dm: "couldn't message" };
function dmDoneRow(l) {
  const line = l.status === 'replied' ? (l.reply_text || 'replied') : (l.skip_reason || l.product || '');
  return el('div', { class: 'row-card' }, avatar(l.channel === 'x' ? handleOf(l.handle) : l.name),
    el('div', { class: 'grow' },
      el('b', { text: dmWho(l) + ' · ' + (DONE_TEXT[l.status] || l.status) }),
      el('div', { class: 'line', text: line })),
    el('button', { class: 'more-btn', text: '⋯', onclick: () => dmMenu(l) }));
}

function savedRow(o) {
  const li = o.platform === 'linkedin';
  return el('div', { class: 'row-card' }, avatar(o.handle),
    el('div', { class: 'grow' },
      el('b', { text: li ? (o.display_name || o.handle) : '@' + o.handle }),
      el('div', { class: 'line', text: o.bio || o.display_name || o.followers_text || ('saved ' + agoText(o.ts)) })),
    el('a', { class: 'link', href: o.profile_url, target: '_blank', rel: 'noopener', text: 'Open' }),
    el('button', { class: 'more-btn', text: '⋯', onclick: () => sheet(li ? o.handle : '@' + o.handle, [
      { label: 'Remove from saved', danger: true, run: async () => {
        try { await api('/api/outreach/update', { id: o.id, status: 'removed' }); o.status = 'removed'; renderDmAll(); toast('Removed'); }
        catch (e) { toast(e.message, true); }
      } }]) }));
}

/* -- panel -- */
function renderDm(ch, keepLinesOpenFor) {
  const root = $('dm-' + ch);
  if (!root) return;
  dm.pending[ch] = false;
  const saved = state.outreach.filter((o) => (o.platform || 'x') === ch && o.status === 'queued');
  const nodes = [];
  if (dm.missing || dm.error) {
    nodes.push(el('div', { class: 'empty', text: dm.missing
      ? 'The sidekick server on your Mac is an older version. Restart it (server/start.sh) to turn on outreach.'
      : 'Could not load outreach: ' + dm.error }));
    root.replaceChildren(...nodes);
    return;
  }
  const mine = dm.leads.filter((l) => l.channel === ch);
  const camps = [...new Set(mine.filter((l) => l.status === 'ready' || l.status === 'sent').map((l) => l.campaign))].filter(Boolean);
  if (dm.camp[ch] && !camps.includes(dm.camp[ch])) dm.camp[ch] = '';
  const inCamp = (l) => !dm.camp[ch] || l.campaign === dm.camp[ch];
  const ready = mine.filter((l) => l.status === 'ready' && inCamp(l)).sort(byOrder);
  const sent = mine.filter((l) => l.status === 'sent' && inCamp(l)).sort((a, b) => (b.sent_ts || '').localeCompare(a.sent_ts || ''));
  // Replies first: those are the ones that still need an answer.
  const done = mine.filter((l) => ['replied', 'skipped', 'cant_dm'].includes(l.status) && inCamp(l))
    .sort((a, b) => ((b.status === 'replied') - (a.status === 'replied'))
      || (b.updated_ts || '').localeCompare(a.updated_ts || ''));

  const p = paceState(ch);
  nodes.push(el('div', { class: 'pace ' + p.cls },
    el('span', { class: 'pace-dot' }), el('span', { class: 'pace-text', text: p.text }),
    p.cool ? el('button', { class: 'link', text: 'Clear', onclick: () => sheet('End the cooldown early?', [{ label: 'Yes, ' + DM_NAME[ch] + ' is sending again', run: async () => {
      try { const r = await api('/api/dm/cooldown/clear', { channel: ch }); dm.stats = r.stats; renderDm(ch); } catch (e) { toast(e.message, true); }
    } }]) }) : null));

  if (camps.length > 1) {
    const chips = el('div', { class: 'chips dm-chips' });
    for (const [val, label] of [['', 'All'], ...camps.map((c) => [c, c.replace(/-/g, ' ')])]) {
      chips.append(el('button', { class: 'chip' + (dm.camp[ch] === val ? ' on' : ''), text: label, onclick: () => {
        dm.camp[ch] = val; LS.set('dmcamp_' + ch, val); renderDm(ch);
      } }));
    }
    nodes.push(chips);
  }

  const counts = { send: ready.length, sent: sent.length, done: 0, saved: saved.length };
  const seg = el('div', { class: 'dseg', role: 'tablist' });
  for (const [key, label] of DM_SEGS) {
    seg.append(el('button', { class: dm.seg[ch] === key ? 'on' : '', onclick: () => {
      dm.seg[ch] = key; LS.set('dmseg_' + ch, key); renderDm(ch); window.scrollTo(0, 0);
    } }, label + ' ', counts[key] ? el('b', { text: String(counts[key]) }) : null));
  }
  nodes.push(seg);

  const which = dm.seg[ch];
  if (which === 'send') {
    nodes.push(el('p', { class: 'hint', text: ch === 'x'
      ? 'Open the profile first: check the product and that their DMs are open. One DM, one gap, then the next. Stop the batch if X ever says Failed.'
      : 'Check the chat first. If an older message already went out, change the first line before you send.' }));
    if (!ready.length) {
      nodes.push(el('div', { class: 'empty', text: dm.loaded
        ? 'Nothing to send. Ask Claude in Cowork to load the next ' + DM_NAME[ch] + ' batch into the sidekick.'
        : 'Loading…' }));
    }
    ready.forEach((l, i) => nodes.push(dmSendCard(l, i === 0, keepLinesOpenFor === l.id)));
  } else if (which === 'sent') {
    nodes.push(el('p', { class: 'hint', text: 'Waiting on a reply. Tap "They replied" when one comes in, and paste it so Claude can draft your answer.' }));
    nodes.push(...(sent.length ? sent.map(dmSentCard) : [el('div', { class: 'empty', text: 'Nothing sent in the last 30 days.' })]));
  } else if (which === 'done') {
    nodes.push(...(done.length ? done.map(dmDoneRow) : [el('div', { class: 'empty', text: 'Replies, skips and closed DMs land here.' })]));
  } else {
    nodes.push(el('p', { class: 'hint', text: 'Profiles you share from the ' + DM_NAME[ch] + ' app land here. Claude turns them into the next batch.' }));
    nodes.push(...(saved.length ? saved.map(savedRow) : [el('div', { class: 'empty', text: 'No profiles saved.' })]));
  }
  root.replaceChildren(...nodes);
}

DM_CH.forEach((ch) => $('dm-' + ch).addEventListener('focusout', () => {
  // Wait past the tap that moved focus, so its click lands before any rebuild.
  setTimeout(() => { if (dm.pending[ch] && !typingIn(ch)) renderDm(ch); }, 400);
}));

function updateDmBadges() {
  $('navLi').textContent = dm.leads.filter((l) => l.channel === 'linkedin' && l.status === 'ready').length || '';
  $('navX').textContent = dm.leads.filter((l) => l.channel === 'x' && l.status === 'ready').length || '';
}
function typingIn(ch) {
  const a = document.activeElement;
  return !!a && $('dm-' + ch).contains(a) && /^(TEXTAREA|INPUT)$/.test(a.tagName);
}
/* Background refreshes (returning from X, polling) go through here. They never
 * rebuild a panel under a thumb that is typing; that waits for focus to leave.
 * A tap inside the panel calls renderDm directly and always redraws. */
function renderDmAll() {
  DM_CH.forEach((ch) => { if (typingIn(ch)) dm.pending[ch] = true; else renderDm(ch); });
  updateDmBadges();
}

/* -- pacing settings -- */
[['capX', 'cap_x', 20], ['capLi', 'cap_linkedin', 20], ['gapMin', 'gapmin', 1], ['gapMax', 'gapmax', 9]].forEach(([id, key, d]) => {
  $(id).value = LS.get(key, String(d));
  $(id).addEventListener('change', () => {
    const v = parseInt($(id).value, 10);
    if (Number.isFinite(v) && v >= 0) LS.set(key, String(v)); else $(id).value = LS.get(key, String(d));
    renderDmAll();
  });
});

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
renderDmAll();
const startTab = LS.get('tab', 'replies');
showTab(startTab === 'settings' && LS.get('password') ? 'replies' : startTab);
refresh();
