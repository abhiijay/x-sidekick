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
const state = { items: [], outreach: [], jobs: [], blocked: [], scout: null, seg: 'ready', filter: 'all', picked: new Set(), pollTimer: null,
  lastRefresh: 0, repliesStale: false };

/* ---------------- api ---------------- */

function serverBase() {
  return (LS.get('server') || location.origin).replace(/\/$/, '');
}

async function api(path, body, etag) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const res = await fetch(serverBase() + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidekick-Key': LS.get('password'),
        'ngrok-skip-browser-warning': 'true',
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    if (res.status === 304) return { __same: true };
    let data = {};
    try { data = await res.json(); } catch { data = { error: 'server sent non-JSON (' + res.status + ')' }; }
    if (!res.ok) {
      const err = new Error(data.error || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    const tag = res.headers.get('ETag');
    if (tag && data && typeof data === 'object') Object.defineProperty(data, '__etag', { value: tag });
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('server timed out');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/* GETs the app refreshes on every return from LinkedIn or X. Each carries the
 * ETag of the copy on screen, so an unchanged answer is a bodyless 304: a few
 * hundred bytes over mobile data instead of ~80KB, and nothing gets redrawn.
 * A tag is only remembered once its data is in use (see refresh). An older
 * server sends no readable ETag, so the app never sends If-None-Match to it. */
const shownTag = new Map();
function apiFresh(path) { return api(path, undefined, shownTag.get(path)); }
function keepTag(path, r) { if (r && r.__etag) shownTag.set(path, r.__etag); }

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
  if (name === 'replies' && state.repliesStale) renderReplies();
  if (name === 'xdm' && typeof renderDm === 'function' && dm.loaded) renderDm('x');
  if ((name === 'xdm' || name === 'linkedin') && typeof loadFind === 'function' && dm.loaded) loadFind();
  dmTicker();
  // The LinkedIn action bar belongs to that tab only.
  if (name === 'linkedin' && typeof renderDm === 'function' && dm.loaded) renderDm('linkedin');
  else if (typeof setDmActions === 'function') setDmActions(null);
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
  state.lastRefresh = Date.now();
  try {
    const [h, q, o, j, b, d] = await Promise.all([api('/api/health'), apiFresh('/api/queue'), apiFresh('/api/outreach'), apiFresh('/api/jobs'),
      apiFresh('/api/blocklist').catch(() => ({ items: [] })),
      // An older server has no /api/dm: the DM tabs then say it needs a restart.
      apiFresh('/api/dm').catch((e) => ({ __error: e }))]);
    // Only what changed is taken and redrawn. On a 4GB phone, rebuilding every
    // panel on each return from LinkedIn is what made the app slow to come back.
    const ch = (r) => !r.__same;
    if (ch(q)) state.items = q.items || [];
    if (ch(o)) state.outreach = o.items || [];
    if (ch(j)) state.jobs = j.jobs || [];
    if (ch(b)) state.blocked = b.items || [];
    if (ch(d)) takeDm(d);
    [['/api/queue', q], ['/api/outreach', o], ['/api/jobs', j], ['/api/blocklist', b], ['/api/dm', d]].forEach(([p, r]) => keepTag(p, r));
    $('dot').className = 'dot ok';
    state.acceptWatch = h.accept_watch || null;
    if (h.sends != null) $('sendsCount').textContent = 'Replies Claude learns from: ' + h.sends;
    const warn = [];
    if (!h.routine) warn.push('Claude routine is not connected, so drafting is off.');
    if (!h.armory) warn.push('Armory is not connected, so scouting is off.');
    banner(warn.join(' '));
    if (ch(q) || ch(j)) {
      if (currentTab() === 'replies') renderReplies();
      else { state.repliesStale = true; $('navBadge').textContent = state.items.filter((i) => i.status === 'drafted').length || ''; }
    }
    if (ch(d) || ch(o) || ch(j)) renderDmAll();
    if (ch(b) || ch(j)) renderSettingsLists();
    if (dm.loaded && ['linkedin', 'xdm'].includes(currentTab())) loadFind();
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
    if (document.hidden) return;   // coming back to the app refreshes anyway
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
  state.repliesStale = false;
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

/* How many posts to find this run: he sometimes wants fewer than 20, sometimes more. */
$('scoutWant').value = LS.get('scout_want', '20');
$('scoutWant').addEventListener('change', () => {
  const v = parseInt($('scoutWant').value, 10);
  if (Number.isFinite(v) && v >= 1 && v <= 60) LS.set('scout_want', String(v)); else $('scoutWant').value = LS.get('scout_want', '20');
});
$('scoutBtn').addEventListener('click', async (e) => {
  const want = parseInt($('scoutWant').value, 10) || 20;
  const done = busy(e.target, 'Starting…');
  try { await api('/api/scout', { want }); toast('Scout started · looking for ' + want); } catch (err) { toast(err.message, true); }
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
const CONNECT_SEGS = [['connect', 'To connect'], ['requested', 'Requested'], ['cdone', 'Done']];
const TIER_RANK = { 'Contact this week': 0, 'This week': 0, 'Next batch': 1, 'Later': 2, 'Later / check first': 2 };
const dm = {
  loaded: false, missing: false, error: '', leads: [], libs: {}, stats: {}, campaigns: {}, find: null,
  // LinkedIn has two lists: people to connect with, and connections to message.
  mode: { linkedin: LS.get('dmmode_linkedin', 'connect'), x: 'message' },
  seg: { linkedin: LS.get('dmseg_linkedin', 'send'), x: LS.get('dmseg_x', 'send') },
  cseg: LS.get('dmcseg', 'connect'),
  camp: { linkedin: LS.get('dmcamp_linkedin', ''), x: LS.get('dmcamp_x', '') },
  defaults: {}, pending: {}, timer: null, findTimer: null, opened: null,
};
/* Leads he already opened LinkedIn or X for, so the bar can ask "Sent?".
 * Kept in storage, not memory: a 4GB phone often kills the app while LinkedIn
 * is open, and the reload used to forget the step. Entries last 12 hours. */
dm.opened = {
  ttl: 12 * 3600e3,
  map: (() => { try { return JSON.parse(LS.get('dmopened', '{}')) || {}; } catch { return {}; } })(),
  has(id) { return Date.now() - (this.map[id] || 0) < this.ttl; },
  add(id) { this.map[id] = Date.now(); this.save(); },
  delete(id) { if (id in this.map) { delete this.map[id]; this.save(); } },
  save() {
    const now = Date.now();
    for (const k of Object.keys(this.map)) if (now - this.map[k] >= this.ttl) delete this.map[k];
    LS.set('dmopened', JSON.stringify(this.map));
  },
};
function modeOf(ch) { return ch === 'linkedin' && dm.mode.linkedin === 'connect' ? 'connect' : 'message'; }
function kindOf(l) { return l.kind || 'message'; }

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
  dm.campaigns = d.campaigns || {};
  buildDmDefaults();
}

/* -- pacing (warnings, never blocks) --
 * Messages: daily cap + a random gap between sends. Connection requests: daily
 * cap only (LinkedIn signed the account out after about 82 in one day on
 * 2026-09-28). Both: an optional session size he types in. */
function paceCfg(ch, mode) {
  const n = (k, d) => { const v = parseInt(LS.get(k, ''), 10); return Number.isFinite(v) && v >= 0 ? v : d; };
  if (mode === 'connect') return { cap: n('cap_connect', 25) || 25, min: 0, max: 0 };
  const min = n('gapmin', 1);
  return { cap: n('cap_' + ch, 20) || 20, min, max: Math.max(min, n('gapmax', 9)) };
}
function strHash(x) { let h = 2166136261; for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function tsMs(ts) { return new Date(String(ts).replace(' ', 'T')).getTime(); }
function localStamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
/* The gap is derived from the last send's timestamp, so it is random but the
 * same on every reload and every device, with nothing extra to store. */
function nextDue(ch) {
  const s = dm.stats[ch] || {};
  if (!s.last_sent_ts) return 0;
  const c = paceCfg(ch, 'message');
  return tsMs(s.last_sent_ts) + (c.min + strHash(ch + s.last_sent_ts) % (c.max - c.min + 1)) * 60000;
}
function mmss(ms) { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
/* "How many this session": a number he types; the count is what went out since. */
function sessionOf(ch, mode) { try { return JSON.parse(LS.get('sess_' + ch + '_' + mode, 'null')); } catch { return null; } }
function setSession(ch, mode, target) {
  LS.set('sess_' + ch + '_' + mode, JSON.stringify(target ? { target, start: localStamp() } : null));
}
function sessionCount(ch, mode, s) {
  const f = mode === 'connect' ? 'requested_ts' : 'sent_ts';
  return dm.leads.filter((l) => l.channel === ch && l[f] && l[f] >= s.start).length;
}
function paceState(ch, mode = modeOf(ch)) {
  const s = dm.stats[ch] || {};
  const c = paceCfg(ch, mode);
  const now = Date.now();
  const done = mode === 'connect' ? (s.requested_today || 0) : (s.sent_today || 0);
  let text = done + '/' + c.cap + (mode === 'connect' ? ' requests today' : ' today');
  if (mode === 'connect' && s.requested_7d) text += ' · ' + s.requested_7d + ' this week';
  const ss = sessionOf(ch, mode);
  let sessionDone = false;
  if (ss && ss.target) {
    const n = sessionCount(ch, mode, ss);
    text += ' · session ' + n + '/' + ss.target;
    sessionDone = n >= ss.target;
  }
  if (mode === 'message' && s.cooldown_until && s.cooldown_until * 1000 > now) {
    return { cls: 'err', text: 'Cooling down ' + mmss(s.cooldown_until * 1000 - now) + ' · ' + DM_NAME[ch] + ' said Failed. Stop the batch.', cool: true };
  }
  if (done >= c.cap) return { cls: 'warn', text: text + ' · daily cap reached', capped: true };
  if (sessionDone) return { cls: 'warn', text: text + ' · session done', sessionDone: true };
  if (mode === 'message') {
    const due = nextDue(ch);
    if (due > now) return { cls: 'wait', text: text + ' · next in ' + mmss(due - now), wait: due - now };
  }
  return { cls: 'ok', text: text + (mode === 'connect' ? '' : ' · ready for the next one') };
}
/* Returns a warning to confirm first, or null when it is fine to go ahead. */
function paceGate(ch, mode = modeOf(ch)) {
  const p = paceState(ch, mode);
  if (p.cool) return { title: DM_NAME[ch] + ' blocked a send. Sending during the cooldown risks a longer block or a label.', go: 'Send anyway' };
  if (p.capped) {
    return mode === 'connect'
      ? { title: "That's your connection-request cap for today. LinkedIn signed you out after about 82 in one day on Sep 28.", go: 'Open anyway' }
      : { title: "That's your daily cap. More today raises the spam risk.", go: 'Send anyway' };
  }
  if (p.sessionDone) return { title: 'You planned ' + sessionOf(ch, mode).target + ' for this session and they are done.', go: 'Keep going' };
  if (p.wait) return { title: 'The next one is due in ' + mmss(p.wait) + '. The random gap keeps this looking human.', go: 'Send early' };
  return null;
}
function dmTicker() {
  clearInterval(dm.timer);
  const tab = currentTab();
  const ch = tab === 'linkedin' ? 'linkedin' : tab === 'xdm' ? 'x' : null;
  if (!ch) return;
  dm.timer = setInterval(() => {
    if (document.hidden) return;
    const nx = ch === 'linkedin' && document.querySelector('#dm-linkedin .li-next');
    if (nx) {
      const w = paceState('linkedin', 'message').wait;
      nx.textContent = w ? 'Next in ' + mmss(w) : 'Ready for the next';
    }
    const box = document.querySelector('#dm-' + ch + ' .pace');
    if (!box) return;
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
/* LinkedIn links open in the LinkedIn app (Android) by default: one app that
 * stays open between profiles, instead of a browser page that reloads
 * LinkedIn's web app for every person. Settings can switch to the browser,
 * where one named tab is reused. */
function openLinkedIn(url) {
  if (!url) return;
  if (LS.get('li_open', 'app') === 'app' && /android/i.test(navigator.userAgent)) {
    try {
      const u = new URL(url);
      location.href = 'intent://' + u.host + u.pathname + u.search + '#Intent;scheme=https;package=com.linkedin.android;end';
      return;
    } catch { /* bad URL: fall through to the browser */ }
  }
  window.open(url, 'sk_linkedin', 'noopener');
}
function openLead(l, url) { if (l.channel === 'linkedin') openLinkedIn(url); else if (url) window.open(url, '_blank', 'noopener'); }
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
/* `undo` is the status to go back to, or a full body ({kind, status}) when the
 * move changed the lead's kind (an accepted connection became a message lead). */
async function dmStatus(l, status, extra, msg, undo) {
  const prev = l.status;
  const undoBody = undo && typeof undo === 'object' ? undo : { status: undo || prev };
  try {
    await dmSave(l, Object.assign({ status }, extra || {}));
    dm.opened.delete(l.id);
    if (status === 'sent') clearCopied(l.id);
    buildDmDefaults();
    renderDm(l.channel);
    updateDmBadges();
    toast(msg, false, { label: 'Undo', run: async () => {
      try { await dmSave(l, undoBody); buildDmDefaults(); renderDm(l.channel); updateDmBadges(); toast('Undone'); } catch { /* toasted */ }
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
    dm.opened.add(l.id);
    if (l.channel === 'linkedin') renderDm('linkedin');   // bar switches to "Sent"
    openLead(l, openUrl(l));
  };
  const gate = paceGate(l.channel, 'message');
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

/* "Tell Claude": he says what to change in the messages Claude writes. The
 * server keeps every note as a standing rule that each Write with Claude run
 * reads, and "rewrite this one" sends the person back with the note and the
 * old text. The chat link opens the exact session that wrote the message,
 * with it copied, for anything a note can't carry. */
function tellClaude(l, ta) {
  const msg = ta ? ta.value : (l.sent_text || messageOf(l));
  const box = el('textarea', { class: 'tell-box', rows: 4, placeholder: 'What should change? e.g. "Too long. Never open with their product name."' });
  const canRewrite = l.status === 'ready' && kindOf(l) === 'message' && !l.needs_message;
  const save = async (rewrite, btn) => {
    const text = box.value.trim();
    if (!text) { toast('Type what to change first', true); box.focus(); return; }
    btn.disabled = true;
    try {
      await api('/api/dm/feedback', { id: l.id, text, message: msg, rewrite });
      closeSheet();
      toast(rewrite ? 'Saved. Claude is rewriting ' + dmWho(l) + ' (a few minutes).'
        : 'Saved. Every message Claude writes from now on follows it.');
    } catch (e) { closeSheet(); toast(e.message + (rewrite ? '. Your note is saved.' : ''), true); }
    refresh();
  };
  const btns = [];
  if (canRewrite) btns.push(el('button', { class: 'primary', text: 'Save + rewrite this one', onclick: (e) => save(true, e.target) }));
  btns.push(el('button', { text: 'Save for next time', onclick: (e) => save(false, e.target) }));
  if (l.claude_url) btns.push(el('button', { text: 'Open the chat that wrote it ↗', onclick: () => { closeSheet(); openChat(l, msg); } }));
  sheetCustom('Tell Claude what to change', [
    el('div', { class: 'sheet-note', text: 'Kept as a rule for every future message' + (l.campaign ? ' in this campaign' : '') + '.' }),
    box, ...btns]);
  setTimeout(() => box.focus(), 50);
}
async function openChat(l, msg) {
  const ok = await copy('About the LinkedIn message for ' + dmWho(l) + (l.product ? ' (' + l.product + ')' : '') + ':\n\n' + msg + '\n\nWhat to change: ');
  toast(ok ? 'Message copied. Paste it in the chat and say what to change.' : 'Opening the chat');
  window.open(l.claude_url, '_blank', 'noopener');
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

function dmMenu(l, ta) {
  const acts = [{ label: 'Open profile', run: () => openLead(l, profileUrl(l)) }];
  if (l.channel === 'linkedin') acts.push({ label: 'Tell Claude what to change', run: () => tellClaude(l, ta) });
  if (l.channel === 'linkedin' && l.claude_url) acts.push({ label: 'Open the Claude chat that wrote it ↗', run: () => openChat(l, ta ? ta.value : (l.sent_text || messageOf(l))) });
  if (l.channel === 'x' && l.recipient_id) acts.push({ label: 'Open DM screen', run: () => window.open(openUrl(l), '_blank', 'noopener') });
  if (l.status === 'ready') {
    if (typeof l.draft_text === 'string') acts.push({ label: 'Reset my edits', run: async () => { delete l.draft_text; renderDm(l.channel); try { await dmSave(l, { draft_text: null }); } catch { /* toasted */ } } });
    if (l.needs_message) acts.push({ label: 'Skip this person', run: () => dmStatus(l, 'skipped', { reason: 'skipped on phone' }, 'Skipped ' + dmWho(l), 'ready') });
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
    l.channel === 'linkedin' ? el('button', { class: 'btn', text: 'Tell Claude', onclick: () => tellClaude(l) }) : null,
    el('button', { class: 'btn', text: 'Open', onclick: () => openLead(l, openUrl(l)) })));
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

/* -- connect list (LinkedIn): profiles to send a connection request to -- */
function byTier(a, b) {
  const ra = TIER_RANK[a.tier] ?? 3, rb = TIER_RANK[b.tier] ?? 3;
  return ra - rb || (b.score || 0) - (a.score || 0) || byOrder(a, b);
}
function daysSince(ts) { return ts ? Math.floor((Date.now() - tsMs(ts)) / 86400000) : null; }

function connectOpen(l, card) {
  const go = () => {
    dm.opened.add(l.id);
    if (card) card.classList.add('opened');
    else renderDm('linkedin');   // focus view: the bar switches to "Request sent"
    openLinkedIn(l.profile_url);
  };
  const gate = paceGate('linkedin', 'connect');
  if (gate) sheet(gate.title, [{ label: gate.go, run: go }]);
  else go();
}
function connectMenu(l) {
  const acts = [{ label: 'Open LinkedIn profile', run: () => openLinkedIn(l.profile_url) }];
  if (l.claude_url) acts.push({ label: 'Open the Claude chat that found them ↗', run: () => window.open(l.claude_url, '_blank', 'noopener') });
  if (l.site) acts.push({ label: 'Open their site', run: () => window.open(l.site, '_blank', 'noopener') });
  if (l.status === 'ready') {
    acts.push({ label: 'Already connected (move to Message)', run: () => dmStatus(l, 'accepted', {}, (l.name || 'They') + ' moved to Message', { kind: 'connect', status: 'ready' }) });
    acts.push({ label: "Can't connect (dead link, no button)", danger: true, run: () => dmStatus(l, 'cant_dm', { reason: "couldn't connect" }, 'Moved to Done', 'ready') });
  }
  if (l.status === 'requested') {
    acts.push({ label: 'Undo request (back to To connect)', run: () => dmStatus(l, 'ready', {}, 'Back in To connect', 'requested') });
    acts.push({ label: 'Withdrawn or ignored (move to Done)', danger: true, run: () => dmStatus(l, 'skipped', { reason: 'request withdrawn or ignored' }, 'Moved to Done', 'requested') });
  }
  if (l.status === 'skipped' || l.status === 'cant_dm') acts.push({ label: 'Back to To connect', run: () => dmStatus(l, 'ready', {}, 'Back in To connect', l.status) });
  sheet((l.name || 'Lead') + (l.product ? ' · ' + l.product : ''), acts);
}
function connectCard(l, isNext) {
  const card = el('div', { class: 'card dm-card slim' + (isNext ? ' next' : '') + (dm.opened.has(l.id) ? ' opened' : '') });
  const sub = [l.product, l.tier, l.score != null ? 'score ' + l.score : null, l.source].filter(Boolean).join(' · ');
  card.append(whoRow(l.name || '?', sub, () => connectMenu(l)));
  card.querySelector('.who-name b').textContent = l.name || 'LinkedIn profile';
  if (l.headline) card.append(el('div', { class: 'headline', text: l.headline }));
  if (l.tagline) card.append(el('div', { class: 'headline muted', text: (l.product ? l.product + ': ' : '') + l.tagline }));
  card.append(dmFlags(l, ''));
  card.append(el('div', { class: 'dm-row' },
    el('button', { class: 'btn primary grow', text: 'Open LinkedIn', onclick: () => connectOpen(l, card) }),
    el('button', { class: 'btn ok', text: '✓ Requested', onclick: () => dmStatus(l, 'requested', {}, 'Requested · ' + (l.name || ''), 'ready') }),
    el('button', { class: 'btn', text: 'Skip', onclick: () => dmStatus(l, 'skipped', { reason: 'skipped on phone' }, 'Skipped ' + (l.name || ''), 'ready') })));
  return card;
}
function requestedRow(l) {
  const age = daysSince(l.requested_ts);
  const stale = age !== null && age >= 21;
  return el('div', { class: 'row-card' + (stale ? ' stale' : '') }, avatar(l.name),
    el('div', { class: 'row-text grow' },
      el('b', { text: l.name || '?' }),
      el('span', { class: 'line', text: [l.product, 'requested ' + agoText(l.requested_ts),
        stale ? '3+ weeks, consider withdrawing it' : null].filter(Boolean).join(' · ') })),
    el('button', { class: 'btn sm ok', text: 'Accepted', onclick: () => dmStatus(l, 'accepted', {},
      (l.name || 'They') + ' accepted. Now in Message.', { kind: 'connect', status: 'requested' }) }),
    el('button', { class: 'more-btn', text: '⋯', onclick: () => connectMenu(l) }));
}
function connectDoneRow(l) {
  return el('div', { class: 'row-card' }, avatar(l.name),
    el('div', { class: 'grow' },
      el('b', { text: (l.name || '?') + ' · ' + (l.status === 'cant_dm' ? "couldn't connect" : 'skipped') }),
      el('div', { class: 'line', text: l.skip_reason || l.product || '' })),
    el('button', { class: 'more-btn', text: '⋯', onclick: () => connectMenu(l) }));
}

/* -- Find more: the Mac pulls fresh launches, Claude checks fit -- */
const FIND_TEXT = { created: 'Starting…', fetching: 'Looking', scoring: 'Claude is checking fit', fired: 'Claude is checking fit', working: 'Claude is checking fit', done: 'Done', failed: 'Failed' };
async function loadFind() {
  try { dm.find = await api('/api/leads/find'); } catch { return; }
  document.querySelectorAll('.find-card').forEach((n) => {
    if (!n.contains(document.activeElement)) n.replaceWith(findCard(n.dataset.channel));
  });
  clearTimeout(dm.findTimer);
  const j = dm.find && dm.find.job;
  if (j && ACTIVE.includes(j.status)) dm.findTimer = setTimeout(async () => { await loadFind(); if (!(dm.find.job && ACTIVE.includes(dm.find.job.status))) refresh(); }, 8000);
}
function findCard(ch) {
  const card = el('div', { class: 'card find-card', 'data-channel': ch });
  const camps = Object.entries(dm.campaigns).filter(([, v]) => (v.channels || DM_CH).includes(ch));
  card.append(el('div', { class: 'find-title', text: ch === 'linkedin' ? 'Find more people to connect with' : 'Find more X leads' }));
  if (!camps.length) {
    card.append(el('div', { class: 'small muted', text: 'Needs campaign rules first. Ask Claude in Cowork to set up the sidekick campaigns.' }));
    return card;
  }
  const sel = el('select', { 'aria-label': 'Campaign' });
  camps.forEach(([k, v]) => sel.append(el('option', { value: k, text: v.label || k })));
  sel.value = camps.some(([k]) => k === LS.get('find_camp_' + ch)) ? LS.get('find_camp_' + ch) : camps[0][0];
  sel.addEventListener('change', () => LS.set('find_camp_' + ch, sel.value));
  const want = el('input', { type: 'number', inputmode: 'numeric', min: 1, max: 100, 'aria-label': 'How many', value: LS.get('find_want_' + ch, '20') });
  want.addEventListener('change', () => LS.set('find_want_' + ch, want.value));
  const run = dm.find && dm.find.run;
  const job = dm.find && dm.find.job;
  const busy = job && ACTIVE.includes(job.status);
  const btn = el('button', { class: 'btn primary', text: busy ? 'Running…' : 'Find', onclick: async () => {
    const n = parseInt(want.value, 10);
    if (!Number.isFinite(n) || n < 1) { toast('Type how many you want', true); return; }
    btn.disabled = true;
    try {
      await api('/api/leads/find', { campaign: sel.value, channel: ch, want: n });
      toast('Looking. This takes a few minutes; you can keep working.');
    } catch (e) { toast(e.message, true); }
    loadFind();
  } });
  btn.disabled = !!busy;
  card.append(el('div', { class: 'find-row' }, sel, want, btn));
  if (run && run.channel === ch) {
    const bits = [(FIND_TEXT[job && job.status] || (job && job.status) || '') + (busy && job.progress ? ' · ' + job.progress : '')];
    if (run.added_count) bits.push('added ' + run.added_count);
    else if (!busy && run.candidate_count) bits.push(run.candidate_count + ' candidates');
    bits.push(agoText(run.ts));
    card.append(el('div', { class: 'small muted find-status', text: (job && job.error ? 'Failed: ' + job.error : bits.filter(Boolean).join(' · ')) }));
    if (job && job.report && !busy) card.append(el('div', { class: 'small muted find-report', text: job.report }));
    if (!busy && !run.added_count && run.candidate_count) {
      card.append(el('button', { class: 'btn block', text: 'Add the top ' + Math.min(run.want, run.candidate_count) + " without Claude's check", onclick: async (e) => {
        const done = busy2(e.target);
        try { const r = await api('/api/leads/find/add-unchecked', { job_id: run.job_id }); toast('Added ' + r.added); await refresh(); } catch (err) { toast(err.message, true); }
        done();
      } }));
    }
  }
  return card;
}
function busy2(btn) { btn.disabled = true; return () => { btn.disabled = false; }; }

/* -- people with no message yet (just accepted, or found on X) -- */
function needsCard(ch, needs) {
  const writing = needs.filter((l) => l.writing_job).length;
  const card = el('div', { class: 'card needs-card' });
  card.append(el('div', { class: 'find-title', text: needs.length + (needs.length === 1 ? ' person needs' : ' people need') + ' a message' }));
  for (const l of needs.slice(0, 30)) {
    const why = l.accepted_ts ? 'accepted ' + agoText(l.accepted_ts) : (l.note || l.flag || l.batch || '');
    card.append(el('div', { class: 'needs-row' },
      el('b', { text: dmWho(l) }), el('span', { class: 'muted', text: ' ' + [l.product, why].filter(Boolean).join(' · ') }),
      el('button', { class: 'more-btn', text: '⋯', onclick: () => dmMenu(l) })));
  }
  card.append(el('button', { class: 'btn primary block', text: writing ? 'Claude is writing ' + writing + '…' : '✍ Write with Claude', onclick: async (e) => {
    const done = busy2(e.target);
    try { const r = await api('/api/dm/write', { channel: ch }); toast('Claude is writing ' + r.leads + '. Takes a few minutes.'); await refresh(); }
    catch (err) { toast(err.message, true); }
    done();
  } }));
  if (writing) card.lastChild.disabled = true;
  return card;
}

function paceStrip(ch, mode) {
  const p = paceState(ch, mode);
  const ss = sessionOf(ch, mode);
  const inp = el('input', { class: 'sess-input', type: 'number', inputmode: 'numeric', min: 1, max: 500, placeholder: '-', 'aria-label': 'How many this session' });
  if (ss && ss.target) inp.value = ss.target;
  inp.addEventListener('change', () => {
    const v = parseInt(inp.value, 10);
    setSession(ch, mode, Number.isFinite(v) && v > 0 ? v : 0);
    inp.blur();
    renderDm(ch);
    toast(Number.isFinite(v) && v > 0 ? 'Session started: ' + v + (mode === 'connect' ? ' requests' : ' messages') : 'Session cleared');
  });
  return el('div', { class: 'pace ' + p.cls },
    el('span', { class: 'pace-dot' }), el('span', { class: 'pace-text', text: p.text }),
    p.cool ? el('button', { class: 'link', text: 'Clear', onclick: () => sheet('End the cooldown early?', [{ label: 'Yes, ' + DM_NAME[ch] + ' is sending again', run: async () => {
      try { const r = await api('/api/dm/cooldown/clear', { channel: ch }); dm.stats = r.stats; renderDm(ch); } catch (e) { toast(e.message, true); }
    } }]) }) : null,
    el('label', { class: 'sess' }, el('span', { text: 'This session' }), inp));
}

function segBar(segs, current, counts, onPick) {
  const seg = el('div', { class: 'dseg', role: 'tablist' });
  for (const [key, label] of segs) {
    seg.append(el('button', { class: current === key ? 'on' : '', onclick: () => { onPick(key); window.scrollTo(0, 0); } },
      label + ' ', counts[key] ? el('b', { text: String(counts[key]) }) : null));
  }
  return seg;
}

/* ================= LinkedIn tab: one person at a time =================
 * The LinkedIn work is the same small loop over and over: open a profile,
 * connect, come back, mark it; or copy a message, send it, come back, mark it.
 * So the default view is a focus deck: one person on a big card, the buttons
 * in a bar at thumb height above the tab bar, and after each mark the next
 * person slides in. Every mark has Undo. The full list is one tap away.
 */
const li = {
  view: { connect: LS.get('li_view_connect', 'focus'), message: LS.get('li_view_message', 'focus') },
  // Stored so a reload (the phone killing the app behind LinkedIn) lands on the same person.
  focus: { connect: LS.get('li_focus_connect', '') || null, message: LS.get('li_focus_message', '') || null }, idx: { connect: 0, message: 0 },
  q: '', showNeeds: false,
};
const TIER_GROUPS = [['Contact this week', 0], ['Next batch', 1], ['Later', 2], ['No tier', 3]];
function tierRank(t) { return TIER_RANK[t] ?? 3; }

function setDmActions(nodes) {
  const bar = $('dmActions');
  const show = nodes && nodes.length && currentTab() === 'linkedin';
  bar.hidden = !show;
  bar.replaceChildren(...(show ? nodes : []));
  document.body.classList.toggle('with-actionbar', !!show);
}

/* A sheet with custom content (the plain sheet() only takes buttons). */
function sheetCustom(title, nodes) {
  $('toast').hidden = true;
  const body = $('sheetBody');
  body.replaceChildren(el('div', { class: 'sheet-title', text: title }), ...nodes,
    el('button', { text: 'Cancel', onclick: closeSheet }));
  $('sheet').hidden = false;
}

function numberPicker(values, current, onPick, noun) {
  const grid = el('div', { class: 'sheet-grid' });
  for (const n of values) {
    grid.append(el('button', { class: n === current ? 'on' : '', text: String(n), onclick: () => onPick(n) }));
  }
  const inp = el('input', { type: 'number', inputmode: 'numeric', min: 1, max: 500, placeholder: 'Or type a number' });
  const go = el('button', { class: 'btn primary', text: 'Set', onclick: () => {
    const v = parseInt(inp.value, 10);
    if (Number.isFinite(v) && v > 0) onPick(v); else toast('Type how many ' + noun, true);
  } });
  return [grid, el('div', { class: 'sheet-row' }, inp, go)];
}

function openSessionSheet(ch, mode) {
  const noun = mode === 'connect' ? 'requests' : 'messages';
  const cur = sessionOf(ch, mode);
  const set = (n) => {
    closeSheet();
    setSession(ch, mode, n);
    renderDm(ch);
    toast(n ? 'Session: ' + n + ' ' + noun + '. The counter starts now.' : 'Session cleared');
  };
  const nodes = numberPicker([5, 10, 15, 20, 25, 30, 40, 50], cur && cur.target, set, noun);
  if (cur) nodes.push(el('button', { class: 'danger', text: 'Clear session', onclick: () => set(0) }));
  sheetCustom('How many ' + noun + ' this session?', nodes);
}

function openFindSheet() {
  const ch = 'linkedin';
  const camps = Object.entries(dm.campaigns).filter(([, v]) => (v.channels || DM_CH).includes(ch));
  if (!camps.length) { toast('Set up the campaign rules in Cowork first', true); return; }
  let camp = camps.some(([k]) => k === LS.get('find_camp_' + ch)) ? LS.get('find_camp_' + ch) : camps[0][0];
  const campSeg = el('div', { class: 'sheet-seg' });
  const drawCamps = () => campSeg.replaceChildren(...camps.map(([k, v]) => el('button', {
    class: k === camp ? 'on' : '', text: v.label || k, onclick: () => { camp = k; LS.set('find_camp_' + ch, k); drawCamps(); } })));
  drawCamps();
  const run = async (n) => {
    closeSheet();
    LS.set('find_want_' + ch, String(n));
    try {
      await api('/api/leads/find', { campaign: camp, channel: ch, want: n });
      toast('Looking for ' + n + '. Takes a few minutes, keep working.');
    } catch (e) { toast(e.message, true); }
    loadFind();
  };
  // Pick a number, then press Find: tapping a number alone never starts a run.
  let want = parseInt(LS.get('find_want_' + ch, '20'), 10) || 20;
  const grid = el('div', { class: 'sheet-grid' });
  const other = el('input', { type: 'number', inputmode: 'numeric', min: 1, max: 100, placeholder: 'Other number' });
  const go = el('button', { class: 'btn primary block find-go', onclick: () => run(want) });
  const draw = () => {
    grid.replaceChildren(...[10, 20, 30, 50].map((n) => el('button', { class: n === want ? 'on' : '', text: String(n),
      onclick: () => { want = n; other.value = ''; draw(); } })));
    go.textContent = 'Find ' + want + ' people';
  };
  other.addEventListener('input', () => {
    const v = parseInt(other.value, 10);
    if (Number.isFinite(v) && v > 0) { want = Math.min(v, 100); draw(); }
  });
  draw();
  const status = findStatusText(ch);
  sheetCustom('Find more people to connect with', [
    el('div', { class: 'sheet-label', text: 'For' }), campSeg,
    el('div', { class: 'sheet-label', text: 'How many' }), grid,
    el('div', { class: 'sheet-row' }, other),
    el('div', { class: 'sheet-row' }, go),
    el('div', { class: 'sheet-note', text: 'Fresh launches from Peerlist, Uneed and Fazier. Only makers who listed their own LinkedIn, product site checked, nobody you already contacted. Claude checks the fit before they show up here, in a few minutes.' }),
    status ? el('div', { class: 'sheet-note', text: 'Last run: ' + status }) : null,
  ].filter(Boolean));
}

function findStatusText(ch) {
  const run = dm.find && dm.find.run;
  const job = dm.find && dm.find.job;
  if (!run || run.channel !== ch || !job) return '';
  const busy = ACTIVE.includes(job.status);
  if (busy) return (FIND_TEXT[job.status] || job.status) + (job.progress ? ' · ' + job.progress : '');
  if (job.error) return 'failed: ' + job.error;
  return (run.added_count ? 'added ' + run.added_count : 'nothing added') + ' · ' + agoText(run.ts);
}

/* One row of chips: today's count, the session, and Find more. */
function liStatus(mode) {
  const s = dm.stats.linkedin || {};
  const c = paceCfg('linkedin', mode);
  const p = paceState('linkedin', mode);
  const done = mode === 'connect' ? (s.requested_today || 0) : (s.sent_today || 0);
  const ss = sessionOf('linkedin', mode);
  const row = el('div', { class: 'li-status' });
  row.append(el('button', { class: 'pill-chip' + (done >= c.cap ? ' warn' : ''), onclick: () => showTab('settings'),
    text: 'Today ' + done + '/' + c.cap }));
  row.append(el('button', { class: 'pill-chip' + (p.sessionDone ? ' ok' : ss ? ' accent' : ''), onclick: () => openSessionSheet('linkedin', mode),
    text: ss && ss.target ? 'Session ' + sessionCount('linkedin', mode, ss) + '/' + ss.target : '+ Session' }));
  if (mode === 'message' && p.wait) row.append(el('span', { class: 'pill-chip li-next', text: 'Next in ' + mmss(p.wait) }));
  if (mode === 'connect') {
    const job = dm.find && dm.find.job;
    const busy = job && ACTIVE.includes(job.status) && dm.find.run && dm.find.run.channel === 'linkedin';
    row.append(el('button', { class: 'pill-chip find' + (busy ? ' busy' : ''), onclick: openFindSheet,
      text: busy ? 'Finding…' : '+ Find more' }));
  }
  const nodes = [row];
  if (p.capped) {
    nodes.push(el('div', { class: 'li-warn', text: mode === 'connect'
      ? "That's " + done + ' requests today. LinkedIn signed you out after about 82 on Sep 28, so stop here for today.'
      : "That's your daily message cap. More today raises the spam risk." }));
  } else if (p.sessionDone) {
    nodes.push(el('div', { class: 'li-warn ok', text: 'Session done: ' + ss.target + ' ' + (mode === 'connect' ? 'requests' : 'messages') + '. Nice.' }));
  }
  if (mode === 'connect') {
    const t = findStatusText('linkedin');
    const job = dm.find && dm.find.job;
    if (t && job && (ACTIVE.includes(job.status) || Date.now() - tsMs(dm.find.run.ts) < 3 * 3600e3)) {
      nodes.push(el('button', { class: 'find-line', onclick: openFindSheet, text: 'Find more: ' + t }));
    }
  }
  return nodes;
}

function liPill(text, cls) { return text ? el('span', { class: 'tier-pill ' + (cls || ''), text }) : null; }
function tierPill(t) { return t ? liPill(t, 'tier-' + tierRank(t)) : null; }
function campPill(c) { return c ? liPill((dm.campaigns[c] && dm.campaigns[c].label) || c, 'camp') : null; }

function pickFocus(mode, list) {
  if (!list.length) { li.focus[mode] = null; return -1; }
  let i = list.findIndex((l) => l.id === li.focus[mode]);
  if (i < 0) i = Math.min(li.idx[mode], list.length - 1);
  li.focus[mode] = list[i].id;
  li.idx[mode] = i;
  LS.set('li_focus_' + mode, list[i].id);
  return i;
}
function focusOn(mode, id) {
  li.focus[mode] = id;
  li.view[mode] = 'focus';
  LS.set('li_view_' + mode, 'focus');
  renderDm('linkedin');
  window.scrollTo(0, 0);
}

function viewToggle(mode, count) {
  const seg = el('div', { class: 'mini-seg' },
    ...[['focus', 'One by one'], ['list', 'List' + (count ? ' (' + count + ')' : '')]].map(([v, label]) =>
      el('button', { class: li.view[mode] === v ? 'on' : '', text: label, onclick: () => {
        li.view[mode] = v; LS.set('li_view_' + mode, v); renderDm('linkedin'); window.scrollTo(0, 0);
      } })));
  return seg;
}

function campFilterChip(camps) {
  if (camps.length < 2) return null;
  const cur = dm.camp.linkedin;
  const label = cur ? ((dm.campaigns[cur] && dm.campaigns[cur].label) || cur) : 'All';
  return el('button', { class: 'pill-chip small', text: label + ' ▾', onclick: () => sheet('Show', [
    { label: 'All campaigns', run: () => { dm.camp.linkedin = ''; LS.set('dmcamp_linkedin', ''); renderDm('linkedin'); } },
    ...camps.map((c) => ({ label: (dm.campaigns[c] && dm.campaigns[c].label) || c,
      run: () => { dm.camp.linkedin = c; LS.set('dmcamp_linkedin', c); renderDm('linkedin'); } })),
  ]) });
}

/* A search box over a list. Typing only redraws the results under it, so the
 * keyboard stays up. */
function searchable(placeholder, draw) {
  const inp = el('input', { class: 'search', type: 'search', placeholder, value: li.q });
  const results = el('div', { class: 'results' });
  const fill = () => {
    const out = draw();
    results.replaceChildren(...(out.length ? out : [el('div', { class: 'empty', text: li.q ? 'No match.' : 'Nobody here yet.' })]));
  };
  inp.addEventListener('input', () => { li.q = inp.value; clearTimeout(li.qTimer); li.qTimer = setTimeout(fill, 150); });
  fill();
  return [inp, results];
}
function matches(l) {
  const q = li.q.trim().toLowerCase();
  return !q || [l.name, l.product, l.headline, l.tagline].some((x) => String(x || '').toLowerCase().includes(q));
}

function upNext(mode, list, from) {
  const next = list.slice(from + 1, from + 4);
  if (!next.length) return null;
  return el('div', { class: 'up-next' }, el('div', { class: 'tier-head', text: 'Up next' }),
    ...next.map((l) => el('button', { class: 'next-row', onclick: () => focusOn(mode, l.id) },
      el('b', { text: l.name || '?' }), el('span', { class: 'muted', text: ' ' + (l.product || '') }),
      tierPill(l.tier))));
}

function focusHeader(i, total, l) {
  return el('div', { class: 'focus-top' },
    el('span', { class: 'focus-count', text: (i + 1) + ' of ' + total }), tierPill(l.tier), campPill(l.campaign));
}
function focusFacts(l) {
  const facts = [l.score != null && l.score !== '' ? 'Score ' + l.score : null, l.icp || null, l.source || null,
    l.launch ? 'Launched ' + l.launch : null, l.batch || null].filter(Boolean);
  return facts.length ? el('div', { class: 'focus-facts' }, ...facts.map((f) => el('span', { class: 'fact', text: f }))) : null;
}
function focusNav(mode, list, i) {
  return el('div', { class: 'focus-nav' },
    el('button', { class: 'link', text: '‹ Previous', disabled: i === 0, onclick: () => { li.focus[mode] = list[i - 1].id; renderDm('linkedin'); } }),
    el('button', { class: 'link', text: 'Later ›', title: 'Leave this one for later and show the next', onclick: () => {
      li.focus[mode] = list[(i + 1) % list.length].id; renderDm('linkedin'); } }));
}

/* -- Connect: one profile at a time -- */
function connectFocus(list, nodes) {
  const i = pickFocus('connect', list);
  if (i < 0) {
    nodes.push(el('div', { class: 'empty' }, el('div', { text: 'Nobody left to connect with.' }),
      el('button', { class: 'btn primary', text: '+ Find more people', onclick: openFindSheet })));
    setDmActions(null);
    return;
  }
  const l = list[i];
  const opened = dm.opened.has(l.id);
  const card = el('div', { class: 'card focus-card' + (opened ? ' opened' : '') });
  card.append(focusHeader(i, list.length, l),
    el('div', { class: 'focus-name', text: l.name || 'LinkedIn profile' }),
    l.product ? el('div', { class: 'focus-product', text: l.product }) : null);
  // Right under the name, so it is in view the moment he comes back from LinkedIn.
  if (opened) card.append(el('div', { class: 'focus-hint', text: "Sent the request? Tap Request sent. If LinkedIn wouldn't let you, tap Couldn't." }));
  if (l.headline) card.append(el('div', { class: 'focus-line', text: l.headline }));
  if (l.tagline) card.append(el('div', { class: 'focus-line muted', text: l.tagline }));
  card.append(dmFlags(l, ''));
  const facts = focusFacts(l);
  if (facts) card.append(facts);
  card.append(focusNav('connect', list, i));
  nodes.push(card);
  const nx = upNext('connect', list, i);
  if (nx) nodes.push(nx);
  const requested = () => dmStatus(l, 'requested', {}, 'Request sent to ' + (l.name || ''), 'ready');
  // Sent is always on the bar: he can log a request whether or not the app
  // remembered that LinkedIn was opened.
  setDmActions(opened ? [
    el('button', { class: 'btn ok-solid grow', text: '✓ Request sent', onclick: requested }),
    el('button', { class: 'btn', text: "Couldn't", onclick: () => dmStatus(l, 'cant_dm', { reason: "couldn't connect" }, 'Moved to Done', 'ready') }),
    el('button', { class: 'btn icon', text: '↗', title: 'Open LinkedIn again', onclick: () => connectOpen(l) }),
  ] : [
    el('button', { class: 'btn primary grow', text: 'Open LinkedIn ↗', onclick: () => connectOpen(l) }),
    el('button', { class: 'btn ok', text: '✓ Sent', onclick: requested }),
    el('button', { class: 'btn', text: 'Skip', onclick: () => dmStatus(l, 'skipped', { reason: 'skipped on phone' }, 'Skipped ' + (l.name || ''), 'ready') }),
    el('button', { class: 'btn icon', text: '⋯', onclick: () => connectMenu(l) }),
  ]);
}

function compactRow(l, onTap, right) {
  return el('div', { class: 'row-card tap' },
    el('button', { class: 'row-main', onclick: onTap },
      avatar(l.name),
      el('span', { class: 'row-text' },
        el('b', { text: l.name || '?' }),
        el('span', { class: 'line', text: [l.product, l.score != null && l.score !== '' ? 'score ' + l.score : null].filter(Boolean).join(' · ') }))),
    right || null);
}

function groupedByTier(list, rowFn) {
  const out = [];
  for (const [label, rank] of TIER_GROUPS) {
    const group = list.filter((l) => Math.min(tierRank(l.tier), 3) === rank);
    if (!group.length) continue;
    out.push(el('div', { class: 'tier-head', text: label + ' · ' + group.length }), ...group.map(rowFn));
  }
  return out;
}

function connectList(list, nodes) {
  setDmActions(null);
  // In the list, the row's button follows the same two steps as the focus
  // view: Open, then (once opened) Sent.
  nodes.push(...searchable('Search a name or product', () => groupedByTier(list.filter(matches), (l) =>
    compactRow(l, () => focusOn('connect', l.id), el('span', { class: 'row-btns' },
      el('button', { class: 'btn sm', text: '↗', title: 'Open LinkedIn', onclick: () => connectOpen(l, null) }),
      el('button', { class: 'btn sm ' + (dm.opened.has(l.id) ? 'ok-solid' : 'ok'), text: '✓ Sent', onclick: () => dmStatus(l, 'requested', {}, 'Request sent to ' + (l.name || ''), 'ready') }))))));
}

/* The server reads LinkedIn's "accepted your invitation" emails and moves those
 * people to Message by itself (accept_watch.py). This line says when it last
 * looked; Check now runs it immediately. */
function acceptLine() {
  const aw = state.acceptWatch;
  if (!aw || !aw.on) return el('p', { class: 'hint', text: 'When LinkedIn says someone accepted, find them here and tap Accepted. They move to Message.' });
  const text = aw.error ? 'Email check failed: ' + aw.error
    : 'Accepts are picked up from your LinkedIn emails every ' + aw.every_min + ' min' + (aw.last_ts ? ' · checked ' + agoText(aw.last_ts) : '')
      + (aw.last_found ? ' · ' + aw.last_found + ' moved to Message' : '') + '. Tap Accepted for anyone it misses.';
  return el('div', { class: 'focus-meta' }, el('span', { class: 'small ' + (aw.error ? 'err-text' : 'muted'), text }),
    el('span', { class: 'spacer' }),
    el('button', { class: 'link', text: 'Check now', onclick: async (e) => {
      const done = busy2(e.target);
      try {
        const r = await api('/api/dm/accept-check', {});
        toast(r.error ? 'Check failed: ' + r.error : r.moved.length ? r.moved.length + ' accepted: ' + r.moved.join(', ') : 'Nobody new accepted', !!r.error);
        await refresh();
        renderDm('linkedin');
      } catch (err) { toast(err.message, true); }
      done();
    } }));
}

function requestedList(list, nodes) {
  setDmActions(null);
  nodes.push(acceptLine());
  nodes.push(...searchable('Search who accepted', () => list.filter(matches).map(requestedRow)));
}

/* -- Message: one message at a time -- */
function messageBox(l) {
  const ta = el('textarea', { class: 'dm-msg', rows: 8, spellcheck: 'true' });
  ta.value = messageOf(l);
  const count = el('span', { class: 'chars', text: ta.value.trim().length + ' chars' });
  let timer;
  const save = async () => {
    const v = ta.value;
    const body = v === baseMessage(l) ? { draft_text: null } : { draft_text: v };
    if ((body.draft_text ?? null) === (typeof l.draft_text === 'string' ? l.draft_text : null)) return;
    if (body.draft_text === null) delete l.draft_text; else l.draft_text = v;
    try { await dmSave(l, body, true); } catch { /* quiet autosave */ }
  };
  ta.addEventListener('input', () => { count.textContent = ta.value.trim().length + ' chars'; clearTimeout(timer); timer = setTimeout(save, 1000); });
  ta.addEventListener('blur', () => { clearTimeout(timer); save(); });
  return { ta, count };
}

function variantChips(l) {
  if (!(l.variants && l.variants.length > 1)) return null;
  const cur = (l.variant_index || 0) % l.variants.length;
  const pick = async (k) => {
    l.variant_index = k;
    delete l.draft_text;
    renderDm('linkedin');
    try { await dmSave(l, { variant_index: k, draft_text: null }); } catch { /* toasted */ }
  };
  return el('div', { class: 'var-chips' }, ...l.variants.map((v, k) => el('button', {
    class: 'chip' + (k === cur ? ' on' : ''), text: v.label || 'Version ' + (k + 1),
    onclick: () => {
      if (k === cur) return;
      if (typeof l.draft_text === 'string') sheet('Switch and lose your edits to this one?', [{ label: 'Switch', run: () => pick(k) }]);
      else pick(k);
    } })));
}

function messageFocus(list, nodes) {
  const i = pickFocus('message', list);
  if (i < 0) {
    nodes.push(el('div', { class: 'empty', text: 'No written messages waiting. People land here when they accept your request.' }));
    setDmActions(null);
    return;
  }
  const l = list[i];
  const opened = dm.opened.has(l.id);
  const card = el('div', { class: 'card focus-card' + (opened ? ' opened' : '') });
  card.append(focusHeader(i, list.length, l),
    el('div', { class: 'focus-name', text: l.name || 'LinkedIn lead' }),
    l.product ? el('div', { class: 'focus-product', text: l.product }) : null);
  if (opened) card.append(el('div', { class: 'focus-hint', text: 'Sent it? Tap Sent. Changed it in LinkedIn? Paste what you sent over the text first.' }));
  card.append(dmFlags(l, ''));
  const chips = variantChips(l);
  if (chips) card.append(chips);
  const { ta, count } = messageBox(l);
  card.append(ta, el('div', { class: 'focus-meta' }, el('span', { class: 'muted small', text: 'Tap the text to edit' }), el('span', { class: 'spacer' }), count));
  card.append(el('div', { class: 'focus-meta' },
    el('button', { class: 'link', text: '✎ Tell Claude what to change', onclick: () => tellClaude(l, ta) }),
    el('span', { class: 'spacer' }),
    l.claude_url ? el('button', { class: 'link', text: 'Claude chat ↗', onclick: () => openChat(l, ta.value) }) : null));
  card.append(focusNav('message', list, i));
  nodes.push(card);
  const nx = upNext('message', list, i);
  if (nx) nodes.push(nx);
  setDmActions(opened ? [
    el('button', { class: 'btn ok-solid grow', text: '✓ Sent', onclick: () => dmMarkSent(l, ta) }),
    el('button', { class: 'btn', text: 'Skip', onclick: () => dmStatus(l, 'skipped', { reason: 'skipped on phone' }, 'Skipped ' + dmWho(l), 'ready') }),
    el('button', { class: 'btn icon', text: '↗', title: 'Copy and open again', onclick: () => dmCopyOpen(l, ta) }),
    el('button', { class: 'btn icon', text: '⋯', onclick: () => dmMenu(l, ta) }),
  ] : [
    el('button', { class: 'btn primary grow', text: 'Copy + open ↗', onclick: () => dmCopyOpen(l, ta) }),
    el('button', { class: 'btn ok', text: '✓ Sent', onclick: () => dmMarkSent(l, ta) }),
    el('button', { class: 'btn', text: 'Skip', onclick: () => dmStatus(l, 'skipped', { reason: 'skipped on phone' }, 'Skipped ' + dmWho(l), 'ready') }),
    el('button', { class: 'btn icon', text: '⋯', onclick: () => dmMenu(l, ta) }),
  ]);
}

function messageList(list, nodes) {
  setDmActions(null);
  nodes.push(...searchable('Search a name or product', () => groupedByTier(list.filter(matches), (l) =>
    compactRow(l, () => focusOn('message', l.id), el('button', { class: 'btn sm', text: 'Open', onclick: () => focusOn('message', l.id) })))));
}

function needsBanner(needs) {
  const writing = needs.filter((l) => l.writing_job).length;
  const box = el('div', { class: 'needs-banner' });
  box.append(el('div', { class: 'nb-text' },
    el('b', { text: needs.length + (needs.length === 1 ? ' person needs' : ' people need') + ' a message' }),
    el('div', { class: 'muted small', text: writing ? 'Claude is writing ' + writing + '. They show up here in a few minutes.' : 'New connections and fits with nothing written yet.' })));
  box.append(el('div', { class: 'nb-actions' },
    el('button', { class: 'btn sm primary', text: writing ? 'Writing…' : '✍ Write with Claude', disabled: !!writing, onclick: async (e) => {
      const done = busy2(e.target);
      try { const r = await api('/api/dm/write', { channel: 'linkedin' }); toast('Claude is writing ' + r.leads + '. Takes a few minutes.'); await refresh(); }
      catch (err) { toast(err.message, true); }
      done();
    } }),
    el('button', { class: 'link', text: li.showNeeds ? 'Hide' : 'Show', onclick: () => { li.showNeeds = !li.showNeeds; renderDm('linkedin'); } })));
  if (li.showNeeds) {
    box.append(el('div', { class: 'nb-list' }, ...needs.map((l) => el('div', { class: 'needs-row' },
      el('b', { text: dmWho(l) }),
      el('span', { class: 'muted', text: ' ' + [l.product, l.accepted_ts ? 'accepted ' + agoText(l.accepted_ts) : ''].filter(Boolean).join(' · ') }),
      el('button', { class: 'more-btn', text: '⋯', onclick: () => dmMenu(l) })))));
  }
  return box;
}

function renderLinkedIn(root) {
  const ch = 'linkedin';
  const mode = modeOf(ch);
  const all = dm.leads.filter((l) => l.channel === ch);
  const nodes = [];
  const nConnect = all.filter((l) => kindOf(l) === 'connect' && l.status === 'ready').length;
  const nMessage = all.filter((l) => kindOf(l) === 'message' && l.status === 'ready' && !l.needs_message).length;
  nodes.push(el('div', { class: 'modes' },
    ...[['connect', 'Connect', nConnect], ['message', 'Message', nMessage]].map(([m, label, n]) =>
      el('button', { class: 'mode' + (mode === m ? ' on' : ''), onclick: () => {
        dm.mode.linkedin = m; LS.set('dmmode_linkedin', m); li.q = ''; renderDm(ch); dmTicker(); window.scrollTo(0, 0);
      } }, label, n ? el('b', { text: ' ' + n }) : null))));
  nodes.push(...liStatus(mode));

  const mine = all.filter((l) => kindOf(l) === mode);
  const camps = [...new Set(mine.filter((l) => ['ready', 'sent', 'requested'].includes(l.status)).map((l) => l.campaign))].filter(Boolean);
  if (dm.camp[ch] && !camps.includes(dm.camp[ch])) dm.camp[ch] = '';
  const inCamp = (l) => !dm.camp[ch] || l.campaign === dm.camp[ch];

  if (mode === 'connect') {
    const todo = mine.filter((l) => l.status === 'ready' && inCamp(l)).sort(byTier);
    const asked = mine.filter((l) => l.status === 'requested' && inCamp(l))
      .sort((a, b) => (b.requested_ts || '').localeCompare(a.requested_ts || ''));
    const cdone = mine.filter((l) => ['skipped', 'cant_dm'].includes(l.status) && inCamp(l));
    nodes.push(segBar(CONNECT_SEGS, dm.cseg, { connect: todo.length, requested: asked.length },
      (k) => { dm.cseg = k; LS.set('dmcseg', k); li.q = ''; renderDm(ch); }));
    if (dm.cseg === 'requested') {
      requestedList(asked, nodes);
    } else if (dm.cseg === 'cdone') {
      setDmActions(null);
      nodes.push(...(cdone.length ? cdone.map(connectDoneRow) : [el('div', { class: 'empty', text: 'Skips and dead links land here.' })]));
    } else {
      nodes.push(el('div', { class: 'view-row' }, viewToggle('connect', todo.length), el('span', { class: 'spacer' }), campFilterChip(camps)));
      if (li.view.connect === 'list') connectList(todo, nodes); else connectFocus(todo, nodes);
    }
    root.replaceChildren(...nodes);
    return;
  }

  const saved = state.outreach.filter((o) => o.platform === 'linkedin' && o.status === 'queued');
  const ready = mine.filter((l) => l.status === 'ready' && inCamp(l)).sort(byTier);
  const needs = ready.filter((l) => l.needs_message);
  const writable = ready.filter((l) => !l.needs_message);
  const sent = mine.filter((l) => l.status === 'sent' && inCamp(l)).sort((a, b) => (b.sent_ts || '').localeCompare(a.sent_ts || ''));
  const done = mine.filter((l) => ['replied', 'skipped', 'cant_dm'].includes(l.status) && inCamp(l))
    .sort((a, b) => ((b.status === 'replied') - (a.status === 'replied')) || (b.updated_ts || '').localeCompare(a.updated_ts || ''));
  const replied = done.filter((l) => l.status === 'replied').length;
  nodes.push(segBar(DM_SEGS, dm.seg[ch], { send: writable.length, sent: sent.length, done: replied, saved: saved.length },
    (k) => { dm.seg[ch] = k; LS.set('dmseg_' + ch, k); li.q = ''; renderDm(ch); }));
  const which = dm.seg[ch];
  if (which === 'send') {
    if (needs.length) nodes.push(needsBanner(needs));
    nodes.push(el('div', { class: 'view-row' }, viewToggle('message', writable.length), el('span', { class: 'spacer' }), campFilterChip(camps)));
    if (li.view.message === 'list') messageList(writable, nodes); else messageFocus(writable, nodes);
  } else {
    setDmActions(null);
    if (which === 'sent') {
      nodes.push(el('p', { class: 'hint', text: 'Waiting on a reply. Tap "They replied" when one comes in, and paste it so Claude can draft your answer.' }));
      nodes.push(...(sent.length ? sent.map(dmSentCard) : [el('div', { class: 'empty', text: 'Nothing sent in the last 30 days.' })]));
    } else if (which === 'done') {
      nodes.push(...(done.length ? done.map(dmDoneRow) : [el('div', { class: 'empty', text: 'Replies, skips and closed chats land here.' })]));
    } else {
      nodes.push(el('p', { class: 'hint', text: 'Profiles you share from the LinkedIn app land here. Claude turns them into the next batch.' }));
      nodes.push(...(saved.length ? saved.map(savedRow) : [el('div', { class: 'empty', text: 'No profiles saved.' })]));
    }
  }
  root.replaceChildren(...nodes);
}

/* -- panel -- */
function renderDm(ch, keepLinesOpenFor) {
  const root = $('dm-' + ch);
  if (!root) return;
  dm.pending[ch] = false;
  if (ch === 'linkedin' && !dm.missing && !dm.error) { renderLinkedIn(root); return; }
  if (ch === 'linkedin') setDmActions(null);
  const saved = state.outreach.filter((o) => (o.platform || 'x') === ch && o.status === 'queued');
  const nodes = [];
  if (dm.missing || dm.error) {
    nodes.push(el('div', { class: 'empty', text: dm.missing
      ? 'The sidekick server on your Mac is an older version. Restart it (server/start.sh) to turn on outreach.'
      : 'Could not load outreach: ' + dm.error }));
    root.replaceChildren(...nodes);
    return;
  }
  const mode = modeOf(ch);
  const all = dm.leads.filter((l) => l.channel === ch);
  const mine = all.filter((l) => kindOf(l) === (mode === 'connect' ? 'connect' : 'message'));

  if (ch === 'linkedin') {
    const nConnect = all.filter((l) => kindOf(l) === 'connect' && l.status === 'ready').length;
    const nMessage = all.filter((l) => kindOf(l) === 'message' && l.status === 'ready').length;
    nodes.push(el('div', { class: 'modes' },
      ...[['connect', 'Connect', nConnect], ['message', 'Message', nMessage]].map(([m, label, n]) =>
        el('button', { class: 'mode' + (mode === m ? ' on' : ''), onclick: () => {
          dm.mode.linkedin = m; LS.set('dmmode_linkedin', m); renderDm(ch); dmTicker(); window.scrollTo(0, 0);
        } }, label, n ? el('b', { text: ' ' + n }) : null))));
  }

  nodes.push(paceStrip(ch, mode));

  const camps = [...new Set(mine.filter((l) => ['ready', 'sent', 'requested'].includes(l.status)).map((l) => l.campaign))].filter(Boolean);
  if (dm.camp[ch] && !camps.includes(dm.camp[ch])) dm.camp[ch] = '';
  const inCamp = (l) => !dm.camp[ch] || l.campaign === dm.camp[ch];
  if (camps.length > 1) {
    const chips = el('div', { class: 'chips dm-chips' });
    for (const [val, label] of [['', 'All'], ...camps.map((c) => [c, (dm.campaigns[c] && dm.campaigns[c].label) || c.replace(/-/g, ' ')])]) {
      chips.append(el('button', { class: 'chip' + (dm.camp[ch] === val ? ' on' : ''), text: label, onclick: () => {
        dm.camp[ch] = val; LS.set('dmcamp_' + ch, val); renderDm(ch);
      } }));
    }
    nodes.push(chips);
  }

  if (mode === 'connect') {
    const todo = mine.filter((l) => l.status === 'ready' && inCamp(l)).sort(byTier);
    const asked = mine.filter((l) => l.status === 'requested' && inCamp(l))
      .sort((a, b) => (b.requested_ts || '').localeCompare(a.requested_ts || ''));
    const cdone = mine.filter((l) => ['skipped', 'cant_dm'].includes(l.status) && inCamp(l));
    nodes.push(segBar(CONNECT_SEGS, dm.cseg, { connect: todo.length, requested: asked.length }, (k) => { dm.cseg = k; LS.set('dmcseg', k); renderDm(ch); }));
    if (dm.cseg === 'requested') {
      nodes.push(el('p', { class: 'hint', text: 'When someone accepts, tap Accepted. They move to Message, where Claude can write the first note.' }));
      nodes.push(...(asked.length ? asked.map(requestedRow) : [el('div', { class: 'empty', text: 'No open requests.' })]));
    } else if (dm.cseg === 'cdone') {
      nodes.push(...(cdone.length ? cdone.map(connectDoneRow) : [el('div', { class: 'empty', text: 'Skips and dead links land here.' })]));
    } else {
      nodes.push(findCard(ch));
      nodes.push(el('p', { class: 'hint', text: 'Tap Open LinkedIn, send a plain request (no note), come back and tap Requested. Best leads first.' }));
      if (!todo.length) nodes.push(el('div', { class: 'empty', text: dm.loaded ? 'Nobody left to connect with. Use Find more.' : 'Loading…' }));
      todo.forEach((l, i) => nodes.push(connectCard(l, i === 0)));
    }
    root.replaceChildren(...nodes);
    return;
  }

  const ready = mine.filter((l) => l.status === 'ready' && inCamp(l)).sort(byTier);
  const needs = ready.filter((l) => l.needs_message);
  const writable = ready.filter((l) => !l.needs_message);
  const sent = mine.filter((l) => l.status === 'sent' && inCamp(l)).sort((a, b) => (b.sent_ts || '').localeCompare(a.sent_ts || ''));
  // Replies first: those are the ones that still need an answer.
  const done = mine.filter((l) => ['replied', 'skipped', 'cant_dm'].includes(l.status) && inCamp(l))
    .sort((a, b) => ((b.status === 'replied') - (a.status === 'replied'))
      || (b.updated_ts || '').localeCompare(a.updated_ts || ''));
  const replied = done.filter((l) => l.status === 'replied').length;

  nodes.push(segBar(DM_SEGS, dm.seg[ch], { send: ready.length, sent: sent.length, done: replied, saved: saved.length },
    (k) => { dm.seg[ch] = k; LS.set('dmseg_' + ch, k); renderDm(ch); }));

  const which = dm.seg[ch];
  if (which === 'send') {
    if (ch === 'x') nodes.push(findCard(ch));
    if (needs.length) nodes.push(needsCard(ch, needs));
    nodes.push(el('p', { class: 'hint', text: ch === 'x'
      ? 'Open the profile first: check the product and that their DMs are open. One DM, one gap, then the next. Stop the batch if X ever says Failed.'
      : 'Check the chat first. If an older message already went out, change the first line before you send.' }));
    if (!writable.length && !needs.length) {
      nodes.push(el('div', { class: 'empty', text: dm.loaded
        ? (ch === 'linkedin' ? 'Nothing to send. People land here when they accept your request.' : 'Nothing to send. Use Find more, or ask Claude in Cowork to load a batch.')
        : 'Loading…' }));
    }
    writable.forEach((l, i) => nodes.push(dmSendCard(l, i === 0, keepLinesOpenFor === l.id)));
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
  const tab = currentTab();
  // A hidden DM tab is drawn when it is opened (showTab), not on every refresh.
  DM_CH.forEach((ch) => {
    if (tab !== (ch === 'x' ? 'xdm' : 'linkedin')) return;
    if (typingIn(ch)) dm.pending[ch] = true; else renderDm(ch);
  });
  updateDmBadges();
}

/* -- pacing settings -- */
[['capX', 'cap_x', 20], ['capLi', 'cap_linkedin', 20], ['capConnect', 'cap_connect', 25], ['gapMin', 'gapmin', 1], ['gapMax', 'gapmax', 9]].forEach(([id, key, d]) => {
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
      el('b', { text: ({ draft: 'Drafting', scout: 'Scout', leadfind: 'Find more', dmwrite: 'Writing messages' }[j.kind] || j.kind) + ' · ' + (JOB_TEXT[j.status] || j.status) }),
      el('div', { class: 'line', text: j.error || j.report || agoText(j.ts) })),
    j.session_url ? el('a', { class: 'link', href: j.session_url, target: '_blank', rel: 'noopener', text: 'Open' }) : null))
    : [el('div', { class: 'hint', text: 'No runs yet.' })]));
}

$('liOpen').value = LS.get('li_open', 'app');
$('liOpen').addEventListener('change', () => LS.set('li_open', $('liOpen').value));

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
// Coming back from LinkedIn or X. Unchanged data costs a few 304s and no redraw.
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - state.lastRefresh > 3000) refresh(); });

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
