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

/* When the server runs on this same phone (Termux), the app talks to it at
 * 127.0.0.1 instead of through ngrok: no trip out to ngrok's servers and back
 * over mobile data, no data used at all. Checked at start and every few
 * minutes; any failure drops back to the ngrok URL from Settings. Chrome may
 * ask once to allow access to devices on the local network. */
const LOCAL_BASE = 'http://127.0.0.1:7790';
const local = { on: false, checked: 0 };
function serverBase() {
  if (local.on) return LOCAL_BASE;
  return (LS.get('server') || location.origin).replace(/\/$/, '');
}
async function checkLocal() {
  if (Date.now() - local.checked < 300000) return;
  local.checked = Date.now();
  if (!/android/i.test(navigator.userAgent) || location.hostname === '127.0.0.1' || !LS.get('password')) { local.on = false; return; }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const r = await fetch(LOCAL_BASE + '/api/health', { headers: { 'X-Sidekick-Key': LS.get('password') }, signal: ctl.signal });
    local.on = r.ok;
  } catch { local.on = false; } finally { clearTimeout(t); }
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
    // The server on this phone went away: retry once through ngrok.
    if (local.on && !e.status) { local.on = false; local.checked = Date.now(); return api(path, body, etag); }
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
/* The last copy of each list is also kept on the phone, so a cold start (the
 * phone killed the app) draws at once from it and then only asks the server
 * "changed?", which is usually a bodyless 304. */
function keepTag(path, r) {
  if (!(r && r.__etag)) return;
  shownTag.set(path, r.__etag);
  LS.set('cache_' + path, JSON.stringify({ etag: r.__etag, data: r }));
}
function applyData(path, r) {
  if (path === '/api/queue') state.items = r.items || [];
  else if (path === '/api/outreach') state.outreach = r.items || [];
  else if (path === '/api/jobs') state.jobs = r.jobs || [];
  else if (path === '/api/blocklist') state.blocked = r.items || [];
  else if (path === '/api/dm') takeDm(r);
}
function bootFromCache() {
  let any = false;
  for (const path of ['/api/queue', '/api/outreach', '/api/jobs', '/api/blocklist', '/api/dm']) {
    try {
      const c = JSON.parse(LS.get('cache_' + path, 'null'));
      if (!c || !c.etag || !c.data) continue;
      applyData(path, c.data);
      shownTag.set(path, c.etag);
      any = true;
    } catch { /* a bad cache entry is just skipped */ }
  }
  if (any) renderReplies();
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

/* Shown only on a server that syncs with another device (SIDEKICK_PEER_URL).
 * Says whether what is on screen matches the other device. */
function syncChip(p) {
  const c = $('syncChip');
  if (!p || !p.on) { c.hidden = true; return; }
  c.hidden = false;
  const waiting = p.error && p.last_ok ? ' Last synced ' + agoText(p.last_ok) + '.' : '';
  c.className = 'sync-chip ' + (p.error ? 'off' : 'ok');
  c.textContent = p.error ? 'Not synced' : p.behind ? 'Syncing ' + p.behind : 'Synced';
  c.title = p.error ? p.error + '.' + waiting + ' Your taps are kept and sent when it is back.'
    : 'Same data as your other device, checked ' + agoText(p.last_ok);
  c.onclick = () => toast(c.title, !!p.error);
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
  openSheetEl();
}
function closeSheet() { $('sheet').hidden = true; releaseBack(); }
function openSheetEl() { $('sheet').hidden = false; holdBack(); buzz(6); }

/* Android's back button closes what is open (a sheet, select mode) before it
 * leaves the app. One guard entry sits in history while anything is open; it
 * is dropped a moment after the last thing closes, so a sheet that opens
 * another sheet keeps it. */
const backGuard = { on: false, ignore: 0, timer: null };
function somethingOpen() {
  return !$('sheet').hidden || (typeof li !== 'undefined' && li.sel.on) || (typeof wsel !== 'undefined' && wsel.on);
}
function holdBack() {
  clearTimeout(backGuard.timer);
  if (backGuard.on) return;
  try { history.pushState({ sk: 1 }, ''); backGuard.on = true; } catch { /* ignore */ }
}
function releaseBack() {
  clearTimeout(backGuard.timer);
  backGuard.timer = setTimeout(() => {
    if (!backGuard.on || somethingOpen()) return;
    backGuard.on = false; backGuard.ignore++;
    history.back();
  }, 350);
}
window.addEventListener('popstate', () => {
  if (backGuard.ignore) { backGuard.ignore--; return; }
  backGuard.on = false;
  if (!$('sheet').hidden) { $('sheet').hidden = true; }
  else if (li.sel.on) { li.sel.on = false; li.sel.ids.clear(); renderDm('linkedin'); }
  else if (wsel.on) { wsel.on = false; wsel.ids.clear(); renderReplies(); }
  else return;
  if (somethingOpen()) holdBack();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });

/* Redraws keep the one-by-one card where it was on screen, so Later,
 * Previous, Up next and background refreshes never throw the page around.
 * A card whose top had scrolled out of view comes back with its top just
 * under the header. */
function visibleCard() { return [...document.querySelectorAll('.focus-card')].find((c) => c.offsetParent) || null; }
function keepCard(draw) {
  const old = visibleCard();
  const y = old ? old.getBoundingClientRect().top : null;
  draw();
  if (y == null) return;
  const card = visibleCard();
  if (!card) return;
  const head = document.querySelector('.top').getBoundingClientRect().bottom;
  const want = y < head + 4 ? head + 8 : y;
  const d = card.getBoundingClientRect().top - want;
  if (Math.abs(d) > 1) window.scrollBy(0, d);
}
const anchoring = { on: false };

/* A short tap of vibration on the actions that change something. */
function buzz(ms = 12) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* not supported */ } }

/* X counts most characters as 1 and CJK and emoji as 2, links as 23. */
function xLength(t) {
  let n = 0;
  const text = String(t || '').replace(/https?:\/\/\S+/g, (u) => { n += 23; return ''; });
  for (const ch of text) n += ch.codePointAt(0) > 0x10FF ? 2 : 1;
  return n;
}
function xCounter(ta) {
  const c = el('span', { class: 'xcount' });
  const draw = () => { const n = xLength(ta.value); c.textContent = n + '/280'; c.classList.toggle('over', n > 280); };
  ta.addEventListener('input', draw); draw();
  return c;
}
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
  // The one-by-one Replies view owns the bar on its tab (Ready segment only).
  if (name === 'replies' && typeof renderReady === 'function') renderReplies();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  // Tapping the tab you are already on takes you back to the top.
  if (currentTab() === b.dataset.tab) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  showTab(b.dataset.tab);
}));
function currentTab() { return document.querySelector('.tabbar button.on').dataset.tab; }

function showSeg(name) {
  state.seg = name;
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.seg === name));
  document.querySelectorAll('[data-segpanel]').forEach((p) => { p.hidden = p.dataset.segpanel !== name; });
  // The Posted / Skip / Retry bar belongs to the Ready post on screen only.
  if (typeof renderReady === 'function') { if (name === 'ready') renderReplies(); else setDmActions(null); }
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
  await checkLocal();
  try {
    const [h, q, o, j, b, d] = await Promise.all([api('/api/health'), apiFresh('/api/queue'), apiFresh('/api/outreach'), apiFresh('/api/jobs'),
      apiFresh('/api/blocklist').catch(() => ({ items: [] })),
      // An older server has no /api/dm: the DM tabs then say it needs a restart.
      apiFresh('/api/dm').catch((e) => ({ __error: e }))]);
    // Only what changed is taken and redrawn. On a 4GB phone, rebuilding every
    // panel on each return from LinkedIn is what made the app slow to come back.
    const ch = (r) => !r.__same;
    [['/api/queue', q], ['/api/outreach', o], ['/api/jobs', j], ['/api/blocklist', b], ['/api/dm', d]]
      .forEach(([p, r]) => { if (ch(r)) applyData(p, r); });
    [['/api/queue', q], ['/api/outreach', o], ['/api/jobs', j], ['/api/blocklist', b], ['/api/dm', d]].forEach(([p, r]) => keepTag(p, r));
    $('dot').className = 'dot ok';
    state.lastOk = Date.now(); state.offline = false; updatedText();
    $('dot').title = local.on ? 'connected directly (server on this phone)' : 'connected';
    state.acceptWatch = h.accept_watch || null;
    state.ask = h.ask !== false;   // the server can put buyer questions to ChatGPT
    if (h.sends != null) $('sendsCount').textContent = 'Replies Claude learns from: ' + h.sends
      + (h.rejects != null ? ' · rejected drafts it learns from: ' + h.rejects : '');
    syncChip(h.peer);
    const warn = [];
    // A server that syncs with another device leaves Claude's jobs to that one.
    if (!h.routine) warn.push(h.peer && h.peer.on ? 'Find more and Write with Claude run on your other device. What they produce shows up here by itself.' : 'Claude routine is not connected, so drafting is off.');
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
    state.offline = true; updatedText();
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

/* What the post shows besides its text: pictures, a video, a quoted post. The
 * server looks these up; without them a take on "the layout" is a guess. */
function postExtras(it) {
  const nodes = [];
  if (it.quote && it.quote.text) {
    nodes.push(el('div', { class: 'quote' },
      el('b', { text: it.quote.author ? '@' + it.quote.author : 'Quoted post' }),
      el('div', { text: it.quote.text })));
  }
  const media = Array.isArray(it.media) ? it.media : [];
  if (media.length) {
    nodes.push(el('div', { class: 'media' + (media.length === 1 ? ' one' : '') }, ...media.map((m) => {
      const isVid = m.type !== 'photo';
      const a = el('a', { class: 'media-item' + (isVid ? ' vid' : ''), href: isVid ? (postUrl(it) || m.url) : m.url, target: '_blank', rel: 'noopener' },
        el('img', { src: m.thumb || m.url, loading: 'lazy', alt: isVid ? 'Video in the post' : 'Image in the post', referrerpolicy: 'no-referrer' }));
      return a;
    })));
  }
  return nodes;
}

/* His take on the post, before Claude drafts. This is the part no voice file
 * can supply: what he actually thinks. Saved as he types (or speaks). */
function takeBox(it) {
  const box = el('textarea', { class: 'take-box', rows: 2,
    placeholder: 'What do you think of this post? A few words is enough: "boring", "how does he get traffic?", "tried it, slow"' });
  box.value = it.take || '';
  let timer;
  const mark = el('span', { class: 'take-state muted', text: it.take ? 'Saved' : '' });
  const save = async () => {
    const v = box.value.trim();
    if (v === (it.take || '')) return;
    try { await api('/api/queue/update', { id: it.id, take: v }); it.take = v; mark.textContent = v ? 'Saved' : ''; updateDraftAll(); }
    catch (e) { mark.textContent = 'Not saved'; }
  };
  box.addEventListener('input', () => { mark.textContent = '…'; clearTimeout(timer); timer = setTimeout(save, 900); });
  box.addEventListener('blur', () => { clearTimeout(timer); save(); });
  const row = el('div', { class: 'take-row' }, el('label', { class: 'sent-label', text: 'Your take' }), el('span', { class: 'spacer' }), mark);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    let rec = null;
    const mic = el('button', { class: 'btn sm', text: '🎤 Speak', title: 'Say your take out loud', onclick: () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = 'en-IN'; rec.interimResults = false; rec.continuous = false;
      mic.textContent = '■ Stop'; mic.classList.add('on');
      rec.onresult = (ev) => {
        const said = Array.from(ev.results).map((r) => r[0].transcript).join(' ').trim();
        if (said) { box.value = (box.value.trim() ? box.value.trim() + ' ' : '') + said; save(); }
      };
      rec.onerror = (ev) => { if (ev.error !== 'no-speech' && ev.error !== 'aborted') toast('Mic: ' + ev.error, true); };
      rec.onend = () => { rec = null; mic.textContent = '🎤 Speak'; mic.classList.remove('on'); };
      try { rec.start(); } catch (e) { rec = null; mic.textContent = '🎤 Speak'; mic.classList.remove('on'); }
    } });
    row.append(mic);
  }
  return el('div', { class: 'take' }, row, box);
}

function updateDraftAll() {
  const waiting = state.items.filter((i) => i.status === 'queued');
  const withTake = waiting.filter((i) => (i.take || '').trim()).length;
  $('draftAllBtn').textContent = waiting.length
    ? 'Draft all ' + waiting.length + ' with Claude' + (withTake ? ' · ' + withTake + ' with your take' : '')
    : 'Nothing waiting';
}

/* For a reply someone left for him: what it was answering. */
function contextBlock(it) {
  const c = it.context;
  if (!c || !c.text) return [];
  return [el('div', { class: 'quote ctx' },
    el('b', { text: c.mine ? 'You said' : '@' + handleOf(c.author) + ' said' }),
    el('div', { text: c.text }))];
}
/* When the post went up: X ids carry their own timestamp, so this is the
 * post's age, not when it reached the queue. */
function postTime(it) {
  try { if (/^\d{15,}$/.test(String(it.tweet_id || ''))) return Number(BigInt(it.tweet_id) >> 22n) + 1288834974657; } catch { /* old browser */ }
  return tsMs(it.ts);
}
function postAge(it) { return ago(new Date(postTime(it)).toISOString()); }
const OLD_HOURS = 12;
function isOld(it) { return Date.now() - postTime(it) > OLD_HOURS * 3600e3; }
function mentionTag(it) {
  const tags = [];
  // Past about 12 hours a reply is rarely seen: flag it so it goes first or gets skipped.
  if (it.status === 'drafted' && it.source !== 'mention' && isOld(it)) tags.push(el('span', { class: 'tag old', title: 'Replies this late are rarely seen', text: 'Old · ' + postAge(it) }));
  if (it.source === 'mention') tags.push(el('span', { class: 'tag', text: 'Replied to you' }));
  if (it.post_type) tags.push(el('span', { class: 'tag', title: 'The kind of post Claude took this to be', text: it.post_type.replace(/-/g, ' ') }));
  return tags.length ? [el('div', { class: 'tag-row' }, ...tags)] : [];
}

function itemMenu(it) {
  const h = handleOf(it.author);
  const actions = [];
  if (postUrl(it)) actions.push({ label: 'Open post on X', run: () => window.open(postUrl(it), '_blank', 'noopener') });
  if (it.status === 'queued') actions.push({ label: 'Draft just this one', run: () => askDraft([it.id]) });
  if (it.status === 'drafted') actions.push({ label: '↻ Retry with Claude', run: () => retryDraft(it) });
  if (it.status === 'queued' || it.status === 'drafted') actions.push({ label: 'Skip', run: () => setStatus(it, 'skipped') });
  if (it.status === 'posted' || it.status === 'skipped') actions.push({ label: 'Move back to waiting', run: () => setStatus(it, 'queued') });
  if (h) actions.push({ label: 'Block @' + h, danger: true, run: () => blockUser(h) });
  sheet(h ? '@' + h : 'Post', actions);
}

function voiceLabel(angle) {
  const first = String(angle || '').split(/\s[·\-–|]\s/)[0].trim();
  return first && first.length <= 24 ? first : 'Draft';
}

/* The draft he tapped Reply (or Copy) on, per post. Stored, not in memory: the
 * phone often kills the app behind X, and every refresh rebuilds the card, so
 * an in-memory pick was gone by the time he came back. Cleared when the post
 * is finished; stale ones are dropped on render. */
function getPick(id) { try { return JSON.parse(LS.get('pick_' + id, 'null')); } catch { return null; } }
function setPick(id, idx, text) { LS.set('pick_' + id, JSON.stringify({ idx, text })); }
/* Drafts he edited in place, per post: {index: text}. His wording, so it is
 * what Copy and Reply use and what gets recorded as hand-written. */
function getEdits(id) { try { return JSON.parse(LS.get('dedit_' + id, '{}')) || {}; } catch { return {}; } }
function setEdit(id, idx, text) { const e = getEdits(id); e[idx] = text; LS.set('dedit_' + id, JSON.stringify(e)); }
function clearPick(id) { try { localStorage.removeItem('sk_pick_' + id); localStorage.removeItem('sk_dedit_' + id); } catch { /* ignore */ } }
function prunePicks(liveIds) {
  try {
    Object.keys(localStorage).forEach((k) => {
      const m = k.match(/^sk_(pick|dedit)_(.+)$/);
      if (m && !liveIds.has(m[2])) localStorage.removeItem(k);
    });
  } catch { /* ignore */ }
}

/* Retry with Claude: the current drafts are thrown away (kept as rejected
 * examples with his note as the reason) and the post is redrafted. */
function retryDraft(it) {
  const box = el('textarea', { class: 'tell-box', rows: 3, placeholder: 'What was wrong? (optional) e.g. "too long, and ask them something"' });
  sheetCustom('Redraft @' + handleOf(it.author) + ' with Claude', [
    el('div', { class: 'sheet-note', text: 'These drafts are dropped and saved as examples of what not to write.' }),
    box,
    el('button', { class: 'primary', text: '↻ Redraft with Claude', onclick: async (e) => {
      e.target.disabled = true;
      try {
        const r = await api('/api/draft/retry', { id: it.id, note: box.value.trim(), account: LS.get('account', 'abhiijayVinayak') });
        closeSheet();
        clearPick(it.id);
        toast(r.job && r.job.status === 'failed' ? (r.job.error || 'Claude run failed') : 'Claude is redrafting. It comes back here in a few minutes.', r.job && r.job.status === 'failed');
      } catch (err) { closeSheet(); toast(err.message, true); }
      refresh();
    } })]);
  setTimeout(() => box.focus(), 50);
}

/* One post with its drafts. opts.focus: the one-at-a-time view, where Posted,
 * Skip and Retry live in the bottom bar (returned as `actions`) instead of
 * the card's foot. */
function draftCard(it, opts = {}) {
  const card = el('div', { class: 'card' + (opts.focus ? ' focus-card' : '') },
    whoRow(it.author, 'posted ' + postAge(it) + ' ago' + (it.author_followers ? ' · ' + num(it.author_followers) + ' followers' : ''), () => itemMenu(it)),
    ...mentionTag(it), ...contextBlock(it), postBlock(postText(it), 'post open'), ...postExtras(it));
  // The take the drafts were written from. If he has changed it since, Retry uses the new one.
  const usedTake = it.take_used || it.take;
  if (usedTake) card.append(el('div', { class: 'take-used' }, el('b', { text: 'Your take: ' }), el('span', { text: usedTake })));
  if (it.agent_note) card.append(el('div', { class: 'flag' }, el('b', { text: '!' }), el('span', { text: it.agent_note })));

  let chosen = typeof it.chosen_index === 'number' ? it.chosen_index : null;
  const sent = el('textarea', { rows: 2, placeholder: 'What you actually sent (teaches Claude your voice)' });
  const edits = getEdits(it.id);
  const textOf = (idx) => (typeof edits[idx] === 'string' ? edits[idx] : (it.drafts[idx] || {}).text);
  const saved = getPick(it.id);
  const savedOk = saved && it.drafts && it.drafts[saved.idx] && textOf(saved.idx) === saved.text;
  if (savedOk) chosen = saved.idx;
  if (it.posted_text) { sent.value = it.posted_text; sent.dataset.dirty = '1'; }
  else if (savedOk) sent.value = saved.text;
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
    el('div', { class: 'take-row' }, el('label', { class: 'sent-label', text: 'What you actually sent' }), el('span', { class: 'spacer' }), xCounter(sent)), sent);

  const drafts = el('div', { class: 'drafts' });
  (it.drafts || []).forEach((d, idx) => {
    // Why this reply, and the real reply of this post type it was modeled on.
    const angle = el('div', { class: 'angle' }, el('div', { text: d.angle || '' }),
      d.modeled_on ? el('div', { class: 'modeled', text: 'Modeled on ' + d.modeled_on }) : null);
    angle.hidden = true;
    const edited = typeof edits[idx] === 'string';
    const txt = el('div', { class: 'draft-text', text: textOf(idx) });
    const box = el('div', { class: 'draft' + (chosen === idx ? ' chosen' : '') + (edited ? ' edited' : '') }, txt);
    const pick = () => {
      chosen = idx;
      const t = textOf(idx);
      setPick(it.id, idx, t);
      drafts.querySelectorAll('.draft').forEach((n, k) => n.classList.toggle('chosen', k === idx));
      if (typeof edits[idx] === 'string') {
        // His own wording: recorded as hand-written, the strongest voice signal.
        sent.value = t; sent.dataset.dirty = '1'; saveSent(true);
      } else if (!sent.dataset.dirty) sent.value = t;
    };
    const edit = () => {
      const ta = el('textarea', { class: 'draft-edit', rows: 3 });
      ta.value = textOf(idx);
      const count = xCounter(ta);
      const done = () => {
        const v = ta.value.trim();
        if (v && v !== d.text) { edits[idx] = v; setEdit(it.id, idx, v); box.classList.add('edited'); }
        txt.textContent = textOf(idx);
        count.remove();
        ta.replaceWith(txt);
        pick();
      };
      ta.addEventListener('blur', done);
      txt.replaceWith(ta);
      ta.after(count);
      ta.focus();
    };
    box.append(el('div', { class: 'draft-foot' },
      el('button', { class: 'voice', text: voiceLabel(d.angle), title: 'Why this reply', onclick: () => { angle.hidden = !angle.hidden; } }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn sm bad', text: '✕ Reject', title: 'Bad reply - drop it and record why',
        onclick: () => rejectDraft(it, idx, d) }),
      el('button', { class: 'btn sm', text: 'Edit', onclick: edit }),
      el('button', { class: 'btn sm', text: 'Copy', onclick: async () => { pick(); toast((await copy(textOf(idx))) ? 'Copied' : 'Copy failed', false); } }),
      el('button', { class: 'btn sm primary', text: 'Reply', onclick: async () => {
        pick();
        const ok = await copy(textOf(idx));
        toast(ok ? 'Copied. Paste it on X.' : 'Copy failed. Long-press the text.', !ok);
        if (postUrl(it)) window.open(postUrl(it), '_blank', 'noopener');
      } })), angle);
    drafts.append(box);
  });
  card.append(drafts);

  const posted = (e) => {
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
  };
  card.append(sentWrap);
  card.onPosted = posted;
  card.onSkip = () => setStatus(it, 'skipped');
  if (opts.focus) {
    card.actions = [
      el('button', { class: 'btn ok-solid grow', text: '✓ Posted', onclick: posted }),
      el('button', { class: 'btn', text: 'Skip', onclick: () => setStatus(it, 'skipped') }),
      el('button', { class: 'btn', text: '↻ Retry', title: 'Redraft with Claude', onclick: () => retryDraft(it) }),
      el('button', { class: 'btn icon', text: '⋯', onclick: () => itemMenu(it) }),
    ];
    return card;
  }
  card.append(el('div', { class: 'card-foot' },
    el('button', { class: 'btn primary', text: 'Posted', onclick: posted }),
    el('button', { class: 'btn', text: '↻ Retry with Claude', onclick: () => retryDraft(it) }),
    el('button', { class: 'btn', text: 'Save now', onclick: async (e) => {
      const done = busy(e.target, '…');
      sent.dataset.dirty = '1';
      await saveSent(false);
      done();
    } })));
  return card;
}

/* Swipe a focus card: right for Posted, left for Skip. Only a clear sideways
 * drag counts, and never one that starts in a text box, so scrolling and
 * editing work as before. */
function attachSwipe(card, onRight, onLeft) {
  let x0 = 0, y0 = 0, dx = 0, mode = '';
  card.addEventListener('touchstart', (e) => {
    mode = /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName) ? 'off' : '';
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0;
  }, { passive: true });
  card.addEventListener('touchmove', (e) => {
    if (mode === 'off' || mode === 'v') return;
    const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
    if (!mode) {
      if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { mode = 'v'; return; }
      if (Math.abs(mx) > 14 && Math.abs(mx) > Math.abs(my) * 1.6) mode = 'h'; else return;
    }
    e.preventDefault();
    dx = mx;
    card.style.transition = 'none';
    card.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 40) + 'deg)';
    const zone = dx > 90 ? 'right' : dx < -90 ? 'left' : '';
    if (zone && card.dataset.swipe !== zone) buzz(8);   // a tick when it would trigger
    card.dataset.swipe = zone;
  }, { passive: false });
  card.addEventListener('touchend', () => {
    if (mode !== 'h') return;
    const go = dx > 90 ? onRight : dx < -90 ? onLeft : null;
    if (go) buzz(15);
    card.style.transition = 'transform .2s ease';
    card.style.transform = go ? 'translateX(' + (dx > 0 ? 120 : -120) + '%)' : '';
    card.dataset.swipe = '';
    if (go) setTimeout(() => { card.style.transform = ''; go(); }, 180);
    mode = '';
  });
}

/* Batch fix: when a whole batch went wrong (wrong prompt, AI language, false
 * facts), one note redoes all of it and stays as a rule for every later run. */
function batchFixSheet(title, note, placeholder, go, label) {
  const box = el('textarea', { class: 'tell-box', rows: 4, placeholder });
  sheetCustom(title, [
    el('div', { class: 'sheet-note', text: note }), box,
    el('button', { class: 'primary', text: label, onclick: async (e) => {
      const text = box.value.trim();
      if (!text) { toast('Say what is wrong with the batch', true); box.focus(); return; }
      e.target.disabled = true;
      try { await go(text); } catch (err) { toast(err.message + '. Your note is saved as a rule.', true); }
      closeSheet();
      refresh();
    } })]);
  setTimeout(() => box.focus(), 50);
}
function redoAllReplies(ready) {
  batchFixSheet('Redo all ' + ready.length + ' replies with Claude',
    'Every draft on Ready is dropped and rewritten. Your note becomes a rule for every reply Claude writes from now on.',
    'What is wrong with this batch? e.g. "Reads like AI, did not use the voice profiles. Shorter, no em dashes."',
    async (note) => {
      const r = await api('/api/draft/retry-all', { note, account: LS.get('account', 'abhiijayVinayak') });
      toast(r.job && r.job.status === 'failed' ? (r.job.error || 'Claude run failed') + '. Your note is saved.'
        : 'Claude is redrafting ' + r.redone + '. They come back to Ready in a few minutes.', r.job && r.job.status === 'failed');
    }, '↻ Redo all ' + ready.length);
}
function fixAllMessages(n) {
  const camp = dm.camp.linkedin || '';
  batchFixSheet('Fix all ' + n + ' messages with Claude',
    'Every written message in To send' + (camp ? ' (this campaign)' : '') + ' is rewritten with your note. The note becomes a rule for every message Claude writes from now on.',
    'What is wrong? e.g. "Says we worked with brands we never did. Remove that, and no AI phrases like \'I came across\'."',
    async (text) => {
      const r = await api('/api/dm/feedback-all', { text, channel: 'linkedin', campaign: camp || null });
      toast('Claude is rewriting ' + r.fixing + '. They come back to To send in a few minutes.');
    }, '✎ Rewrite all ' + n);
}

/* -- Ready: one post at a time, like the LinkedIn lists -- */
const rp = { view: LS.get('rp_view', 'focus'), focus: LS.get('rp_focus', '') || null, idx: 0, type: LS.get('rp_type', '') };
function typeName(t) { return t === 'other' ? 'No type' : t.replace(/-/g, ' '); }
function renderReady(allReady, emptyText) {
  const box = $('readyList');
  if (!allReady.length) {
    const today = localStamp().slice(0, 10);
    const postedToday = state.items.filter((i) => i.status === 'posted' && String(i.posted_ts || '').startsWith(today)).length;
    const waiting = state.items.filter((i) => i.status === 'queued').length;
    const drafting = /few minutes/.test(emptyText);
    box.replaceChildren(el('div', { class: 'caught-up' },
      el('div', { class: 'cu-title', text: drafting ? 'Claude is drafting' : postedToday ? 'All caught up' : 'Nothing to post yet' }),
      el('div', { class: 'muted', text: drafting ? emptyText : (postedToday ? postedToday + ' posted today. ' : '') + (waiting ? waiting + ' posts are waiting for a take.' : 'Find new posts to reply to.') }),
      el('div', { class: 'cu-actions' },
        waiting ? el('button', { class: 'btn primary', text: 'Open Waiting (' + waiting + ')', onclick: () => showSeg('waiting') }) : null,
        el('button', { class: 'btn', text: 'Find posts', onclick: () => showTab('scout') }))));
    setDmActions(null);
    return;
  }
  // Post-type filter, for when Ready is long.
  const types = {};
  allReady.forEach((i) => { const t = i.post_type || 'other'; types[t] = (types[t] || 0) + 1; });
  if (rp.type && !types[rp.type]) { rp.type = ''; LS.set('rp_type', ''); }
  const ready = rp.type ? allReady.filter((i) => (i.post_type || 'other') === rp.type) : allReady;
  const setType = (t) => { rp.type = t; LS.set('rp_type', t); rp.idx = 0; rp.focus = null; renderReplies(); window.scrollTo(0, 0); };
  const typeChip = Object.keys(types).length > 1 ? el('button', { class: 'pill-chip' + (rp.type ? ' accent' : ''),
    text: (rp.type ? typeName(rp.type) : 'All types') + ' ▾', onclick: () => sheet('Show', [
      { label: 'All types (' + allReady.length + ')', run: () => setType('') },
      ...Object.entries(types).sort((a, b) => b[1] - a[1]).map(([t, n]) => ({ label: typeName(t) + ' (' + n + ')', run: () => setType(t) })),
    ]) }) : null;
  const toggle = el('div', { class: 'view-row' }, el('div', { class: 'mini-seg' },
    ...[['focus', 'One by one'], ['list', 'List (' + ready.length + ')']].map(([v, label]) =>
      el('button', { class: rp.view === v ? 'on' : '', text: label, onclick: () => {
        rp.view = v; LS.set('rp_view', v); renderReplies(); window.scrollTo(0, 0); } }))),
    el('span', { class: 'spacer' }), typeChip,
    el('button', { class: 'pill-chip', text: '↻ Redo all', title: 'The whole batch is wrong: redraft all with a note', onclick: () => redoAllReplies(allReady) }));
  if (rp.view === 'list') { box.replaceChildren(toggle, ...ready.map((it) => draftCard(it))); setDmActions(null); return; }
  let i = ready.findIndex((it) => it.id === rp.focus);
  if (i < 0) i = Math.min(rp.idx, ready.length - 1);
  const it = ready[i];
  rp.focus = it.id; rp.idx = i; LS.set('rp_focus', it.id);
  const go = (k) => { rp.focus = ready[k].id; renderReplies(); };
  const card = draftCard(it, { focus: true });
  card.prepend(el('div', { class: 'focus-top' }, el('span', { class: 'focus-count', text: (i + 1) + ' of ' + ready.length }),
    stepArrows(i, ready.length, (k) => go(k))));
  attachSwipe(card, () => card.onPosted({ target: el('button') }), card.onSkip);
  card.append(el('div', { class: 'focus-nav' },
    el('button', { class: 'link', text: '‹ Previous', disabled: i === 0, onclick: () => go(i - 1) }),
    el('button', { class: 'link', text: 'Later ›', title: 'Leave this one for later and show the next', onclick: () => go((i + 1) % ready.length) })),
    el('div', { class: 'swipe-tip', text: 'Swipe right: Posted · Swipe left: Skip' }));
  const next = ready.slice(i + 1, i + 4);
  const up = next.length ? el('div', { class: 'up-next' }, el('div', { class: 'tier-head', text: 'Up next' }),
    ...next.map((n) => el('button', { class: 'next-row', onclick: () => go(ready.indexOf(n)) },
      el('b', { text: '@' + handleOf(n.author) }), el('span', { class: 'muted', text: ' ' + postText(n).slice(0, 60) })))) : null;
  box.replaceChildren(toggle, card, ...(up ? [up] : []));
  setDmActions(state.seg === 'ready' ? card.actions : null);
}

/* Picking several waiting posts to remove at once. Removed posts go to Done as
 * skipped, so "Move back to waiting" still brings one back. */
const wsel = { on: false, ids: new Set() };
function skippedByClaude(it) { return /^skipped\b/i.test(it.agent_note || ''); }
function waitingBar(waiting) {
  if (!waiting.length) return [];
  if (!wsel.on) {
    return [el('div', { class: 'view-row' }, el('span', { class: 'spacer' }),
      el('button', { class: 'pill-chip', text: 'Select', onclick: () => { wsel.on = true; wsel.ids.clear(); holdBack(); renderReplies(); } }))];
  }
  const live = new Set(waiting.map((i) => i.id));
  [...wsel.ids].forEach((id) => { if (!live.has(id)) wsel.ids.delete(id); });
  const n = wsel.ids.size;
  const all = n === waiting.length;
  const flagged = waiting.filter(skippedByClaude);
  const pick = (list) => { wsel.ids = new Set(list.map((i) => i.id)); renderReplies(); };
  return [el('div', { class: 'view-row sel-bar' },
    el('button', { class: 'pill-chip', text: all ? 'Select none' : 'Select all', onclick: () => pick(all ? [] : waiting) }),
    flagged.length ? el('button', { class: 'pill-chip', text: 'Ones Claude skipped (' + flagged.length + ')', onclick: () => pick(flagged) }) : null,
    el('span', { class: 'spacer' }),
    el('button', { class: 'pill-chip', text: 'Cancel', onclick: () => { wsel.on = false; wsel.ids.clear(); releaseBack(); renderReplies(); } }),
    el('button', { class: 'pill-chip warn', text: n ? 'Remove ' + n : 'Remove', disabled: !n, onclick: (e) => removeSelected(e.target) }))];
}
async function removeSelected(btn) {
  const ids = [...wsel.ids];
  if (!ids.length) return;
  const done = busy(btn, 'Removing…');
  let ok = 0;
  try {
    // One at a time: each update rewrites the queue file.
    for (const id of ids) { await api('/api/queue/update', { id, status: 'skipped' }); wsel.ids.delete(id); ok++; }
    toast('Removed ' + ok + '. They are in Done if you want one back.');
    wsel.on = false;
  } catch (e) { toast((ok ? 'Removed ' + ok + ', then stopped: ' : '') + e.message, true); }
  done();
  await refresh();
}

function waitingCard(it) {
  if (wsel.on) {
    const on = wsel.ids.has(it.id);
    const card = el('div', { class: 'card pickable' + (on ? ' picked' : ''), role: 'checkbox', 'aria-checked': String(on),
      onclick: () => { if (wsel.ids.has(it.id)) wsel.ids.delete(it.id); else wsel.ids.add(it.id); renderReplies(); } },
      el('div', { class: 'who' }, el('span', { class: 'pick-box', text: on ? '✓' : '' }),
        el('div', { class: 'who-name' }, el('b', { text: it.author ? '@' + handleOf(it.author) : 'post' }), el('span', { text: ago(it.ts) }))),
      el('div', { class: 'post', text: postText(it) || 'Text not fetched yet.' }));
    if (it.agent_note) card.append(el('div', { class: 'flag' }, el('b', { text: '!' }), el('span', { text: it.agent_note })));
    return card;
  }
  const card = el('div', { class: 'card' },
    // Only while that run is really going: a failed run used to leave this label on forever.
    whoRow(it.author, it.drafting_job && activeJobs('draft').some((j) => j.id === it.drafting_job) ? 'Claude is drafting…' : ago(it.ts), () => itemMenu(it)),
    // The whole post, never a preview: he is giving his opinion on it here.
    ...mentionTag(it), ...contextBlock(it), postBlock(postText(it), 'post open'), ...postExtras(it));
  if (postUrl(it)) card.append(el('a', { class: 'link open-x', href: postUrl(it), target: '_blank', rel: 'noopener', text: 'Open on X' }));
  if (it.retry_note) card.append(el('div', { class: 'flag' }, el('b', { text: '↻' }), el('span', { text: 'Redo: ' + it.retry_note })));
  if (it.agent_note) card.append(el('div', { class: 'flag' }, el('b', { text: '!' }), el('span', { text: it.agent_note })));
  // Always there: a take added while Claude is drafting still counts for a Retry.
  card.append(takeBox(it));
  return card;
}

const doneOpen = new Set();
function doneRow(it) {
  const open = doneOpen.has(it.id);
  const row = el('div', { class: 'row-card done-row' + (open ? ' open' : '') }, avatar(it.author),
    el('button', { class: 'row-main', onclick: () => { if (doneOpen.has(it.id)) doneOpen.delete(it.id); else doneOpen.add(it.id); renderDone(); } },
      el('span', { class: 'row-text' },
        el('b', {}, '@' + handleOf(it.author) + ' ', el('span', { class: 'status-pill ' + it.status, text: it.status === 'posted' ? 'Posted' : 'Skipped' })),
        el('span', { class: 'line', text: it.posted_text || postText(it) }))),
    el('button', { class: 'more-btn', text: '⋯', onclick: () => itemMenu(it) }));
  if (!open) return row;
  const box = el('div', { class: 'done-detail' },
    el('div', { class: 'sent-label', text: 'Their post' }), el('div', { class: 'post open', text: postText(it) || '(no text)' }));
  if (it.posted_text) box.append(el('div', { class: 'sent-label', text: 'You posted' }), el('div', { class: 'post open mine', text: it.posted_text }));
  if (postUrl(it)) box.append(el('a', { class: 'link open-x', href: postUrl(it), target: '_blank', rel: 'noopener', text: 'Open on X' }));
  return el('div', {}, row, box);
}
const doneQ = { q: '' };
function dayLabel(ts) {
  const d = String(ts || '').slice(0, 10);
  if (!d) return 'Earlier';
  if (d === localStamp().slice(0, 10)) return 'Today';
  if (d === localStamp(new Date(Date.now() - 86400000)).slice(0, 10)) return 'Yesterday';
  return new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
function renderDone() {
  const box = $('doneList');
  const all = state.items.filter((i) => i.status === 'posted' || i.status === 'skipped')
    .sort((a, b) => String(b.posted_ts || b.mod || b.ts).localeCompare(String(a.posted_ts || a.mod || a.ts))).slice(0, 80);
  const q = doneQ.q.trim().toLowerCase();
  const list = q ? all.filter((i) => [i.author, i.posted_text, postText(i)].some((x) => String(x || '').toLowerCase().includes(q))) : all;
  const posted = all.filter((i) => i.status === 'posted').length;
  let inp = box.querySelector('input.search');
  const keep = inp && document.activeElement === inp;
  if (!inp) {
    inp = el('input', { class: 'search', type: 'search', placeholder: 'Search a name or what you posted' });
    inp.addEventListener('input', () => { doneQ.q = inp.value; clearTimeout(doneQ.t); doneQ.t = setTimeout(renderDone, 150); });
  }
  inp.value = doneQ.q;
  const nodes = [inp, el('div', { class: 'small muted done-sum', text: posted + ' posted · ' + (all.length - posted) + ' skipped' })];
  let last = '';
  for (const it of list) {
    const day = dayLabel(it.posted_ts || it.mod || it.ts);
    if (day !== last) { nodes.push(el('div', { class: 'tier-head', text: day })); last = day; }
    nodes.push(doneRow(it));
  }
  if (!list.length) nodes.push(el('div', { class: 'empty', text: q ? 'No match.' : 'Nothing here yet.' }));
  box.replaceChildren(...nodes);
  if (keep) inp.focus();
}

function renderReplies() {
  if (!anchoring.on) { anchoring.on = true; try { keepCard(() => renderReplies()); } finally { anchoring.on = false; } return; }
  state.repliesStale = false;
  if (backGuard.on && !somethingOpen()) releaseBack();
  // Freshest post first: a reply is worth most in the first hours.
  const ready = state.items.filter((i) => i.status === 'drafted').sort((a, b) => postTime(b) - postTime(a));
  prunePicks(new Set(ready.map((i) => i.id)));
  const waiting = state.items.filter((i) => i.status === 'queued');
  const done = state.items.filter((i) => i.status === 'posted' || i.status === 'skipped').slice(0, 40);
  // Drawn on boot from the phone's cache too, before the goal settings below exist.
  try { $('replyStrip').replaceChildren(...replyStrip()); } catch { /* next render draws it */ }
  $('readyCount').textContent = ready.length || '';
  $('waitingCount').textContent = waiting.length || '';
  $('navBadge').textContent = ready.length || '';
  $('draftAllBtn').disabled = !waiting.length || activeJobs('draft').length > 0;
  updateDraftAll();

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
  renderReady(ready, job && ACTIVE.includes(job.status) ? 'Drafts will show up here in a few minutes.' : 'No drafts yet. Share a post from X, or run Scout.');
  if (!waiting.length) { wsel.on = false; wsel.ids.clear(); }
  fill('waitingList', waiting, waitingCard, 'Nothing waiting.');
  $('waitingList').prepend(...waitingBar(waiting).filter(Boolean));
  void done;
  renderDone();
}

async function finish(it, status, postedText, chosen, btn, verbatim) {
  const done = busy(btn, '…');
  try {
    clearPick(it.id);
    const body = { id: it.id, status };
    if (typeof postedText === 'string') body.posted_text = postedText;
    if (typeof chosen === 'number') body.chosen_index = chosen;
    if (typeof verbatim === 'boolean') body.sent_verbatim = verbatim;
    await api('/api/queue/update', body);
    buzz(status === 'posted' ? 25 : 12);
    toast(status === 'posted' ? 'Nice. Marked posted.' : 'Skipped');
    await refresh();
  } catch (e) { toast(e.message, true); done(); }
}

async function setStatus(it, status) {
  try { await api('/api/queue/update', { id: it.id, status }); buzz(); await refresh(); } catch (e) { toast(e.message, true); }
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
/* Replies people left for him that he has not answered. They join Waiting like
 * any other post, marked so he can see what they were answering. */
$('mentionsBtn').addEventListener('click', async (e) => {
  const done = busy(e.target, 'Checking…');
  try {
    const r = await api('/api/mentions/check', {});
    const sk = r.skipped || {};
    toast(r.added ? r.added + ' new ' + (r.added === 1 ? 'reply' : 'replies') + ' to you added to Waiting'
      : 'Nothing new. ' + (sk.answered || 0) + ' already answered, ' + (sk.old || 0) + ' older than a week.');
    await refresh();
  } catch (err) { toast(err.message, true); }
  done();
});
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
  $('scoutStatus').textContent = job && job.error
    ? (run && run.unranked ? 'Not ranked by Claude, showing the top ' + (run.candidates || []).length + '. ' : 'Failed: ') + job.error
    : bits.join(' · ');

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
  dm.versions = d.versions || {};
  dm.templates = d.templates || {};
  // A buyer never shows the Non-ICP notes (Try it, Your take, Can I): those
  // wait aside, and the card asks for the research the buyer messages need.
  for (const l of dm.leads) {
    if (['light', 'watch'].includes(l.icp) || l.status !== 'ready' || !(l.variants && l.variants.length)) continue;
    const rows = ((dm.templates || {})[l.campaign] || {}).light || [];
    const light = new Set(rows.length ? rows.map((r) => r.label) : ['Try it', 'Your take', 'Can I']);
    if (l.variants.every((v) => light.has(v.label))) { l.light_variants = l.variants; l.variants = []; l.needs_report = true; delete l.draft_text; }
  }
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
  if (mode === 'connect' && s.connect_pause_until && s.connect_pause_until * 1000 > now) {
    return { cls: 'err', text: 'Weekly limit · paused until ' + dayName(s.connect_pause_until * 1000), paused: true };
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
  if (p.paused) return { title: "You hit LinkedIn's weekly invitation limit. Requests sent now usually fail, and pushing it can get the account restricted.", go: 'Open anyway' };
  // Connect requests past the cap open straight away: the pill already says the cap is reached.
  if (p.capped) return mode === 'connect' ? null : { title: "That's your daily cap. More today raises the spam risk.", go: 'Send anyway' };
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
    const nx = document.querySelector('#dm-' + ch + ' .li-next');
    if (nx) {
      const w = paceState(ch, 'message').wait;
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
    buzz(status === 'sent' || status === 'requested' ? 25 : 12);
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
    l.variant_index = pickVariant(l);
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
  if (['ready', 'sent'].includes(l.status)) {
    acts.push(snoozed(l) ? { label: 'Wake up (snoozed until ' + l.snooze_until + ')', run: () => snoozeLeads([l], '') }
      : { label: '💤 Snooze…', run: () => snoozeSheet([l]) });
  }
  if (canResearch(l) && !l.writing_job) acts.push({ label: '🔎 Research + write message', run: () => researchLeads([l]) });
  if (l.channel === 'linkedin' && isIcp(l) && pdfPending(l)) {
    acts.push(l.report_requested ? { label: 'Cancel the PDF request', run: () => requestPdf([l], false) } : { label: '📄 Make the PDF', run: () => requestPdf([l]) });
  }
  if (l.channel === 'linkedin' && kindOf(l) === 'message' && ['ready', 'sent'].includes(l.status)) {
    acts.push(isIcp(l) ? { label: 'Move to Non-ICP', run: () => setIcp([l], 'light') }
      : { label: 'Move to ICP (a real buyer)', run: () => setIcp([l], 'founder') });
  }
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
    acts.push({ label: 'LinkedIn says weekly limit reached', run: () => weeklyLimitSheet(paceState('linkedin', 'connect').paused) });
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
  q: '', showNeeds: false, aud: LS.get('li_aud', 'icp'),
  filt: { connect: LS.get('li_filt_connect', 'all'), message: LS.get('li_filt_message', 'all') },
  sel: { on: false, ids: new Set() },
};
const TIER_GROUPS = [['Contact this week', 0], ['Next batch', 1], ['Later', 2], ['No tier', 3]];
function tierRank(t) { return TIER_RANK[t] ?? 3; }

function setDmActions(nodes) {
  const bar = $('dmActions');
  const show = nodes && nodes.length && ['linkedin', 'replies'].includes(currentTab());
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
  openSheetEl();
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

function openFindSheet(which) {
  const ch = typeof which === 'string' ? which : 'linkedin';
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
    go.textContent = 'Find ' + want + (ch === 'x' ? ' leads' : ' people');
  };
  other.addEventListener('input', () => {
    const v = parseInt(other.value, 10);
    if (Number.isFinite(v) && v > 0) { want = Math.min(v, 100); draw(); }
  });
  draw();
  const status = findStatusText(ch);
  // A finished run that found people but added none (Claude's check failed or
  // was too strict): they can still be added as they are.
  const fr = dm.find && dm.find.run;
  const fj = dm.find && dm.find.job;
  const unchecked = fr && fr.channel === ch && fj && !ACTIVE.includes(fj.status) && !fr.added_count && fr.candidate_count
    ? el('button', { text: 'Add the top ' + Math.min(fr.want, fr.candidate_count) + " without Claude's check", onclick: async () => {
      closeSheet();
      try { const r = await api('/api/leads/find/add-unchecked', { job_id: fr.job_id }); toast('Added ' + r.added); await refresh(); } catch (err) { toast(err.message, true); }
    } }) : null;
  sheetCustom(ch === 'x' ? 'Find more X leads' : 'Find more people to connect with', [
    el('div', { class: 'sheet-label', text: 'For' }), campSeg,
    el('div', { class: 'sheet-label', text: 'How many' }), grid,
    el('div', { class: 'sheet-row' }, other),
    el('div', { class: 'sheet-row' }, go),
    el('div', { class: 'sheet-note', text: ch === 'x'
      ? 'Founders on X who fit this campaign, nobody you already contacted. Claude checks the fit before they show up in To send, in a few minutes.'
      : 'Fresh launches from Peerlist, Uneed and Fazier. Only makers who listed their own LinkedIn, product site checked, nobody you already contacted. Claude checks the fit before they show up here, in a few minutes.' }),
    status ? el('div', { class: 'sheet-note', text: 'Last run: ' + status }) : null,
    unchecked,
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
/* -- daily goals --
 * Bars at the top of each outreach tab. Effort goals are per day (requests,
 * messages, DMs), replies per week because they are not in his hands. The
 * connect goal sits under the 25 cap, which stays the warning line. */
const GOALS = { goal_li_connect: 20, goal_li_message: 10, goal_x: 20, goal_replies: 5, goal_posts: 20 };
/* Replies tab: the same goal bars and chip row as the outreach tabs. */
function replyStrip() {
  const today = localStamp().slice(0, 10);
  const since = localStamp(new Date(Date.now() - 7 * 86400000));
  const posted = state.items.filter((i) => i.status === 'posted' && i.posted_ts);
  const day = goalOf('goal_posts');
  const row = el('div', { class: 'li-status' },
    el('button', { class: 'pill-chip', text: '↩ Replies to you', title: 'Find replies people left for you that you have not answered',
      onclick: () => { showSeg('waiting'); $('mentionsBtn').click(); } }),
    el('button', { class: 'pill-chip find', text: '+ Find posts', onclick: () => showTab('scout') }));
  return [drawGoals([
    ['Posted today', posted.filter((i) => i.posted_ts.slice(0, 10) === today).length, day],
    ['Posted this week', posted.filter((i) => i.posted_ts >= since).length, day * 7]]), row];
}
function goalOf(k) { const v = parseInt(LS.get(k, ''), 10); return Number.isFinite(v) && v > 0 ? v : GOALS[k]; }
function repliesThisWeek(ch) {
  const since = localStamp(new Date(Date.now() - 7 * 86400000));
  return dm.leads.filter((l) => l.channel === ch && l.reply_ts && l.reply_ts >= since).length;
}
function goalBars(ch) {
  const s = dm.stats[ch] || {};
  return drawGoals(ch === 'linkedin'
    ? [['Requests today', s.requested_today || 0, goalOf('goal_li_connect')],
       ['Messages today', s.sent_today || 0, goalOf('goal_li_message')],
       ['Replies this week', repliesThisWeek(ch), goalOf('goal_replies')]]
    : [['DMs today', s.sent_today || 0, goalOf('goal_x')],
       ['Replies this week', repliesThisWeek(ch), goalOf('goal_replies')]]);
}
function drawGoals(bars) {
  return el('div', { class: 'goals' }, ...bars.map(([label, n, goal]) => {
    const fill = el('div', { class: 'goal-fill' });
    fill.style.width = Math.min(100, Math.round(100 * n / goal)) + '%';
    // Display only: tapping a bar does nothing (goals are changed in Settings).
    return el('div', { class: 'goal' + (n >= goal ? ' done' : '') },
      el('div', { class: 'goal-top' }, el('span', { text: label }), el('b', { text: n + '/' + goal + (n >= goal ? ' ✓' : '') })),
      el('div', { class: 'goal-bar' }, fill));
  }));
}

/* The chip row under the goal bars, the same on LinkedIn and X DM: the daily
 * cap, the session, the countdown to the next send, and Find more. */
function statusChips(ch, mode) {
  const s = dm.stats[ch] || {};
  const c = paceCfg(ch, mode);
  const p = paceState(ch, mode);
  const done = mode === 'connect' ? (s.requested_today || 0) : (s.sent_today || 0);
  const ss = sessionOf(ch, mode);
  const row = el('div', { class: 'li-status' });
  row.append(el('span', { class: 'pill-chip' + (done >= c.cap ? ' warn' : ''),
    // The goal bar above shows progress; this chip is the warning line.
    text: 'Max ' + c.cap + (done >= c.cap ? ' reached' : '') }));
  row.append(el('button', { class: 'pill-chip' + (p.sessionDone ? ' ok' : ss ? ' accent' : ''), onclick: () => openSessionSheet(ch, mode),
    text: ss && ss.target ? 'Session ' + sessionCount(ch, mode, ss) + '/' + ss.target : '+ Session' }));
  if (mode === 'message' && p.wait) row.append(el('span', { class: 'pill-chip li-next', text: 'Next in ' + mmss(p.wait) }));
  if (ch === 'linkedin' && mode === 'connect') {
    row.append(p.paused
      ? el('button', { class: 'pill-chip warn', text: 'Paused · ' + dayName(s.connect_pause_until * 1000), onclick: () => weeklyLimitSheet(true) })
      : el('button', { class: 'pill-chip', text: 'Weekly limit?', title: "LinkedIn says you reached the weekly invitation limit", onclick: () => weeklyLimitSheet(false) }));
  }
  if (p.cool) {
    row.append(el('button', { class: 'pill-chip warn', text: 'Cooling down · Clear', onclick: () => sheet('End the cooldown early?', [{ label: 'Yes, ' + DM_NAME[ch] + ' is sending again', run: async () => {
      try { const r = await api('/api/dm/cooldown/clear', { channel: ch }); dm.stats = r.stats; renderDm(ch); } catch (e) { toast(e.message, true); }
    } }]) }));
  }
  // Find more on both lists: the people it finds land in Connect (they need a
  // request first), but he should not have to switch lists to start a search.
  {
    const job = dm.find && dm.find.job;
    const busy = job && ACTIVE.includes(job.status) && dm.find.run && dm.find.run.channel === ch;
    row.append(el('button', { class: 'pill-chip find' + (busy ? ' busy' : ''), onclick: () => openFindSheet(ch),
      text: busy ? 'Finding…' : '+ Find more' }));
  }
  const nodes = [row];
  if (p.paused) {
    nodes.push(el('div', { class: 'li-warn', text: "LinkedIn's weekly invitation limit. Connects are paused until " + dayName(s.connect_pause_until * 1000)
      + (s.connect_pause_sent_7d != null ? '. You had sent ' + s.connect_pause_sent_7d + ' requests in the 7 days before it hit.' : '.')
      + ' Message mode still works.' }));
  } else if (p.cool) {
    nodes.push(el('div', { class: 'li-warn', text: p.text }));
  } else if (p.capped) {
    nodes.push(el('div', { class: 'li-warn', text: mode === 'connect'
      ? "That's " + done + ' requests today. LinkedIn signed you out after about 82 on Sep 28, so stop here for today.'
      : "That's your daily message cap. More today raises the spam risk." }));
  } else if (p.sessionDone) {
    nodes.push(el('div', { class: 'li-warn ok', text: 'Session done: ' + ss.target + ' ' + (mode === 'connect' ? 'requests' : 'messages') + '. Nice.' }));
  }
  if (mode === 'connect' || ch === 'x') {
    const t = findStatusText(ch);
    const job = dm.find && dm.find.job;
    if (t && job && (ACTIVE.includes(job.status) || Date.now() - tsMs(dm.find.run.ts) < 3 * 3600e3)) {
      nodes.push(el('button', { class: 'find-line', onclick: () => openFindSheet(ch), text: 'Find more: ' + t }));
    }
  }
  return nodes;
}
function liStatus(mode) { return statusChips('linkedin', mode); }

function dayName(ms) { return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); }
/* LinkedIn said "you've reached the weekly invitation limit". He reports it
 * here; connects pause for the days he picks and every Open warns first. */
function weeklyLimitSheet(paused) {
  const s = dm.stats.linkedin || {};
  const set = async (days) => {
    try {
      const r = await api('/api/dm/connect-pause', { days });
      dm.stats = r.stats; renderDm('linkedin');
      toast(days ? 'Connects paused until ' + dayName(Date.now() + days * 86400000) : 'Connects back on');
    } catch (e) { toast(e.message, true); }
  };
  if (paused) {
    sheet('Paused until ' + dayName(s.connect_pause_until * 1000), [{ label: 'LinkedIn lets me connect again, resume now', run: () => set(0) },
      { label: 'Pause 2 more days', run: () => set(Math.ceil((s.connect_pause_until * 1000 - Date.now()) / 86400000) + 2) }]);
    return;
  }
  const hits = (s.limit_hits || []).filter((h) => h.requested_7d != null);
  sheetCustom('Hit the weekly limit?', [
    el('div', { class: 'sheet-note', text: "When LinkedIn says you've reached the weekly invitation limit, pause connects here. You've sent "
      + (s.requested_7d || 0) + ' requests in the last 7 days.' + (hits.length ? ' Last time it hit at ' + hits[0].requested_7d + '.' : '')
      + ' The limit counts a rolling week, so the oldest requests drop off day by day.' }),
    el('div', { class: 'sheet-label', text: 'Pause connects for' }),
    el('div', { class: 'sheet-grid' }, ...[2, 3, 5, 7].map((d) => el('button', { text: d + ' days', onclick: () => { closeSheet(); set(d); } }))),
  ]);
}

/* Shuffle all: every message waiting in this list gets another version (or a
 * fresh draw of lines), and no two people end up with the same text. Messages
 * he edited by hand are left alone. One Undo puts every one back. */
async function shuffleAll(list, btn) {
  const mine = list.filter((l) => l.status === 'ready' && typeof l.draft_text !== 'string'
    && ((l.variants && l.variants.length > 1) || libOf(l)));
  const edited = list.filter((l) => typeof l.draft_text === 'string').length;
  if (!mine.length) { toast(edited ? 'Only hand-edited messages here. Those are left as they are.' : 'Nothing here has another version'); return; }
  const prev = mine.map((l) => ({ l, pick: l.pick || null, variant_index: l.variant_index || 0 }));
  const taken = new Set(dm.leads.filter((x) => x.status === 'ready' && !mine.includes(x)).map(messageOf));
  for (const l of mine) {
    if (l.variants && l.variants.length > 1) {
      l.variant_index = pickVariant(l);
    } else {
      const lib = libOf(l);
      const cur = messageOf(l);
      let k = null;
      for (let t = 0; t < 60; t++) {
        k = drawLines(lib, l, Math.random);
        const txt = composeLines(lib, l, k);
        if (txt !== cur && !taken.has(txt)) break;
      }
      l.pick = k;
    }
    taken.add(messageOf(l));
  }
  const ch = mine[0].channel;
  renderDm(ch);
  const done = btn ? busy(btn, 'Shuffling…') : () => {};
  let saved = 0;
  try {
    // One at a time: each save rewrites the leads file on the server.
    for (const l of mine) { await dmSave(l, { pick: l.pick || null, variant_index: l.variant_index || 0, draft_text: null }, true); saved++; }
  } catch (e) { toast('Shuffled ' + saved + ' of ' + mine.length + ', then stopped: ' + e.message, true); done(); return; }
  done();
  toast('Shuffled ' + saved + (edited ? ' · ' + edited + ' you edited left as they are' : ''), false, { label: 'Undo', run: async () => {
    for (const p of prev) { p.l.pick = p.pick; p.l.variant_index = p.variant_index; }
    renderDm(ch);
    try { for (const p of prev) await dmSave(p.l, { pick: p.pick, variant_index: p.variant_index, draft_text: null }, true); toast('Back to how they were'); }
    catch (e) { toast(e.message, true); }
  } });
}
function shuffleChip(list) {
  const n = list.filter((l) => l.status === 'ready' && ((l.variants && l.variants.length > 1) || libOf(l))).length;
  return n ? el('button', { class: 'pill-chip', text: '🎲 Shuffle all', title: 'Give every waiting message another version',
    onclick: (e) => sheet('Shuffle ' + n + ' messages?', [{ label: '🎲 Shuffle all ' + n, run: () => shuffleAll(list, e.target) }]) }) : null;
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

function focusHeader(i, total, l, mode, list) {
  return el('div', { class: 'focus-top' },
    el('span', { class: 'focus-count', text: (i + 1) + ' of ' + total }),
    mode && list ? stepArrows(i, total, (k) => { li.focus[mode] = list[k].id; renderDm('linkedin'); }) : null,
    el('span', { class: 'spacer' }), tierPill(l.tier), campPill(l.campaign));
}
/* ‹ › beside "2 of 6": they sit at the top of the card, which stays still,
 * so stepping through people never needs a scroll. */
function stepArrows(i, total, go) {
  if (total < 2) return null;
  return el('span', { class: 'step-arrows' },
    el('button', { class: 'step', 'aria-label': 'Previous', text: '‹', disabled: i === 0, onclick: () => { buzz(6); go(i - 1); } }),
    el('button', { class: 'step', 'aria-label': 'Next', text: '›', onclick: () => { buzz(6); go((i + 1) % total); } }));
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
  card.append(focusHeader(i, list.length, l, 'connect', list),
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
  if (listTools('connect', list, nodes)) return;
  // In the list, the row's button follows the same two steps as the focus
  // view: Open, then (once opened) Sent.
  nodes.push(...searchable('Search a name or product', () => groupedByTier(list.filter(matches).filter(passes('connect')), (l) =>
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
    : 'Accepts and replies are picked up from your LinkedIn emails every ' + aw.every_min + ' min' + (aw.last_ts ? ' · checked ' + agoText(aw.last_ts) : '')
      + (aw.last_found ? ' · ' + aw.last_found + ' moved to Message' : '') + (aw.last_replies ? ' · ' + aw.last_replies + ' replied' : '')
      + ". LinkedIn's emails list at most 8 people, so tap Accepted for anyone it misses.";
  return el('div', { class: 'focus-meta' }, el('span', { class: 'small ' + (aw.error ? 'err-text' : 'muted'), text }),
    el('span', { class: 'spacer' }),
    el('button', { class: 'link', text: 'Check now', onclick: async (e) => {
      const done = busy2(e.target);
      try {
        const r = await api('/api/dm/accept-check', {});
        const rp = r.replied || [];
        toast(r.error ? 'Check failed: ' + r.error
          : (r.moved.length || rp.length) ? [r.moved.length ? r.moved.length + ' accepted' : '', rp.length ? rp.length + ' replied' : ''].filter(Boolean).join(', ') + ': ' + r.moved.concat(rp).join(', ')
          : 'Nobody new accepted or replied', !!r.error);
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
  const rates = l.variants.map((v) => { const st = verStat(l, v.label || 'Message'); return st && st.sent ? (v.label || 'Message') + ' ' + st.replied + '/' + st.sent : null; }).filter(Boolean);
  return el('div', {}, el('div', { class: 'var-chips' }, ...l.variants.map((v, k) => el('button', {
    class: 'chip' + (k === cur ? ' on' : ''), text: v.label || 'Version ' + (k + 1),
    onclick: () => {
      if (k === cur) return;
      if (typeof l.draft_text === 'string') sheet('Switch and lose your edits to this one?', [{ label: 'Switch', run: () => pick(k) }]);
      else pick(k);
    } }))),
    rates.length ? el('div', { class: 'ver-rates', title: 'Replies out of sends, every send on record', text: 'Replied: ' + rates.join(' · ') }) : null);
}

// Files a lead carries (the report PDF to send along). Tapping one saves it to
// this device, ready to attach in LinkedIn.
function attachmentChips(l) {
  if (!(l.attachments && l.attachments.length)) return null;
  const fetchFile = async (a) => {
    const res = await fetch(serverBase() + '/api/dm/attachment?file=' + encodeURIComponent(a.file), {
      headers: { 'X-Sidekick-Key': LS.get('password'), 'ngrok-skip-browser-warning': 'true' } });
    if (!res.ok) throw new Error(res.status === 404 ? 'That file is on the Mac, not on this device' : 'Could not get the file (' + res.status + ')');
    return URL.createObjectURL(await res.blob());
  };
  const save = async (a, btn) => {
    btn.disabled = true;
    try {
      const url = await fetchFile(a);
      const link = el('a', { href: url, download: a.file });
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast('Saved ' + a.file);
    } catch (e) { toast(e.message || 'Could not get the file', true); } finally { btn.disabled = false; }
  };
  // The tab is opened on the tap itself, then pointed at the file, so the
  // browser does not block it as a pop-up.
  const view = async (a, btn) => {
    const tab = window.open('', '_blank');
    btn.disabled = true;
    try {
      const url = await fetchFile(a);
      if (tab) tab.location = url; else window.location.assign(url);
    } catch (e) { if (tab) tab.close(); toast(e.message || 'Could not open the file', true); } finally { btn.disabled = false; }
  };
  const row = el('div', { class: 'var-chips' });
  for (const a of l.attachments) {
    if (a.url) {
      // A link (e.g. the report as a web page): open it, or copy it into the message.
      const go = el('a', { class: 'chip', href: a.url, target: '_blank', rel: 'noopener', text: '🔗 Open ' + (a.label || 'link') });
      const cp = el('button', { class: 'chip', text: '⧉ Copy link', title: a.url });
      cp.onclick = async () => { try { await navigator.clipboard.writeText(a.url); toast('Link copied'); } catch { toast('Could not copy. ' + a.url, true); } };
      row.append(go, cp);
      continue;
    }
    const open = el('button', { class: 'chip', text: '📄 Open ' + (a.label || 'file'), title: 'Open ' + a.file });
    open.onclick = () => view(a, open);
    const dl = el('button', { class: 'chip', text: '📎 Save ' + (a.label || 'file'), title: 'Save ' + a.file + ' to attach in LinkedIn' });
    dl.onclick = () => save(a, dl);
    row.append(open, dl, el('span', { class: 'muted small', text: a.file }));
  }
  return row;
}

/* Buyers and everyone else are worked differently, so they get their own tab.
 * A buyer (ICP) gets the four full versions with the report PDF, or nothing yet. */
function isIcp(l) { return !['light', 'watch'].includes(l.icp); }
function pdfPending(l) { return !!l.needs_report && !(l.attachments && l.attachments.length); }
function hasMessage(l) { return !!((l.variants && l.variants.length) || l.library || typeof l.draft_text === 'string'); }
async function setAsk(l, on) {
  try { await dmSave(l, { use_ask: on }); await refresh(); } catch (e) { toast(e.message, true); }
}
function pdfBadge(l) {
  if (!pdfPending(l)) return null;
  return el('div', { class: 'pdf-badge' + (l.ask_on ? ' ask' : '') },
    el('b', { text: l.ask_on ? 'Asking first' : 'PDF to be made' }),
    el('span', { text: l.ask_on ? ' · the report gets made if they say yes' : ' · no message until the report is ready' }));
}

/* A buyer with no report yet: nothing to send, on purpose. */
function pdfWaitingCard(list, i, nodes) {
  const l = list[i];
  const card = el('div', { class: 'card focus-card' });
  card.append(focusHeader(i, list.length, l, 'message', list),
    el('div', { class: 'focus-name', text: l.name || 'LinkedIn lead' }),
    l.product ? el('div', { class: 'focus-product', text: l.product }) : null,
    pdfBadge(l), nextSteps(l), dmFlags(l, ''),
    el('p', { class: 'hint', text: 'The four versions are written once the AI report is made for ' + (l.product || 'them') + '.' }));
  if (l.ask_variants && l.ask_variants.length) {
    card.append(el('button', { class: 'btn block', text: 'Ask first instead (' + l.ask_variants.length + ' short versions)',
      title: 'Send a short message that asks before any research is done', onclick: () => setAsk(l, true) }));
  }
  card.append(focusNav('message', list, i));
  nodes.push(card);
  const nx = upNext('message', list, i);
  if (nx) nodes.push(nx);
  setDmActions([
    el('button', { class: 'btn grow', text: 'Skip', onclick: () => dmStatus(l, 'skipped', { reason: 'skipped on phone' }, 'Skipped ' + dmWho(l), 'ready') }),
    el('button', { class: 'btn icon', text: '⋯', onclick: () => dmMenu(l) }),
  ]);
}

function messageFocus(list, nodes) {
  const i = pickFocus('message', list);
  if (i < 0) {
    nodes.push(el('div', { class: 'empty', text: 'No written messages waiting. People land here when they accept your request.' }));
    setDmActions(null);
    return;
  }
  const l = list[i];
  if (pdfPending(l) && !hasMessage(l)) { pdfWaitingCard(list, i, nodes); return; }
  const opened = dm.opened.has(l.id);
  const card = el('div', { class: 'card focus-card' + (opened ? ' opened' : '') });
  card.append(focusHeader(i, list.length, l, 'message', list),
    el('div', { class: 'focus-name', text: l.name || 'LinkedIn lead' }),
    l.product ? el('div', { class: 'focus-product', text: l.product }) : null);
  if (opened) card.append(el('div', { class: 'focus-hint', text: 'Sent it? Tap Sent. Changed it in LinkedIn? Paste what you sent over the text first.' }));
  const badge = pdfBadge(l);
  if (badge) card.append(badge);
  card.append(dmFlags(l, ''));
  const chips = variantChips(l);
  if (chips) card.append(chips);
  const { ta, count } = messageBox(l);
  const files = attachmentChips(l);
  const canShuffle = (l.variants && l.variants.length > 1) || libOf(l);
  card.append(ta, el('div', { class: 'focus-meta' },
    canShuffle ? el('button', { class: 'link', text: '🎲 Another version', onclick: () => dmShuffle(l) }) : el('span', { class: 'muted small', text: 'Tap the text to edit' }),
    el('span', { class: 'spacer' }), count));
  if (files) card.append(files);
  // The report PDF option sits under the drafted message.
  const ns = nextSteps(l);
  if (ns) card.append(ns);
  card.append(el('div', { class: 'focus-meta' },
    el('button', { class: 'link', text: '✎ Tell Claude what to change', onclick: () => tellClaude(l, ta) }),
    el('span', { class: 'spacer' }),
    l.claude_url ? el('button', { class: 'link', text: 'Claude chat ↗', onclick: () => openChat(l, ta.value) }) : null));
  if (l.ask_on) card.append(el('button', { class: 'link', text: 'Wait for the PDF instead', onclick: () => setAsk(l, false) }));
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
  if (listTools('message', list, nodes)) return;
  nodes.push(...searchable('Search a name or product', () => groupedByTier(list.filter(matches).filter(passes('message')), (l) =>
    compactRow(l, () => focusOn('message', l.id), el('button', { class: 'btn sm', text: 'Open', onclick: () => focusOn('message', l.id) })))));
}

function needsBanner(needs) {
  const writing = needs.filter((l) => l.writing_job).length;
  const box = el('div', { class: 'needs-banner' });
  box.append(el('div', { class: 'nb-text' },
    el('b', { text: needs.length + (needs.length === 1 ? ' person needs' : ' people need') + ' a message' }),
    el('div', { class: 'muted small', text: writing ? 'Claude is writing ' + writing + '. They show up here in a few minutes.'
      : needs.some((l) => lastTry(l)) ? 'The last run wrote nothing for ' + needs.filter((l) => lastTry(l)).length + '. Tap Show to see why.'
        : 'New connections and fits with nothing written yet.' })));
  box.append(el('div', { class: 'nb-actions' },
    el('button', { class: 'btn sm primary', text: writing ? 'Writing…' : '✍ Write with Claude', disabled: !!writing, onclick: async (e) => {
      const done = busy2(e.target);
      try { const r = await api('/api/dm/write', { channel: 'linkedin' }); toast('Claude is writing ' + r.leads + '. Takes a few minutes.'); await refresh(); }
      catch (err) { toast(err.message, true); }
      done();
    } }),
    el('button', { class: 'link', text: li.showNeeds ? 'Hide' : 'Show', onclick: () => { li.showNeeds = !li.showNeeds; renderDm('linkedin'); } })));
  if (li.showNeeds) {
    box.append(el('div', { class: 'nb-list' }, ...needs.map((l) => el('div', {},
      el('div', { class: 'needs-row' },
        el('b', { text: dmWho(l) }),
        el('span', { class: 'muted', text: ' ' + [l.product, l.writing_job ? 'writing…' : l.accepted_ts ? 'accepted ' + agoText(l.accepted_ts) : ''].filter(Boolean).join(' · ') }),
        el('button', { class: 'more-btn', text: '⋯', onclick: () => dmMenu(l) })),
      lastTry(l)))));
  }
  return box;
}

function renderLinkedIn(root) {
  const ch = 'linkedin';
  const mode = modeOf(ch);
  const all = dm.leads.filter((l) => l.channel === ch);
  const nodes = [goalBars(ch)];
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
    const todo = mine.filter((l) => l.status === 'ready' && !snoozed(l) && inCamp(l)).sort(byTier);
    const asked = mine.filter((l) => l.status === 'requested' && inCamp(l))
      .sort((a, b) => (b.requested_ts || '').localeCompare(a.requested_ts || ''));
    const cdone = mine.filter((l) => ['skipped', 'cant_dm'].includes(l.status) && inCamp(l));
    nodes.push(segBar(CONNECT_SEGS, dm.cseg, { connect: todo.length, requested: asked.length },
      (k) => { dm.cseg = k; LS.set('dmcseg', k); li.q = ''; li.sel.on = false; renderDm(ch); }));
    if (dm.cseg === 'requested') {
      requestedList(asked, nodes);
    } else if (dm.cseg === 'cdone') {
      setDmActions(null);
      nodes.push(...(cdone.length ? cdone.map(connectDoneRow) : [el('div', { class: 'empty', text: 'Skips and dead links land here.' })]));
    } else {
      nodes.push(el('div', { class: 'view-row' }, viewToggle('connect', todo.length), el('span', { class: 'spacer' }),
        snoozeChip(mine.filter((l) => l.status === 'ready' && snoozed(l) && inCamp(l))), campFilterChip(camps)));
      if (li.view.connect === 'list') connectList(todo, nodes); else connectFocus(todo, nodes);
    }
    root.replaceChildren(...nodes);
    return;
  }

  const saved = state.outreach.filter((o) => o.platform === 'linkedin' && o.status === 'queued');
  const sleeping = mine.filter((l) => l.status === 'ready' && snoozed(l) && inCamp(l));
  const ready = mine.filter((l) => l.status === 'ready' && !snoozed(l) && inCamp(l)).sort(byTier);
  // A buyer being researched stays on their card (it shows the progress),
  // not in the "needs a message" box with the new connections.
  const needs = ready.filter((l) => l.needs_message && !l.needs_report);
  const allWritable = ready.filter((l) => !l.needs_message || l.needs_report);
  const nIcp = allWritable.filter(isIcp).length;
  if (!['icp', 'other'].includes(li.aud)) li.aud = 'icp';
  // Buyers with something to send come before the ones still waiting on a PDF.
  const writable = allWritable.filter((l) => isIcp(l) === (li.aud === 'icp'))
    .sort((x, y) => (hasMessage(y) - hasMessage(x)) || byTier(x, y));
  const sent = mine.filter((l) => l.status === 'sent' && inCamp(l)).sort((a, b) => (b.sent_ts || '').localeCompare(a.sent_ts || ''));
  const done = mine.filter((l) => ['replied', 'skipped', 'cant_dm'].includes(l.status) && inCamp(l))
    .sort((a, b) => ((b.status === 'replied') - (a.status === 'replied')) || (b.updated_ts || '').localeCompare(a.updated_ts || ''));
  const replied = done.filter((l) => l.status === 'replied').length;
  nodes.push(segBar(DM_SEGS, dm.seg[ch], { send: allWritable.length, sent: sent.length, done: replied, saved: saved.length },
    (k) => { dm.seg[ch] = k; LS.set('dmseg_' + ch, k); li.q = ''; li.sel.on = false; renderDm(ch); }));
  const which = dm.seg[ch];
  if (which === 'send') {
    if (needs.length) nodes.push(needsBanner(needs));
    const waitingPdf = allWritable.filter((l) => isIcp(l) && pdfPending(l) && !hasMessage(l)).length;
    // Buyers or everyone else, as a second toggle beside One by one / List.
    const audToggle = el('div', { class: 'mini-seg' },
      ...[['icp', 'ICP', nIcp], ['other', 'Non-ICP', allWritable.length - nIcp]].map(([k, label, n]) =>
        el('button', { class: li.aud === k ? 'on' : '', text: label + ' (' + n + ')', onclick: () => {
          li.aud = k; LS.set('li_aud', k); li.focus.message = null; li.q = ''; renderDm(ch); window.scrollTo(0, 0);
        } })));
    // Row one picks what is shown, row two acts on the whole list.
    nodes.push(el('div', { class: 'view-row' }, viewToggle('message', writable.length), audToggle));
    const acts = [shuffleChip(writable.filter(hasMessage)), snoozeChip(sleeping),
      Object.keys(dm.templates || {}).length ? el('button', { class: 'pill-chip', text: '✎ Templates', onclick: openTemplates }) : null,
      writable.length ? el('button', { class: 'pill-chip', text: '✎ Fix all', title: 'The whole batch is wrong: rewrite all with a note', onclick: () => fixAllMessages(writable.filter((l) => l.variants && l.variants.length).length) }) : null,
      campFilterChip(camps)].filter(Boolean);
    if (acts.length) nodes.push(el('div', { class: 'view-row' }, ...acts));
    if (li.aud === 'icp' && waitingPdf) nodes.push(el('p', { class: 'hint', text: waitingPdf + (waitingPdf === 1 ? ' buyer is' : ' buyers are') + ' waiting on a report PDF. They have no message on purpose.' }));
    if (li.view.message === 'list') messageList(writable, nodes); else messageFocus(writable, nodes);
  } else {
    setDmActions(null);
    if (which === 'sent') {
      sentView(ch, sent, nodes);
    } else if (which === 'done') {
      nodes.push(...(done.length ? done.map(dmDoneRow) : [el('div', { class: 'empty', text: 'Replies, skips and closed chats land here.' })]));
    } else {
      nodes.push(el('p', { class: 'hint', text: 'Profiles you share from the LinkedIn app land here. Claude turns them into the next batch.' }));
      nodes.push(...(saved.length ? saved.map(savedRow) : [el('div', { class: 'empty', text: 'No profiles saved.' })]));
    }
  }
  root.replaceChildren(...nodes);
}


/* ================= message templates =================
 * The fixed versions (Try it, Your take, Can I) every Non-ICP message is
 * built from. He edits one here; it is used for every message written from
 * now on, and he can also rewrite the ones already waiting. */
const SET_NAMES = { light: 'Non-ICP notes' };
function templateCampaign() {
  const keys = Object.keys(dm.templates || {});
  return keys.includes(dm.camp.linkedin) ? dm.camp.linkedin : keys.includes('supacite') ? 'supacite' : keys[0];
}
function waitingFor(camp, set, label) {
  return dm.leads.filter((l) => l.status === 'ready' && l.campaign === camp && (set === 'light' ? l.icp === 'light' : true)
    && (l.variants || []).some((v) => v.label === label));
}
function openTemplates() {
  const camp = templateCampaign();
  const sets = (dm.templates || {})[camp] || {};
  if (!camp || !Object.keys(sets).length) { toast('No templates yet. Update the server on this device.', true); return; }
  const nodes = [el('div', { class: 'sheet-note', text: 'Write {first}, {product}, {category} or {source} where each person\'s details go. Everything else is sent word for word.' })];
  for (const [set, rows] of Object.entries(sets)) {
    nodes.push(el('div', { class: 'sheet-label', text: (SET_NAMES[set] || set) + ' · ' + ((dm.campaigns[camp] && dm.campaigns[camp].label) || camp) }));
    for (const t of rows) {
      const ta = el('textarea', { class: 'tell-box tpl-box', rows: 7 });
      ta.value = t.text;
      const chars = el('span', { class: 'muted small' });
      const draw = () => { chars.textContent = ta.value.trim().length + ' chars'; };
      ta.addEventListener('input', draw); draw();
      const save = el('button', { class: 'btn primary sm', text: 'Save', onclick: () => saveTemplate(camp, set, t.label, ta.value, t.text) });
      nodes.push(el('div', { class: 'tpl' }, el('div', { class: 'tpl-head' }, el('b', { text: t.label }), el('span', { class: 'spacer' }), chars, save), ta));
    }
  }
  sheetCustom('Message templates', nodes);
}
function saveTemplate(camp, set, label, text, before) {
  text = text.replace(/\r\n/g, '\n').trim();
  if (text === String(before).trim()) { toast('No change'); return; }
  const bad = (text.match(/\{(\w+)\}/g) || []).filter((x) => !['{first}', '{product}', '{category}', '{source}'].includes(x));
  if (bad.length) { toast('Unknown slot ' + bad[0] + '. Use {first}, {product}, {category} or {source}', true); return; }
  const n = waitingFor(camp, set, label).filter((l) => typeof l.draft_text !== 'string').length;
  const go = async (apply) => {
    try {
      const r = await api('/api/dm/templates', { campaign: camp, set, label, text, apply });
      dm.templates = r.templates;
      await refresh();
      renderDm('linkedin');
      toast('"' + label + '" saved' + (apply === 'all' ? ' · ' + r.updated + ' waiting messages updated'
        + (r.kept_edits ? ', ' + r.kept_edits + ' you edited left as they are' : '') + (r.skipped ? ', ' + r.skipped + ' could not be matched' : '') : ' for new messages'));
    } catch (e) { toast(e.message, true); }
  };
  sheet('Save "' + label + '"', [
    { label: 'Use it for new messages only', run: () => go('future') },
    ...(n ? [{ label: 'Also update the ' + n + ' waiting ' + (n === 1 ? 'message' : 'messages') + ' now', run: () => go('all') }] : []),
  ]);
}

/* ================= buyers waiting on a report =================
 * Two actions, kept small inside the card: research and write the no-PDF
 * messages (only until that is done), and ask for the PDF (until it exists;
 * it is built on the Mac). */
function canResearch(l) {
  return isIcp(l) && l.status === 'ready' && kindOf(l) === 'message' && !hasMessage(l) && !(l.ask_variants && l.ask_variants.length);
}
async function researchLeads(list) {
  const ids = list.filter(canResearch).map((l) => l.id);
  if (!ids.length) { toast('Already researched and written'); return; }
  try {
    const r = await api('/api/dm/write', { ids, research: true, channel: 'linkedin' });
    toast('Claude is researching ' + r.leads + '. The messages show up here in a few minutes.');
    await refresh();
  } catch (e) { toast(e.message, true); }
}
async function requestPdf(list, on = true) {
  const todo = list.filter((l) => pdfPending(l) && !!l.report_requested !== on);
  let ok = 0;
  try { for (const l of todo) { await dmSave(l, { report_request: on }, true); ok++; } } catch (e) { toast(e.message, true); }
  li.sel.on = false; li.sel.ids.clear();
  renderDm('linkedin');
  toast(on ? (ok === 1 ? 'PDF requested for ' + dmWho(todo[0]) : ok + ' PDFs requested') + '. Claude makes it on the Mac.' : 'Request cancelled');
}
/* The next step for a buyer waiting on a report, as tappable tiles: what
 * each one does, in plain words, and while Claude works, how long it has
 * been going. */
function jobFor(l) { return l.writing_job ? state.jobs.find((j) => j.id === l.writing_job) || null : null; }
function stepTile({ icon, title, lines, onclick, busy, pending }) {
  return el(onclick && !busy ? 'button' : 'div', { class: 'ns-tile' + (busy ? ' busy' : '') + (pending ? ' pending' : ''), onclick: onclick || null },
    el('span', { class: 'ns-ico' }, busy ? el('span', { class: 'spin' }) : icon),
    el('span', { class: 'ns-body' }, el('b', { text: title }), ...lines.map((t) => el('span', { class: 'ns-line', text: t }))),
    onclick && !busy ? el('span', { class: 'ns-go', text: '›' }) : null);
}
/* What the last Claude run did for this person, when it wrote nothing. */
function lastTry(l) {
  const w = l.last_write;
  if (!w || l.writing_job || w.result === 'written' || Date.now() - tsMs(w.ts) > 3 * 86400e3) return null;
  return el('div', { class: 'ns-result' },
    el('b', { text: (w.result === 'not_a_fit' ? 'Claude said not a fit' : 'Last try wrote nothing') + ' · ' + agoText(w.ts) }),
    el('span', { text: w.why || 'No reason given.' }));
}
function nextSteps(l) {
  if (!isIcp(l) || !pdfPending(l)) return null;
  const p = l.product || 'their product';
  const first = (l.name || '').split(' ')[0] || 'them';
  const tiles = [];
  const job = jobFor(l);
  if (l.writing_job && (!job || ACTIVE.includes(job.status))) {
    tiles.push(stepTile({ busy: true, title: 'Researching ' + p,
      lines: ['Claude is asking ChatGPT a question a buyer of ' + p + ' would type, then writing the messages from the answer.',
        (job ? 'Started ' + agoText(job.ts) + ' · ' : '') + 'usually 3 to 5 minutes. You get a notification when it is done.'] }));
  } else if (canResearch(l)) {
    const lt = lastTry(l);
    if (lt) tiles.push(lt);
    tiles.push(stepTile({ icon: '🔎', title: l.last_write ? 'Try the research again' : 'Research and write the message',
      lines: ['Asks ChatGPT one question a buyer of ' + p + ' would type, then writes the no-PDF messages from what it says.',
        state.ask === false ? 'The ChatGPT check is off on the server (no DataForSEO login), so this run cannot research yet and will write nothing.'
          : 'Takes a few minutes. Nothing is sent.'],
      onclick: (e) => { const t = e.currentTarget; t.disabled = true; t.querySelector('b').textContent = 'Starting…'; researchLeads([l]); } }));
  }
  tiles.push(l.report_requested
    ? stepTile({ pending: true, icon: '📄', title: 'Report PDF requested ' + agoText(l.report_requested),
      lines: ['Claude builds it on the Mac: 10 buyer questions on ChatGPT and Perplexity, who gets named, and what rivals publish.', 'Tap to cancel the request.'],
      onclick: () => sheet('Cancel the PDF request for ' + p + '?', [{ label: 'Cancel the request', danger: true, run: () => requestPdf([l], false) }]) })
    : stepTile({ icon: '📄', title: 'Make the report PDF',
      lines: ['10 buyer questions on ChatGPT and Perplexity, who gets named, and what rivals publish. Built on the Mac.', 'Tap to send the request.'],
      onclick: () => requestPdf([l]) }));
  return el('div', { class: 'next-steps' }, el('div', { class: 'ns-head', text: 'Next step for ' + first }), ...tiles);
}

/* ================= snooze, ICP moves, follow-ups, list select ================= */
function todayStr() { return localStamp().slice(0, 10); }
function dateIn(days) { return localStamp(new Date(Date.now() + days * 86400000)).slice(0, 10); }
function snoozed(l) { return !!l.snooze_until && l.snooze_until > todayStr(); }

async function snoozeLeads(list, until) {
  let ok = 0;
  try { for (const l of list) { await dmSave(l, { snooze_until: until || null }, true); ok++; } }
  catch (e) { toast(e.message, true); }
  li.sel.on = false; li.sel.ids.clear();
  renderDm(list[0].channel);
  toast(until ? (ok === 1 ? dmWho(list[0]) : ok + ' people') + ' snoozed until ' + until : 'Woken up: ' + ok);
}
function snoozeSheet(list) {
  const who = list.length === 1 ? dmWho(list[0]) : list.length + ' people';
  sheet('Snooze ' + who + ' until…', [['Tomorrow', 1], ['In 3 days', 3], ['In a week', 7], ['In 2 weeks', 14], ['In a month', 30]]
    .map(([label, d]) => ({ label: label + ' · ' + dateIn(d), run: () => snoozeLeads(list, dateIn(d)) })));
}
function snoozeChip(list) {
  if (!list.length) return null;
  return el('button', { class: 'pill-chip', text: '💤 ' + list.length, title: 'Snoozed people', onclick: () => sheet('Snoozed', [
    ...list.map((l) => ({ label: 'Wake ' + dmWho(l) + ' (until ' + l.snooze_until + ')', run: () => snoozeLeads([l], '') })),
    ...(list.length > 1 ? [{ label: 'Wake all ' + list.length, run: () => snoozeLeads(list, '') }] : []),
  ]) });
}

/* He decides who is a buyer. Moving someone to ICP puts their non-ICP note
 * aside on the server and they wait as "PDF to be made" (a buyer gets the full
 * set or nothing); moving them back brings the note back. */
async function setIcp(list, icp) {
  const prev = list.map((l) => ({ l, icp: l.icp || 'light' }));
  let ok = 0;
  try { for (const l of list) { await dmSave(l, { icp }, true); ok++; } } catch (e) { toast(e.message, true); }
  li.sel.on = false; li.sel.ids.clear();
  renderDm('linkedin');
  const toBuyer = !['light', 'watch'].includes(icp);
  toast((ok === 1 ? dmWho(list[0]) : ok + ' people') + ' moved to ' + (toBuyer ? 'ICP. Their note is kept aside until the report is made.' : 'Non-ICP.'), false,
    { label: 'Undo', run: async () => {
      try { for (const p of prev) await dmSave(p.l, { icp: p.icp }, true); renderDm('linkedin'); toast('Undone'); } catch (e) { toast(e.message, true); }
    } });
}

/* Reply rate per version, from every send on record (the server counts). */
function verStat(l, label) { return (dm.versions || {})[(l.channel || '') + '|' + (l.campaign || '') + '|' + label] || null; }
function verWeight(l, label) { const st = verStat(l, label) || { sent: 0, replied: 0 }; return (st.replied + 1) / (st.sent + 2); }
/* Another version, leaning toward the ones that get replies. A version with
 * no sends yet starts at even odds, so new ones still get tried. */
function pickVariant(l) {
  const n = l.variants.length, cur = (l.variant_index || 0) % n;
  const opts = l.variants.map((v, k) => k).filter((k) => k !== cur);
  const w = opts.map((k) => verWeight(l, l.variants[k].label || 'Message'));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < opts.length; i++) { r -= w[i]; if (r <= 0) return opts[i]; }
  return opts[opts.length - 1];
}
function versionsSheet(ch) {
  const camp = dm.camp[ch];
  const rows = Object.entries(dm.versions || {}).filter(([k]) => k.startsWith(ch + '|') && (!camp || k.split('|')[1] === camp))
    .map(([k, v]) => ({ name: k.split('|')[2], camp: k.split('|')[1], sent: v.sent, replied: v.replied })).filter((r) => r.sent)
    .sort((a, b) => b.replied / b.sent - a.replied / a.sent || b.sent - a.sent);
  sheetCustom('Reply rate per version', [
    el('div', { class: 'sheet-note', text: 'Replies out of sends, every send on record. Shuffle leans toward the versions near the top. A version needs about 10 sends before its rate means much.' }),
    ...rows.map((r) => el('div', { class: 'ver-row' },
      el('span', { class: 'grow', text: r.name }),
      el('span', { class: 'muted small', text: (dm.campaigns[r.camp] && dm.campaigns[r.camp].label) || r.camp }),
      el('b', { text: r.replied + '/' + r.sent + ' · ' + Math.round(100 * r.replied / r.sent) + '%' }))),
  ]);
}

/* -- follow-ups: sent, no reply, due -- */
const FU_DAYS = { linkedin: [3, 5], x: [2, 3] };   // conversion playbook, section 4
function lastTouch(l) { const b = l.bumps || []; return b.length ? b[b.length - 1].ts : l.sent_ts; }
function followupDue(l) {
  const n = (l.bumps || []).length;
  if (l.status !== 'sent' || !isIcp(l) || snoozed(l) || l.no_followup || n >= 2) return false;
  const d = daysSince(lastTouch(l));
  return d !== null && d >= (FU_DAYS[l.channel] || FU_DAYS.linkedin)[n];
}
const fuPick = {};
function followupCard(l) {
  const n = (l.bumps || []).length;
  const card = el('div', { class: 'card dm-card' });
  card.append(whoRow(l.channel === 'x' ? handleOf(l.handle) : (l.name || '?'),
    'sent ' + agoText(lastTouch(l)) + (l.product ? ' · ' + l.product : '') + ' · follow-up ' + (n + 1) + ' of 2', () => dmMenu(l)));
  if (l.channel === 'linkedin') card.querySelector('.who-name b').textContent = l.name || 'LinkedIn lead';
  card.append(el('div', { class: 'sent-label', text: n ? 'Your last follow-up' : 'You sent' }),
    postBlock(n ? l.bumps[n - 1].text : (l.sent_text || '(sent text not recorded)'), 'post short'));
  const fv = l.followup_variants || [];
  const replied = el('button', { class: 'btn', text: 'They replied', onclick: () => dmStatus(l, 'replied', {}, dmWho(l) + ' replied, moved to Done', 'sent') });
  if (l.writing_job) {
    card.append(el('div', { class: 'focus-hint', text: 'Claude is writing this follow-up…' }), el('div', { class: 'dm-row' }, replied));
    return card;
  }
  if (!fv.length) {
    card.append(el('p', { class: 'hint', text: 'No follow-up written yet.' }), el('div', { class: 'dm-row' }, replied,
      el('button', { class: 'btn', text: 'Open', onclick: () => openLead(l, openUrl(l)) })));
    return card;
  }
  const k = Math.min(fuPick[l.id] || 0, fv.length - 1);
  if (fv.length > 1) card.append(el('div', { class: 'var-chips' }, ...fv.map((v, j) => el('button', { class: 'chip' + (j === k ? ' on' : ''),
    text: v.label || 'Version ' + (j + 1), onclick: () => { fuPick[l.id] = j; renderDm(l.channel); } }))));
  const ta = el('textarea', { class: 'dm-msg', rows: 5 });
  ta.value = fv[k].text;
  card.append(ta, el('div', { class: 'dm-row' },
    el('button', { class: 'btn primary grow', text: 'Copy + open ↗', onclick: async () => {
      const ok = await copy(ta.value);
      toast(ok ? 'Copied. Paste it in ' + DM_NAME[l.channel] + '.' : 'Copy failed', !ok);
      openLead(l, openUrl(l));
    } }),
    el('button', { class: 'btn ok', text: '✓ Sent', onclick: async () => {
      try {
        await dmSave(l, { bump_sent: ta.value.trim() });
        renderDm(l.channel);
        toast('Follow-up ' + (n + 1) + ' logged', false, { label: 'Undo', run: async () => {
          try { await dmSave(l, { bump_undo: true }); renderDm(l.channel); } catch { /* toasted */ } } });
      } catch { /* toasted */ }
    } }), replied));
  return card;
}
function sentView(ch, sent, nodes) {
  const due = sent.filter(followupDue);
  const key = 'sentview_' + ch;
  const v = due.length ? LS.get(key, 'due') : 'all';
  nodes.push(el('div', { class: 'view-row' }, el('div', { class: 'mini-seg' },
    ...[['due', 'Follow up (' + due.length + ')'], ['all', 'All sent (' + sent.length + ')']].map(([k, label]) =>
      el('button', { class: v === k ? 'on' : '', text: label, disabled: k === 'due' && !due.length,
        onclick: () => { LS.set(key, k); renderDm(ch); } }))),
    el('span', { class: 'spacer' }),
    Object.keys(dm.versions || {}).some((x) => x.startsWith(ch + '|')) ? el('button', { class: 'pill-chip', text: '📊 Versions', onclick: () => versionsSheet(ch) }) : null));
  if (v === 'all') {
    nodes.push(el('p', { class: 'hint', text: 'Waiting on a reply. Tap "They replied" when one comes in, and paste it so Claude can draft your answer.' }));
    nodes.push(...(sent.length ? sent.map(dmSentCard) : [el('div', { class: 'empty', text: 'Nothing sent in the last 30 days.' })]));
    return;
  }
  const need = due.filter((l) => !(l.followup_variants && l.followup_variants.length) && !l.writing_job);
  nodes.push(el('p', { class: 'hint', text: 'Sent ' + FU_DAYS[ch][0] + '+ days ago with no reply. Two follow-ups at most, each with something new in it. Non-ICP people get none.' }));
  if (need.length) {
    nodes.push(el('button', { class: 'btn primary block', text: '✍ Write ' + need.length + ' follow-up' + (need.length === 1 ? '' : 's') + ' with Claude', onclick: async (e) => {
      const done = busy2(e.target);
      try { const r = await api('/api/dm/followup', { ids: need.map((l) => l.id) }); toast('Claude is writing ' + r.leads + '. Takes a few minutes.'); await refresh(); }
      catch (err) { toast(err.message, true); }
      done();
    } }));
  }
  nodes.push(...due.map(followupCard));
}

/* -- list view: filters, then select several and act on them together -- */
const LIST_FILTERS = {
  message: [['all', 'All'], ['msg', 'Has message'], ['nomsg', 'No message yet'], ['edited', 'Edited'], ['t0', 'This week'], ['t1', 'Next batch'], ['t2', 'Later']],
  connect: [['all', 'All'], ['t0', 'This week'], ['t1', 'Next batch'], ['t2', 'Later']],
};
function passesKey(f) {
  return (l) => f === 'all' ? true
    : f === 'msg' ? !!(l.variants && l.variants.length) || !!l.library || typeof l.draft_text === 'string'
    : f === 'nomsg' ? !(l.variants && l.variants.length) && !l.library && typeof l.draft_text !== 'string'
    : f === 'edited' ? typeof l.draft_text === 'string'
    : f === 't2' ? tierRank(l.tier) >= 2
    : f[0] === 't' ? tierRank(l.tier) === Number(f.slice(1))
    : true;
}
function passes(mode) { return passesKey(li.filt[mode] || 'all'); }
/* Draws the filter chips. In select mode it also draws the whole list and
 * returns true. */
function listTools(mode, list, nodes) {
  if (!LIST_FILTERS[mode].some(([k]) => k === li.filt[mode])) li.filt[mode] = 'all';
  const row = el('div', { class: 'li-status' }, ...LIST_FILTERS[mode].map(([k, label]) => {
    const n = list.filter(passesKey(k)).length;
    return k !== 'all' && !n ? null : el('button', { class: 'pill-chip small' + (li.filt[mode] === k ? ' accent' : ''), text: label + ' ' + n,
      onclick: () => { li.filt[mode] = k; LS.set('li_filt_' + mode, k); renderDm('linkedin'); } });
  }), el('button', { class: 'pill-chip small' + (li.sel.on ? ' accent' : ''), text: li.sel.on ? 'Done selecting' : '☑ Select',
    onclick: () => { li.sel.on = !li.sel.on; li.sel.ids.clear(); if (li.sel.on) holdBack(); else releaseBack(); renderDm('linkedin'); } }));
  nodes.push(row);
  if (!li.sel.on) return false;
  const shown = list.filter(matches).filter(passes(mode));
  const live = new Set(shown.map((l) => l.id));
  [...li.sel.ids].forEach((id) => { if (!live.has(id)) li.sel.ids.delete(id); });
  const picked = shown.filter((l) => li.sel.ids.has(l.id));
  const all = picked.length === shown.length && shown.length > 0;
  const acts = [
    el('button', { class: 'pill-chip', text: all ? 'Select none' : 'Select all ' + shown.length,
      onclick: () => { li.sel.ids = new Set(all ? [] : shown.map((l) => l.id)); renderDm('linkedin'); } }),
    el('span', { class: 'spacer' }),
  ];
  const n = picked.length;
  if (n) {
    acts.push(el('button', { class: 'pill-chip warn', text: 'Skip ' + n, onclick: () => sheet('Skip ' + n + '?', [{ label: 'Skip ' + n, danger: true, run: () => bulkSkip(picked) }]) }));
    if (mode === 'message') {
      if (picked.some((l) => (l.variants && l.variants.length > 1) || libOf(l))) acts.push(el('button', { class: 'pill-chip', text: '🎲 Shuffle', onclick: (e) => shuffleAll(picked, e.target) }));
      const rs = picked.filter((l) => canResearch(l) && !l.writing_job);
      const pd = picked.filter((l) => isIcp(l) && pdfPending(l) && !l.report_requested);
      if (rs.length) acts.push(el('button', { class: 'pill-chip', text: '🔎 Research ' + rs.length, onclick: () => researchLeads(rs) }));
      if (pd.length) acts.push(el('button', { class: 'pill-chip', text: '📄 PDF ' + pd.length, onclick: () => requestPdf(pd) }));
      acts.push(el('button', { class: 'pill-chip', text: li.aud === 'icp' ? '→ Non-ICP' : '→ ICP',
        onclick: () => setIcp(picked, li.aud === 'icp' ? 'light' : 'founder') }));
    }
    acts.push(el('button', { class: 'pill-chip', text: '💤 Snooze', onclick: () => snoozeSheet(picked) }));
  }
  nodes.push(el('div', { class: 'view-row sel-bar' }, ...acts));
  nodes.push(...(shown.length ? shown.map((l) => {
    const on = li.sel.ids.has(l.id);
    return el('div', { class: 'card pickable row-pick' + (on ? ' picked' : ''), role: 'checkbox', 'aria-checked': String(on),
      onclick: () => { if (li.sel.ids.has(l.id)) li.sel.ids.delete(l.id); else li.sel.ids.add(l.id); renderDm('linkedin'); } },
      el('div', { class: 'who' }, el('span', { class: 'pick-box', text: on ? '✓' : '' }),
        el('div', { class: 'who-name' }, el('b', { text: l.name || '?' }),
          el('span', { text: [l.product, l.tier, typeof l.draft_text === 'string' ? 'edited' : null].filter(Boolean).join(' · ') }))));
  }) : [el('div', { class: 'empty', text: 'Nobody matches this filter.' })]));
  return true;
}
async function bulkSkip(list) {
  const prev = list.map((l) => ({ l, status: l.status }));
  let ok = 0;
  try { for (const l of list) { await dmSave(l, { status: 'skipped', reason: 'skipped on phone (bulk)' }, true); ok++; } }
  catch (e) { toast(e.message, true); }
  li.sel.on = false; li.sel.ids.clear();
  buildDmDefaults(); renderDm('linkedin'); updateDmBadges();
  toast('Skipped ' + ok, false, { label: 'Undo', run: async () => {
    try { for (const p of prev) await dmSave(p.l, { status: p.status }, true); buildDmDefaults(); renderDm('linkedin'); updateDmBadges(); toast('Undone'); }
    catch (e) { toast(e.message, true); }
  } });
}

/* -- panel -- */
function renderDm(ch, keepLinesOpenFor) {
  if (!anchoring.on) { anchoring.on = true; try { keepCard(() => renderDm(ch, keepLinesOpenFor)); } finally { anchoring.on = false; } return; }
  const root = $('dm-' + ch);
  if (!root) return;
  if (backGuard.on && !somethingOpen()) releaseBack();
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

  if (ch === 'x') nodes.push(goalBars('x'), ...statusChips('x', mode));
  else nodes.push(paceStrip(ch, mode));

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

  const ready = mine.filter((l) => l.status === 'ready' && !snoozed(l) && inCamp(l)).sort(byTier);
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
    if (needs.length) nodes.push(needsCard(ch, needs));
    const shuf = shuffleChip(writable);
    const zz = snoozeChip(mine.filter((l) => l.status === 'ready' && snoozed(l) && inCamp(l)));
    if (shuf || zz) nodes.push(el('div', { class: 'view-row' }, el('span', { class: 'spacer' }), zz, shuf));
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
    sentView(ch, sent, nodes);
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
[['goalLiConnect', 'goal_li_connect', 20], ['goalLiMsg', 'goal_li_message', 10], ['goalX', 'goal_x', 20], ['goalReplies', 'goal_replies', 5], ['goalPosts', 'goal_posts', 20],
  ['capX', 'cap_x', 20], ['capLi', 'cap_linkedin', 20], ['capConnect', 'cap_connect', 25], ['gapMin', 'gapmin', 1], ['gapMax', 'gapmax', 9]].forEach(([id, key, d]) => {
  $(id).value = LS.get(key, String(d));
  $(id).addEventListener('change', () => {
    const v = parseInt($(id).value, 10);
    if (Number.isFinite(v) && v >= 0) LS.set(key, String(v)); else $(id).value = LS.get(key, String(d));
    renderDmAll();
    renderReplies();
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

$('refreshBtn').addEventListener('click', () => { buzz(8); refresh(); if (currentTab() === 'scout') loadScout(); });

/* When the lists were last brought up to date, under the title. Offline it
 * says the app is showing the copy saved on this phone. */
function updatedText() {
  const n = $('updated');
  if (!n) return;
  const age = state.lastOk ? Math.round((Date.now() - state.lastOk) / 60000) : null;
  n.classList.toggle('off', !!state.offline);
  n.textContent = state.offline ? 'Offline · saved copy' + (age != null ? ' from ' + (age < 1 ? 'just now' : age + 'm ago') : '')
    : age == null || age < 1 ? '' : 'Updated ' + (age < 60 ? age + 'm' : Math.round(age / 60) + 'h') + ' ago';
}
setInterval(updatedText, 30000);

/* Pull down at the top of a list to refresh. */
(() => {
  const ptr = el('div', { class: 'ptr', 'aria-hidden': 'true' }, el('span', { class: 'ptr-ico', text: '↻' }));
  document.body.append(ptr);
  let y0 = null, pulled = 0;
  document.addEventListener('touchstart', (e) => {
    y0 = window.scrollY <= 0 && $('sheet').hidden && !/^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName) ? e.touches[0].clientY : null;
    pulled = 0;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    pulled = Math.max(0, e.touches[0].clientY - y0);
    if (window.scrollY > 0) { pulled = 0; }
    const d = Math.min(pulled, 110);
    ptr.style.transform = 'translate(-50%, ' + (d * 0.7) + 'px) rotate(' + (d * 3) + 'deg)';
    ptr.style.opacity = String(Math.min(1, d / 70));
    ptr.classList.toggle('ready', pulled > 80);
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (y0 == null) return;
    const go = pulled > 80;
    y0 = null;
    if (!go) { ptr.style.transform = ''; ptr.style.opacity = '0'; return; }
    buzz(10);
    ptr.classList.add('spinning');
    await refresh();
    if (currentTab() === 'scout') loadScout();
    ptr.classList.remove('spinning', 'ready'); ptr.style.transform = ''; ptr.style.opacity = '0';
  });
})();
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

/* -- notifications -- */
function b64uBytes(b64) {
  const raw = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function pushReg() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('This browser cannot show notifications from the app. On Android use Chrome, installed to the home screen.');
  return navigator.serviceWorker.ready;
}
async function pushShowState() {
  const box = $('pushState');
  try {
    const reg = await pushReg();
    const sub = await reg.pushManager.getSubscription();
    box.textContent = sub && Notification.permission === 'granted'
      ? 'On for this device. You get one when Claude finishes drafting, writing, follow-ups or Find more.'
      : Notification.permission === 'denied' ? 'Blocked for this site. Allow notifications in the browser\'s site settings, then tap Turn on.'
        : 'Off. Turn on to hear when Claude finishes drafting, writing messages or follow-ups, or Find more.';
  } catch (e) { box.textContent = e.message; }
}
async function pushOn(btn) {
  const done = busy(btn, '…');
  try {
    const reg = await pushReg();
    if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked. Allow them for this site in the browser settings.');
    const { key } = await api('/api/push/key');
    let sub = await reg.pushManager.getSubscription();
    // A subscription made for another server's key cannot be reused.
    if (sub && sub.options && sub.options.applicationServerKey) {
      const have = btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      if (have !== key) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(key) });
    try { await (await caches.open('sk-meta')).put('server', new Response(serverBase())); } catch { /* same-origin default */ }
    await api('/api/push/subscribe', { subscription: sub.toJSON(), device: /android/i.test(navigator.userAgent) ? 'phone' : 'computer' });
    toast('Notifications on');
  } catch (e) { toast(e.message, true); }
  done();
  pushShowState();
}
$('pushOn').addEventListener('click', (e) => pushOn(e.target));
$('tplBtn').addEventListener('click', () => openTemplates());
$('pushTest').addEventListener('click', async () => {
  try { const r = await api('/api/push/test', {}); toast(r.devices ? 'Sent to ' + r.devices + (r.devices === 1 ? ' device' : ' devices') : 'No device is subscribed yet. Tap Turn on first.', !r.devices); }
  catch (e) { toast(e.message, true); }
});
$('pushOff').addEventListener('click', async () => {
  try {
    const reg = await pushReg();
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await api('/api/push/subscribe', { subscription: sub.toJSON(), off: true }); await sub.unsubscribe(); }
    toast('Notifications off');
  } catch (e) { toast(e.message, true); }
  pushShowState();
});
pushShowState();
handleShareLaunch();
bootFromCache();
renderDmAll();
const startTab = LS.get('tab', 'replies');
showTab(startTab === 'settings' && LS.get('password') ? 'replies' : startTab);
refresh();
