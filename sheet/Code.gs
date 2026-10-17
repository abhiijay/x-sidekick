/**
 * Sidekick -> Google Sheet bridge (LinkedIn people only).
 *
 * The sidekick server posts every LinkedIn lead and each status change here,
 * and this script writes them into one tab of the spreadsheet it is attached to.
 * Nothing is ever deleted and an empty value never overwrites a filled cell.
 *
 * Setup (once): Extensions > Apps Script, paste this file, then
 *   Project Settings > Script properties: TOKEN = a long random string
 *                                         TAB   = LinkedIn Outreach   (optional)
 *   Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone
 * Put the web app URL and the same token in the sidekick's server/.env.
 *
 * Find more also reads people nobody has taken yet from here (?pool=1): rows
 * of this tab with an empty Sender, and founders on the Leads tab who are not
 * in this tab at all. When the sidekick adds one, its next post fills the
 * empty Sender with that device's code (a1, a2, k1, k2). A Sender that is
 * already filled is never changed.
 * After pasting a new version: Deploy > Manage deployments > edit > New version.
 */
var DEFAULT_TAB = 'LinkedIn Outreach';
// payload key -> header text in row 1 (matched without case or spaces)
var COLS = {
  status: 'Status', company: 'Company', founder: 'Founder', linkedin: 'LinkedIn', sender: 'Sender',
  request_sent: 'Request sent', connected: 'Connected', dm_sent: 'DM sent', replied: 'Replied',
  website: 'Website', notes: 'Notes', lead_id: 'Lead ID', group: 'Group'
};
// When a person is already in the sheet under another Lead ID, only these move.
var STATE_KEYS = ['status', 'request_sent', 'connected', 'dm_sent', 'replied'];
var LEADS_TAB = 'Leads';

function norm_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function slug_(url) {
  var m = String(url || '').match(/linkedin\.com\/in\/([^\/?#\s]+)/i);
  if (!m) return '';
  var s = m[1];
  try { s = decodeURIComponent(s); } catch (e) {}
  return s.toLowerCase();
}

function props_() { return PropertiesService.getScriptProperties(); }

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function tab_() {
  var name = props_().getProperty('TAB') || DEFAULT_TAB;
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('no tab named ' + name);
  return sh;
}

function header_(sh) {
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
  var at = {};
  for (var k in COLS) {
    var i = head.map(norm_).indexOf(norm_(COLS[k]));
    if (i < 0) throw new Error('column missing: ' + COLS[k]);
    at[k] = i;
  }
  return { at: at, width: head.length };
}

function authed_(token) {
  var want = props_().getProperty('TOKEN');
  return !!want && token === want;
}

/* People nobody has taken: this tab with an empty Sender, then the Leads tab. */
function pool_(sh, h, rows) {
  var out = [], seen = {};
  for (var i = 0; i < rows.length; i++) {
    var s = slug_(rows[i][h.at.linkedin]);
    if (s) seen[s] = true;
    if (!s || rows[i][h.at.sender] || /stopped/i.test(rows[i][h.at.status])) continue;
    out.push({ slug: s, linkedin: rows[i][h.at.linkedin], company: rows[i][h.at.company], founder: rows[i][h.at.founder],
      website: rows[i][h.at.website], notes: rows[i][h.at.notes], sheet_id: rows[i][h.at.lead_id], from: 'LinkedIn Outreach' });
  }
  var lt = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LEADS_TAB);
  if (!lt || lt.getLastRow() < 2) return out;
  var head = lt.getRange(1, 1, 1, lt.getLastColumn()).getDisplayValues()[0];
  var col = function (name) { return head.indexOf(name); };
  var c = { id: col('id'), company: col('company'), website: col('website'), desc: col('description'), name: col('contact_name'),
    role: col('contact_role'), li: col('contact_linkedin'), rev: col('revenue_amount_usd'), metric: col('revenue_metric'), cat: col('category') };
  if (c.li < 0) return out;
  var data = lt.getRange(2, 1, lt.getLastRow() - 1, head.length).getDisplayValues();
  for (var j = 0; j < data.length; j++) {
    var r = data[j], s2 = slug_(r[c.li]);
    if (!s2 || seen[s2]) continue;
    seen[s2] = true;
    out.push({ slug: s2, linkedin: r[c.li], company: r[c.company], founder: r[c.name], role: c.role >= 0 ? r[c.role] : '',
      website: r[c.website], description: c.desc >= 0 ? r[c.desc] : '', revenue: c.rev >= 0 ? r[c.rev] : '',
      revenue_metric: c.metric >= 0 ? r[c.metric] : '', category: c.cat >= 0 ? r[c.cat] : '', sheet_id: r[c.id], from: 'Leads' });
  }
  return out;
}

/* Run THIS one from the editor (pick checkSetup next to Run) to test the
 * setup: the token, the tab and its columns, and how many free people the
 * Leads tab holds. doGet and doPost only work when the sidekick calls them. */
function checkSetup() {
  if (!props_().getProperty('TOKEN')) throw new Error('No TOKEN yet: Project Settings > Script properties > add TOKEN.');
  var sh = tab_(), h = header_(sh), last = sh.getLastRow();
  var rows = last > 1 ? sh.getRange(2, 1, last - 1, h.width).getDisplayValues() : [];
  var free = pool_(sh, h, rows);
  Logger.log('OK. TOKEN is set. Tab "' + sh.getName() + '" has ' + rows.length + ' rows and every column the sidekick needs. '
    + free.length + ' people are free to take. Now: Deploy > New deployment > Web app.');
}

function doGet(e) {
  if (!e || !e.parameter) return out_({ error: 'doGet runs when the sidekick calls the web app. To test in the editor, run checkSetup.' });
  if (!authed_(e.parameter.token)) return out_({ error: 'wrong or missing token' });
  var sh = tab_(), h = header_(sh), last = sh.getLastRow();
  var rows = last > 1 ? sh.getRange(2, 1, last - 1, h.width).getDisplayValues() : [];
  if (e.parameter.pool) return out_({ ok: true, pool: pool_(sh, h, rows) });
  var people = [];
  for (var i = 0; i < rows.length; i++) {
    var s = slug_(rows[i][h.at.linkedin]);
    if (s) people.push({ slug: s, status: rows[i][h.at.status], lead_id: rows[i][h.at.lead_id] });
  }
  return out_({ ok: true, rows: rows.length, people: people });
}

function doPost(e) {
  if (!e || !e.postData) return out_({ error: 'doPost runs when the sidekick calls the web app. To test in the editor, run checkSetup.' });
  var body = JSON.parse(e.postData.contents || '{}');
  if (!authed_(body.token)) return out_({ error: 'wrong or missing token' });
  var incoming = body.rows || [];
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var sh = tab_(), h = header_(sh), last = sh.getLastRow();
    var range = last > 1 ? sh.getRange(2, 1, last - 1, h.width) : null;
    var rows = range ? range.getDisplayValues() : [];
    var byId = {}, bySlug = {};
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i][h.at.lead_id], s = slug_(rows[i][h.at.linkedin]);
      if (id) byId[id] = i;
      if (s && !(s in bySlug)) bySlug[s] = i;
    }
    var cells = [], added = [], updated = 0, same = 0;
    for (var n = 0; n < incoming.length; n++) {
      var r = incoming[n], s2 = slug_(r.linkedin);
      if (!r.lead_id || !s2) continue;
      var idx = (r.lead_id in byId) ? byId[r.lead_id] : (s2 in bySlug ? bySlug[s2] : -1);
      if (idx < 0) {
        var fresh = [];
        for (var c = 0; c < h.width; c++) fresh.push('');
        for (var k in COLS) fresh[h.at[k]] = r[k] || '';
        added.push(fresh);
        byId[r.lead_id] = bySlug[s2] = rows.length + added.length - 1;
        continue;
      }
      if (idx >= rows.length) {               // same person twice in one post
        var f2 = added[idx - rows.length];
        for (var k2 in COLS) if (r[k2]) f2[h.at[k2]] = r[k2];
        continue;
      }
      var mine = rows[idx][h.at.lead_id] === r.lead_id;
      var keys = mine ? Object.keys(COLS) : STATE_KEYS.slice();
      // Taking a person from the sheet: an empty Sender gets this device's
      // code. A filled Sender (k1, k2, a1, a2) is never overwritten.
      if (!mine && !rows[idx][h.at.sender] && r.sender) keys.push('sender');
      var changed = false;
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j], v = r[key];
        if (v && rows[idx][h.at[key]] !== v) {
          rows[idx][h.at[key]] = v;
          cells.push([idx + 2, h.at[key] + 1, v]);      // one cell at a time: never rewrites a formula beside it
          changed = true;
        }
      }
      if (changed) updated++; else same++;
    }
    for (var t = 0; t < cells.length; t++) sh.getRange(cells[t][0], cells[t][1]).setValue(cells[t][2]);
    if (added.length) sh.getRange(rows.length + 2, 1, added.length, h.width).setValues(added);
    return out_({ ok: true, added: added.length, updated: updated, unchanged: same });
  } finally {
    lock.releaseLock();
  }
}
