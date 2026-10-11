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
 */
var DEFAULT_TAB = 'LinkedIn Outreach';
// payload key -> header text in row 1 (matched without case or spaces)
var COLS = {
  status: 'Status', company: 'Company', founder: 'Founder', linkedin: 'LinkedIn',
  request_sent: 'Request sent', connected: 'Connected', dm_sent: 'DM sent', replied: 'Replied',
  website: 'Website', notes: 'Notes', lead_id: 'Lead ID', group: 'Group'
};
// When a person is already in the sheet under another Lead ID, only these move.
var STATE_KEYS = ['status', 'request_sent', 'connected', 'dm_sent', 'replied'];

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

function doGet(e) {
  if (!authed_(e.parameter.token)) return out_({ error: 'wrong or missing token' });
  var sh = tab_(), h = header_(sh), last = sh.getLastRow();
  var rows = last > 1 ? sh.getRange(2, 1, last - 1, h.width).getDisplayValues() : [];
  var people = [];
  for (var i = 0; i < rows.length; i++) {
    var s = slug_(rows[i][h.at.linkedin]);
    if (s) people.push({ slug: s, status: rows[i][h.at.status], lead_id: rows[i][h.at.lead_id] });
  }
  return out_({ ok: true, rows: rows.length, people: people });
}

function doPost(e) {
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
      var keys = mine ? Object.keys(COLS) : STATE_KEYS;
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
