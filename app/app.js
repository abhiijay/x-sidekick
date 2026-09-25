/* X reply sidekick - Android PWA.
 * Talks only to the sidekick server (/api/*) with the app password.
 * SAFETY: never posts. "Copy + open" copies a draft and opens the post in the
 * X app; you paste and press Reply yourself.
 * All post text comes from X and is untrusted: it is only ever set via
 * textContent, never innerHTML.
 */
const $ = (id) => document.getElementById(id);
const LS = {
  get(k, d = '') { try { return localStorage.getItem('sk_' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sk_' + k, v); } catch { /* private mode */ } },
};

const state = { items: [], outreach: [], jobs: [], scout: null, pollTimer: null };

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
        // ngrok free plan shows a browser warning page unless this is sent.
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
      err.data = data;
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

/* ---------------- ui helpers ---------------- */

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid) n.append(kid);
  return n;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

function banner(msg, isErr = false) {
  const b = $('banner');
  if (!msg) { b.hidden = true; return; }
  b.textContent = msg;
  b.className = 'banner' + (isErr ? ' err' : '');
  b.hidden = false;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers that block the async clipboard API.
    const ta = el('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function ago(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T'));
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (!isFinite(m)) return '';
  if (m < 60) return m + 'm ago';
  if (m < 1440) return Math.round(m / 60) + 'h ago';
  return Math.round(m / 1440) + 'd ago';
}

function busy(btn, label) {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  return () => { btn.disabled = false; btn.textContent = prev; };
}

/* ---------------- tabs ---------------- */

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  $('scoutActions').hidden = name !== 'scout' || !hasScoutPicks();
  LS.set('tab', name);
  if (name === 'scout') loadScout();
  if (name === 'settings') renderJobs();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------------- load + render ---------------- */

async function refresh() {
  if (!LS.get('password')) {
    banner('Set the server URL and app password in Settings first.');
    showTab('settings');
    return;
  }
  try {
    const [h, q, o, j] = await Promise.all([api('/api/health'), api('/api/queue'), api('/api/outreach'), api('/api/jobs')]);
    state.items = q.items || [];
    state.outreach = o.items || [];
    state.jobs = j.jobs || [];
    $('counts').textContent = h.drafted + ' drafted · ' + h.queued + ' queued';
    const warn = [];
    if (!h.routine) warn.push('Claude routine not configured on the server (drafting disabled)');
    if (!h.armory) warn.push('Armory not configured (scout and tweet-text fetch disabled)');
    banner(warn.join('. '));
    renderReplies();
    renderOutreach();
    renderJobStrip();
    renderJobs();
    schedulePoll();
  } catch (e) {
    banner(e.status === 401 ? 'Wrong app password. Fix it in Settings.' : 'Server unreachable: ' + e.message, true);
  }
}

function activeJobs(kind) {
  return state.jobs.filter((j) => (!kind || j.kind === kind)
    && ['created', 'fired', 'working', 'fetching', 'scoring'].includes(j.status)
    && j.expires * 1000 > Date.now());
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  // Poll while Claude is working; otherwise stay quiet.
  if (activeJobs().length) state.pollTimer = setTimeout(async () => {
    await refresh();
    if (!$('scoutList').closest('[data-panel]').hidden) loadScout();
  }, 10000);
}

const STATUS_TEXT = {
  created: 'starting', fetching: 'fetching posts', scoring: 'Claude is scoring',
  fired: 'Claude session started', working: 'Claude is working', done: 'done', failed: 'failed',
};

function jobLine(j) {
  const line = el('div', {},
    el('b', { text: j.kind === 'draft' ? 'Drafting' : 'Scout' }),
    ' · ' + (STATUS_TEXT[j.status] || j.status) + (j.progress ? ' (' + j.progress + ')' : '') + ' · ' + ago(j.ts));
  if (j.session_url) {
    line.append(' · ', el('a', { href: j.session_url, target: '_blank', rel: 'noopener', text: 'open session' }));
  }
  if (j.error) line.append(el('div', { class: 'note', text: j.error }));
  if (j.report) line.append(el('div', { class: 'muted', text: j.report }));
  return line;
}

function renderJobStrip() {
  const strip = $('jobStrip');
  const recent = state.jobs.find((j) => j.kind === 'draft');
  const show = recent && (activeJobs('draft').length || (Date.now() - new Date(recent.ts.replace(' ', 'T')).getTime() < 3 * 3600e3));
  strip.hidden = !show;
  strip.replaceChildren();
  if (show) strip.append(jobLine(recent));
}

function renderJobs() {
  const list = $('jobsList');
  list.replaceChildren();
  if (!state.jobs.length) { list.append(el('div', { class: 'empty', text: 'No runs yet.' })); return; }
  for (const j of state.jobs.slice(0, 10)) list.append(el('div', { class: 'card small' }, jobLine(j)));
}

function postText(it) {
  return it.tweet_text || it.title || it.text || '';
}

function postUrl(it) {
  return it.tweet_url || it.url || '';
}

function textBlock(text) {
  const box = el('div', { class: 'post-text', text: text || '(text not fetched yet - Claude will fetch it)' });
  const wrap = el('div', {}, box);
  if ((text || '').length > 280) {
    const more = el('button', { class: 'more', text: 'show more', onclick: () => {
      box.classList.toggle('open');
      more.textContent = box.classList.contains('open') ? 'show less' : 'show more';
    } });
    wrap.append(more);
  }
  return wrap;
}

function itemHead(it) {
  const url = postUrl(it);
  return el('div', { class: 'item-head' },
    el('span', { text: (it.author || it.platform || 'post') + (it.author_followers ? ' · ' + it.author_followers + ' followers' : '') }),
    url ? el('a', { href: url, target: '_blank', rel: 'noopener', text: ago(it.ts) + ' ↗' }) : el('span', { text: ago(it.ts) }));
}

function renderReplies() {
  const drafted = state.items.filter((i) => i.status === 'drafted');
  const queued = state.items.filter((i) => i.status === 'queued');
  const done = state.items.filter((i) => i.status === 'posted' || i.status === 'skipped').slice(0, 30);

  $('draftedCount').textContent = drafted.length ? '(' + drafted.length + ')' : '';
  $('queuedCount').textContent = queued.length ? '(' + queued.length + ')' : '';
  $('draftAllBtn').disabled = !queued.length || activeJobs('draft').length > 0;

  const dl = $('draftedList');
  dl.replaceChildren();
  if (!drafted.length) dl.append(el('div', { class: 'empty', text: 'No drafts ready.' }));
  for (const it of drafted) dl.append(draftCard(it));

  const ql = $('queuedList');
  ql.replaceChildren();
  if (!queued.length) ql.append(el('div', { class: 'empty', text: 'Nothing queued. Share a post from the X app to add one.' }));
  for (const it of queued) {
    const card = el('div', { class: 'card' }, itemHead(it), textBlock(postText(it)));
    if (it.note) card.append(el('div', { class: 'note', text: 'note: ' + it.note }));
    if (it.agent_note) card.append(el('div', { class: 'note', text: 'Claude: ' + it.agent_note }));
    if (it.drafting_job) card.append(el('div', { class: 'small muted', text: 'Claude is drafting this…' }));
    card.append(el('div', { class: 'row' },
      el('button', { class: 'small-btn', text: 'draft just this', onclick: (e) => askDraft([it.id], e.target) }),
      el('button', { class: 'ghost small-btn', text: 'skip', onclick: () => setStatus(it, 'skipped') })));
    ql.append(card);
  }

  const dn = $('doneList');
  dn.replaceChildren();
  if (!done.length) dn.append(el('div', { class: 'empty', text: 'Nothing yet.' }));
  for (const it of done) {
    dn.append(el('div', { class: 'card small' }, itemHead(it),
      el('div', { class: 'muted', text: it.status + (it.posted_text ? ': ' + it.posted_text : '') }),
      el('div', { class: 'row' }, el('button', { class: 'ghost small-btn', text: 're-queue', onclick: () => setStatus(it, 'queued') }))));
  }
}

function draftCard(it) {
  const card = el('div', { class: 'card' }, itemHead(it), textBlock(postText(it)));
  if (it.note) card.append(el('div', { class: 'note', text: 'note: ' + it.note }));
  if (it.agent_note) card.append(el('div', { class: 'note', text: 'Claude: ' + it.agent_note }));

  const posted = el('textarea', { rows: 2, placeholder: 'the reply you actually posted (your edits feed voice learning)' });
  if (it.posted_text) { posted.value = it.posted_text; posted.dataset.dirty = '1'; }
  posted.addEventListener('input', () => { posted.dataset.dirty = '1'; });
  let chosen = typeof it.chosen_index === 'number' ? it.chosen_index : null;

  (it.drafts || []).forEach((d, idx) => {
    const box = el('div', { class: 'draft' + (chosen === idx ? ' chosen' : '') },
      el('div', { class: 'draft-text', text: d.text }),
      d.angle ? el('div', { class: 'draft-angle', text: d.angle }) : null);
    const pick = () => {
      chosen = idx;
      card.querySelectorAll('.draft').forEach((n, k) => n.classList.toggle('chosen', k === idx));
      if (!posted.dataset.dirty) posted.value = d.text;
    };
    const tid = it.tweet_id || ((postUrl(it).match(/status\/(\d+)/) || [])[1]);
    box.append(el('div', { class: 'row' },
      el('button', { class: 'primary small-btn', text: 'copy + open', onclick: async () => {
        pick();
        const ok = await copy(d.text);
        toast(ok ? 'Copied. Paste it in the reply box on X.' : 'Copy failed - long-press the text instead', !ok);
        if (postUrl(it)) window.open(postUrl(it), '_blank', 'noopener');
      } }),
      el('button', { class: 'small-btn', text: 'copy', onclick: async () => {
        pick();
        const ok = await copy(d.text);
        toast(ok ? 'Copied' : 'Copy failed', !ok);
      } }),
      tid ? el('button', { class: 'ghost small-btn', text: 'reply link', title: 'X reply intent with the text pre-filled (may ask you to log in inside the X app)', onclick: () => {
        pick();
        window.open('https://x.com/intent/post?in_reply_to=' + tid + '&text=' + encodeURIComponent(d.text), '_blank', 'noopener');
      } }) : null));
    card.append(box);
  });

  const ar = it.avery_reference;
  if (ar && (ar.example || ar.pattern)) {
    card.append(el('div', { class: 'avery' },
      el('div', {}, el('b', { text: 'Avery reference: ' }), ar.example || ''),
      ar.pattern ? el('div', { text: 'pattern: ' + ar.pattern }) : null,
      ar.template ? el('div', { text: 'shape: ' + ar.template }) : null));
  }

  card.append(el('div', { class: 'posted-wrap' },
    el('div', { class: 'label', text: 'final reply you posted' }), posted,
    el('div', { class: 'row' },
      el('button', { class: 'ok small-btn', text: 'mark posted', onclick: (e) => finish(it, 'posted', posted.value, chosen, e.target) }),
      el('button', { class: 'small-btn', text: 'save text', onclick: async (e) => {
        const done = busy(e.target, 'saving…');
        try { await api('/api/queue/update', { id: it.id, posted_text: posted.value }); toast('Saved'); }
        catch (err) { toast('Save failed: ' + err.message, true); }
        finally { done(); }
      } }),
      el('button', { class: 'ghost small-btn', text: 'skip', onclick: (e) => finish(it, 'skipped', null, null, e.target) }))));
  return card;
}

async function finish(it, status, postedText, chosen, btn) {
  const done = busy(btn, '…');
  try {
    const body = { id: it.id, status };
    if (typeof postedText === 'string') body.posted_text = postedText;
    if (typeof chosen === 'number') body.chosen_index = chosen;
    await api('/api/queue/update', body);
    toast(status === 'posted' ? 'Marked posted' : 'Skipped');
    await refresh();
  } catch (e) {
    toast('Failed: ' + e.message, true);
    done();
  }
}

async function setStatus(it, status) {
  try {
    await api('/api/queue/update', { id: it.id, status });
    await refresh();
  } catch (e) { toast('Failed: ' + e.message, true); }
}

async function askDraft(ids, btn) {
  const done = btn ? busy(btn, 'asking Claude…') : () => {};
  try {
    const r = await api('/api/draft', { ids, account: LS.get('account') });
    if (r.job && r.job.status === 'failed') toast(r.job.error || 'Claude run failed', true);
    else toast('Claude is drafting. This takes a few minutes.');
  } catch (e) { toast('Could not start Claude: ' + e.message, true); }
  done();
  await refresh();
}

$('draftAllBtn').addEventListener('click', (e) => askDraft(null, e.target));
$('clearDoneBtn').addEventListener('click', async () => {
  try { const r = await api('/api/queue/clear-done', {}); toast('Removed ' + r.removed); refresh(); }
  catch (e) { toast(e.message, true); }
});

/* ---------------- add / share ---------------- */

async function addLink(url, note, draft) {
  const r = await api('/api/share', { url, note });
  let msg;
  if (r.kind === 'outreach') msg = r.duplicate ? '@' + r.handle + ' already in outreach' : 'Added @' + r.handle + ' to outreach';
  else msg = r.duplicate ? 'Already in the queue' : 'Queued for reply';
  if (r.warning) msg += ' (' + r.warning + ')';
  if (draft && r.kind === 'reply' && r.id) {
    const d = await api('/api/draft', { ids: [r.id], account: LS.get('account') });
    msg += d.job && d.job.status === 'failed' ? ' - Claude failed: ' + d.job.error : ' - Claude is drafting';
  }
  return msg;
}

$('addBtn').addEventListener('click', async (e) => {
  const url = $('addUrl').value.trim();
  if (!url) return;
  const done = busy(e.target, '…');
  try { toast(await addLink(url, '', false)); $('addUrl').value = ''; await refresh(); }
  catch (err) { toast(err.message, true); }
  finally { done(); }
});

function handleShareLaunch() {
  if (!location.pathname.startsWith('/app/share')) return;
  const p = new URLSearchParams(location.search);
  // X's share puts the link in `text` (sometimes with extra words), not `url`.
  const raw = [p.get('url'), p.get('text'), p.get('title')].filter(Boolean).join(' ');
  const m = raw.match(/https?:\/\/\S+/);
  const url = m ? m[0] : '';
  history.replaceState(null, '', '/app/');
  const sheet = $('shareSheet');
  sheet.hidden = false;
  $('shareUrl').textContent = url || raw || '(nothing shared)';
  const isProfile = url && !/\/status\//.test(url);
  $('shareQueue').textContent = isProfile ? 'Add to outreach' : 'Queue for reply';
  $('shareQueueDraft').hidden = !!isProfile;
  const go = async (draft, btn) => {
    const done = busy(btn, '…');
    try {
      $('shareResult').textContent = await addLink(url, $('shareNote').value.trim(), draft);
      setTimeout(() => { sheet.hidden = true; }, 1800);
      await refresh();
    } catch (e) { $('shareResult').textContent = 'Failed: ' + e.message; }
    finally { done(); }
  };
  $('shareQueue').onclick = (e) => go(false, e.target);
  $('shareQueueDraft').onclick = (e) => go(true, e.target);
  $('shareCancel').onclick = () => { sheet.hidden = true; };
}

/* ---------------- scout ---------------- */

function hasScoutPicks() {
  return document.querySelectorAll('#scoutList input[type=checkbox]:checked').length > 0;
}

async function loadScout() {
  try {
    const r = await api('/api/scout');
    state.scout = r;
    renderScout();
    if (r.job && ['created', 'fetching', 'scoring', 'fired', 'working'].includes(r.job.status)) {
      clearTimeout(state.scoutTimer);
      state.scoutTimer = setTimeout(loadScout, 10000);
    }
  } catch (e) { $('scoutStatus').textContent = e.message; }
}

function renderScout() {
  const { run, job } = state.scout || {};
  const status = $('scoutStatus');
  status.replaceChildren();
  if (job) status.append(jobLine(job));
  if (run && run.credits_remaining != null) status.append(el('div', { class: 'muted', text: 'Armory credits left: ' + run.credits_remaining }));
  if (run && run.errors && run.errors.length) status.append(el('div', { class: 'note', text: run.errors.join(' | ') }));
  const running = job && ['created', 'fetching', 'scoring', 'fired', 'working'].includes(job.status);
  $('scoutBtn').disabled = !!running;

  const rep = $('scoutReport');
  rep.hidden = !(run && run.report);
  rep.textContent = run && run.report ? run.report : '';

  const list = $('scoutList');
  const checked = new Set([...list.querySelectorAll('input:checked')].map((c) => c.value));
  list.replaceChildren();
  if (!run) { list.append(el('div', { class: 'empty', text: 'No scout run yet.' })); return; }
  const rows = run.shortlist && run.shortlist.length ? run.shortlist : run.candidates || [];
  if (run.shortlist && run.shortlist.length) list.append(el('h2', { text: 'Shortlist (' + rows.length + ')' }));
  else if (rows.length) list.append(el('h2', { text: 'Raw candidates (' + rows.length + ')', class: '' }),
    el('div', { class: 'small muted', text: running ? 'Claude has not scored these yet.' : 'Not scored by Claude.' }));
  for (const c of rows) {
    const cb = el('input', { type: 'checkbox', value: c.url });
    cb.checked = checked.has(c.url);
    cb.addEventListener('change', () => { $('scoutActions').hidden = !hasScoutPicks(); });
    const body = el('div', { class: 'scout-body' },
      el('div', { class: 'item-head' },
        el('span', { text: '@' + String(c.author).replace(/^@/, '') + (c.author_followers ? ' · ' + c.author_followers : '') }),
        el('a', { href: c.url, target: '_blank', rel: 'noopener', text: c.age_hours + 'h ↗' })),
      el('div', { class: 'metrics', text: [c.replies != null ? c.replies + ' replies' : '', c.likes != null ? c.likes + ' likes' : '', c.views != null ? c.views + ' views' : '', c.score != null ? 'score ' + c.score : ''].filter(Boolean).join(' · ') }),
      c.summary ? el('div', { class: 'small', text: c.summary }) : null,
      textBlock(c.text),
      c.suggested_move ? el('span', { class: 'move', text: c.suggested_move }) : null,
      c.why ? el('div', { class: 'small muted', text: c.why }) : null,
      c.reply_signal ? el('div', { class: 'small muted', text: 'signal: ' + c.reply_signal }) : null);
    list.append(el('label', { class: 'card scout-item' }, cb, body));
  }
  $('scoutActions').hidden = !hasScoutPicks();
}

$('scoutBtn').addEventListener('click', async (e) => {
  const done = busy(e.target, 'starting…');
  try { await api('/api/scout', {}); toast('Scout started'); }
  catch (err) { toast(err.message, true); }
  done();
  loadScout();
});

async function pickScout(draft, btn) {
  const urls = [...document.querySelectorAll('#scoutList input:checked')].map((c) => c.value);
  if (!urls.length) return;
  const done = busy(btn, '…');
  try {
    const r = await api('/api/scout/pick', { run_id: state.scout.run.id, urls, draft, account: LS.get('account') });
    let msg = 'Queued ' + r.added + ' new';
    if (draft) msg += r.draft_error ? ' - draft failed: ' + r.draft_error : ' - Claude is drafting';
    toast(msg, !!r.draft_error);
    document.querySelectorAll('#scoutList input:checked').forEach((c) => { c.checked = false; });
    $('scoutActions').hidden = true;
    await refresh();
  } catch (e) { toast(e.message, true); }
  finally { done(); }
}
$('scoutPickDraft').addEventListener('click', (e) => pickScout(true, e.target));
$('scoutPick').addEventListener('click', (e) => pickScout(false, e.target));

/* ---------------- outreach ---------------- */

function renderOutreach() {
  const list = $('outreachList');
  list.replaceChildren();
  const rows = state.outreach.filter((o) => o.status === 'queued');
  if (!rows.length) { list.append(el('div', { class: 'empty', text: 'No profiles queued.' })); return; }
  for (const o of rows) {
    list.append(el('div', { class: 'card small' },
      el('div', { class: 'item-head' },
        el('b', { text: '@' + o.handle + (o.display_name ? ' · ' + o.display_name : '') }),
        el('a', { href: o.profile_url, target: '_blank', rel: 'noopener', text: ago(o.ts) + ' ↗' })),
      o.bio ? el('div', { text: o.bio }) : null,
      el('div', { class: 'muted', text: [o.followers_text, o.source].filter(Boolean).join(' · ') })));
  }
}

/* ---------------- settings ---------------- */

$('serverUrl').value = LS.get('server');
$('password').value = LS.get('password');
$('account').value = LS.get('account');
$('account').addEventListener('change', () => LS.set('account', $('account').value));

$('saveSettings').addEventListener('click', async (e) => {
  LS.set('server', $('serverUrl').value.trim());
  LS.set('password', $('password').value);
  LS.set('account', $('account').value);
  const done = busy(e.target, 'testing…');
  const out = $('settingsResult');
  try {
    const h = await api('/api/health');
    out.textContent = 'Connected. Armory: ' + (h.armory ? 'on' : 'off') + ' · Claude routine: ' + (h.routine ? 'on' : 'off') + ' · watchlist: ' + h.watchlist + ' accounts';
    await refresh();
  } catch (err) {
    out.textContent = err.status === 401 ? 'Wrong password.' : 'Failed: ' + err.message;
  }
  done();
});

$('refreshBtn').addEventListener('click', () => { refresh(); if (!document.querySelector('[data-panel=scout]').hidden) loadScout(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

/* ---------------- boot ---------------- */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { scope: '/app/' }).catch(() => {});
}
handleShareLaunch();
showTab(LS.get('tab', 'replies') === 'settings' && LS.get('password') ? 'replies' : LS.get('tab', 'replies'));
refresh();
