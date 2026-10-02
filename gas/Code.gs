/**
 * Chatwork → スプレッドシート 自動転記 ＋ Toメンション一覧API
 *
 * 既存の転記スクリプトを、このファイルの内容で丸ごと置き換えてください。
 * （転記の仕組みはそのままで、「送信者ID」列の追加とAPIの追加だけが変更点です）
 *
 * 【追加の設定】
 * 1. スクリプトプロパティに API_KEY を追加（値は長めのランダムな文字列。関数 makeApiKey を実行すると作れます）
 * 2. 「デプロイ > 新しいデプロイ > 種類：ウェブアプリ」
 *      次のユーザーとして実行：自分 / アクセスできるユーザー：全員
 *    → 表示された「ウェブアプリのURL」を、ToタスクのWeb画面の設定に入力します
 */

// ===== 設定 =====
const SHEET_NAME = 'ログ';
const TARGET_ROOM_IDS = [];   // 空なら参加中の全ルーム。絞るなら [123456789, 987654321] のように
const INTERVAL_MINUTES = 5;   // 1, 5, 10, 15, 30 のいずれか
const TIMEZONE = 'Asia/Tokyo';
const API_DEFAULT_DAYS = 60;  // APIが返す期間（日）
const JUDGE_FOLDER_NAME = 'Toタスク判定'; // Claudeの「要返信」判定を置くドライブのフォルダ
// 共有リンク（SHARE_KEY）で見せるルーム。ここにないルームは共有リンクでは見えない
const SHARE_ROOM_IDS = ['421916562']; // 【共通適性テスト添削】ミショナ
const PAGE_URL = 'https://ytwg66z59b-wq.github.io/chatwork-to-tasks/';
// ================

const API_BASE = 'https://api.chatwork.com/v2';
const HEADERS = ['日時', 'ルーム名', '送信者', '本文', 'message_id', 'room_id', '更新日時', '送信者ID'];

/* ------------------------------------------------------------------ */
/* 転記                                                                 */
/* ------------------------------------------------------------------ */

/** 初回セットアップ：シート作成・定期実行トリガー登録・初回取得 */
function setup() {
  getToken_();
  getSheet_();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'fetchMessages')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('fetchMessages').timeBased().everyMinutes(INTERVAL_MINUTES).create();
  PropertiesService.getScriptProperties().deleteProperty('LAST_RUN');
  fetchMessages();
}

/** 新着メッセージを取得してシートに追記（トリガーから定期実行） */
function fetchMessages() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const lastRun = Number(props.getProperty('LAST_RUN') || 0);
    const startedAt = Math.floor(Date.now() / 1000);

    const roomsRes = cwGet_('/rooms');
    if (roomsRes.code !== 200) throw new Error('ルーム一覧の取得に失敗: ' + roomsRes.code + ' ' + roomsRes.text);

    const rooms = roomsRes.data.filter(r =>
      (TARGET_ROOM_IDS.length === 0 || TARGET_ROOM_IDS.includes(r.room_id)) &&
      (lastRun === 0 || r.last_update_time >= lastRun - 120)
    );

    const collected = [];
    let rateLimited = false;
    for (const room of rooms) {
      const res = cwGet_('/rooms/' + room.room_id + '/messages?force=0');
      if (res.code === 204) continue;
      if (res.code === 429) { rateLimited = true; break; }
      if (res.code !== 200) { console.warn(room.name + ': ' + res.code + ' ' + res.text); continue; }
      res.data.forEach(m => collected.push({ room: room, m: m }));
    }

    if (collected.length > 0) writeRows_(collected);
    if (!rateLimited) props.setProperty('LAST_RUN', String(startedAt));
    if (rateLimited) console.warn('APIの回数制限に達したため、残りは次回に取得します');
  } finally {
    lock.releaseLock();
  }
}

/** シートに書き込み。既にあるmessage_id（編集されたメッセージ）は上書き */
function writeRows_(items) {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  const idToRow = {};
  if (lastRow > 1) {
    sheet.getRange(2, 5, lastRow - 1, 1).getValues()
      .forEach((v, i) => { idToRow[String(v[0])] = i + 2; });
  }

  items.sort((a, b) => a.m.send_time - b.m.send_time);
  const newRows = [];
  for (const { room, m } of items) {
    const row = [
      new Date(m.send_time * 1000),
      room.name,
      m.account ? m.account.name : '',
      m.body,
      String(m.message_id),
      String(room.room_id),
      m.update_time ? new Date(m.update_time * 1000) : '',
      m.account ? String(m.account.account_id) : ''
    ];
    const existing = idToRow[String(m.message_id)];
    if (existing) {
      sheet.getRange(existing, 1, 1, row.length).setValues([row]);
    } else {
      newRows.push(row);
    }
  }
  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, HEADERS.length).setValues(newRows);
  }
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    ss.setSpreadsheetTimeZone(TIMEZONE);
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('yyyy/MM/dd HH:mm:ss');
    sheet.getRange('G:G').setNumberFormat('yyyy/MM/dd HH:mm:ss');
    sheet.getRange('E:F').setNumberFormat('@');
    sheet.getRange('H:H').setNumberFormat('@');
    sheet.setColumnWidth(4, 500);
  } else if (sheet.getRange(1, HEADERS.length).getValue() !== HEADERS[HEADERS.length - 1]) {
    // 旧バージョンのシートに「送信者ID」列を追加
    sheet.getRange(1, HEADERS.length).setValue(HEADERS[HEADERS.length - 1]).setFontWeight('bold');
    sheet.getRange('H:H').setNumberFormat('@');
  }
  return sheet;
}

function getToken_() {
  const token = PropertiesService.getScriptProperties().getProperty('CHATWORK_API_TOKEN');
  if (!token) throw new Error('スクリプトプロパティ CHATWORK_API_TOKEN を設定してください');
  return token;
}

function cwGet_(path) {
  const res = UrlFetchApp.fetch(API_BASE + path, {
    method: 'get',
    headers: { 'X-ChatWorkToken': getToken_() },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  return { code: code, text: text, data: code === 200 ? JSON.parse(text) : null };
}

/** 定期実行を止めたいときに実行 */
function stop() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'fetchMessages')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/* ------------------------------------------------------------------ */
/* Toメンション一覧API                                                    */
/* ------------------------------------------------------------------ */

/** API_KEY を作ってスクリプトプロパティに保存し、ログに表示する（1回だけ実行） */
function makeApiKey() {
  const key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('API_KEY', key);
  console.log('API_KEY: ' + key);
  return key;
}

/**
 * みんなに配る共有リンクを作って実行ログに表示する（1回だけ実行）。
 * 共有リンクで見えるのは SHARE_ROOM_IDS のルームだけ。
 * リンクを止めたいときは、スクリプトプロパティの SHARE_KEY を削除するか、もう一度実行して作り直す。
 */
function makeShareLink() {
  const props = PropertiesService.getScriptProperties();
  const key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperty('SHARE_KEY', key);
  // ウェブアプリのURL：スクリプトプロパティ WEB_APP_URL があればそれを優先
  let execUrl = props.getProperty('WEB_APP_URL') || ScriptApp.getService().getUrl() || '';
  if (!/\/exec$/.test(execUrl)) {
    throw new Error('ウェブアプリのURL（…/exec）が取得できませんでした。スクリプトプロパティ WEB_APP_URL に、デプロイで表示されたURLを入れてからもう一度実行してください');
  }
  const link = PAGE_URL + '#api=' + encodeURIComponent(execUrl) + '&key=' + key;
  console.log('共有リンク: ' + link);
  return link;
}

/** Web画面から呼ばれる。?key=...&days=60 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('API_KEY');
  const shareKey = props.getProperty('SHARE_KEY');
  if (!apiKey) return json_({ ok: false, error: 'API_KEY が未設定です（makeApiKey を実行してください）' });
  const shared = !!shareKey && p.key === shareKey;
  if (p.key !== apiKey && !shared) return json_({ ok: false, error: 'キーが違います' });

  const days = Math.min(Math.max(Number(p.days) || API_DEFAULT_DAYS, 1), 365);
  const cacheKey = 'tasks_' + days + (shared ? '_shared' : '');
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached && p.nocache !== '1') return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);

  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    const last = sheet.getLastRow();
    const values = last > 1 ? sheet.getRange(2, 1, last - 1, HEADERS.length).getValues() : [];
    const rows = values
      .filter(v => v[1] && v[4])
      .filter(v => !shared || SHARE_ROOM_IDS.indexOf(String(v[5])) >= 0)
      .map(v => ({
        time: v[0] instanceof Date ? v[0].getTime() : new Date(v[0]).getTime(),
        roomName: String(v[1]),
        sender: String(v[2] || ''),
        body: String(v[3] || ''),
        messageId: String(v[4]),
        roomId: String(v[5]),
        senderId: String(v[7] || '')
      }));
    const result = buildTasks(rows, { me: shared ? { id: '', name: '' } : getMe_(), sinceMs: Date.now() - days * 86400000 });
    if (shared) result.shared = true;
    // Claudeの「要返信」判定（Googleドライブの Toタスク判定 フォルダ）を付ける
    const judged = loadJudgments_();
    if (judged) {
      result.judgedAt = judged.updatedAt;
      result.tasks.forEach(t => {
        const a = judged.j[t.id];
        if (a) t.ai = { needsReply: !!a[0], answered: !!a[1], reason: a[2] || '', maybe: !!a[4] };
      });
    }
    result.ok = true;
    const text = JSON.stringify(result);
    if (text.length < 95000) cache.put(cacheKey, text, 60);
    return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/** Toタスク判定フォルダの一番新しい to-judgments-*.json を読む（なければ null） */
function loadJudgments_() {
  try {
    const folders = DriveApp.getFoldersByName(JUDGE_FOLDER_NAME);
    if (!folders.hasNext()) return null;
    const files = folders.next().getFiles();
    let latest = null;
    while (files.hasNext()) {
      const f = files.next();
      if (f.isTrashed() || !/^to-judgments-.*\.json$/.test(f.getName())) continue;
      if (!latest || f.getName() > latest.getName()) latest = f;
    }
    if (!latest) return null;
    const data = JSON.parse(latest.getBlob().getDataAsString('UTF-8'));
    if (data.v === 2) return { updatedAt: data.u, j: data.j };
    return null;
  } catch (err) {
    console.warn('判定ファイルを読めませんでした: ' + err);
    return null;
  }
}

/** 権限の承認用：一度だけ実行して、判定ファイルが読めるか確認する */
function testJudgments() {
  const r = loadJudgments_();
  console.log(r ? ('判定 ' + Object.keys(r.j).length + ' 件（更新 ' + new Date(r.updatedAt) + '）') : '判定ファイルが見つかりません');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 自分のアカウント（ChatworkのAPIトークンの持ち主）。1日キャッシュ */
function getMe_() {
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('ME_JSON');
  if (saved) {
    const me = JSON.parse(saved);
    if (Date.now() - (me.savedAt || 0) < 86400000) return me;
  }
  const res = cwGet_('/me');
  if (res.code !== 200) throw new Error('/me の取得に失敗: ' + res.code);
  const me = { id: String(res.data.account_id), name: res.data.name, savedAt: Date.now() };
  props.setProperty('ME_JSON', JSON.stringify(me));
  return me;
}

/* ------------------------------------------------------------------ */
/* To抽出・完了判定（GASに依存しない純粋な関数）                               */
/* ------------------------------------------------------------------ */

/** 名前の比較用：肩書き・括弧・稼働メモを外し、空白を詰める */
function baseName(name) {
  let s = String(name || '');
  s = s.replace(/[（(【\[「][^）)】\]」]*[）)】\]」]/g, ' ');
  s = s.split(/[｜|／\/]/)[0];
  const tokens = s.trim().split(/[\s　]+/);
  const kept = [];
  for (const t of tokens) {
    if (!t) continue;
    if (/[0-9０-９:：,，~～\-－]/.test(t) && kept.length > 0) break;
    kept.push(t);
  }
  return kept.join('').replace(/さん$/, '');
}

/** 本文のChatwork記法を読みやすいテキストにする */
function cleanBody(body) {
  return String(body || '')
    .replace(/\[qt\][\s\S]*?\[\/qt\]/g, '')
    .replace(/\[(To|rp|piconname|picon|preview|download)[^\]]*\]/g, '')
    .replace(/\[\/download\]/g, '')
    .replace(/\[info\]\[title\]\[dtext:file_uploaded\]\[\/title\]/g, '📎 ')
    .replace(/\[dtext:[^\]]*\]/g, '')
    .replace(/\[\/?(info|title|code|hr|toall|qtmeta[^\]]*)\]/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 宛名テキスト（[To:123]の直後）から名前を取り出す */
function nameAfterTag_(text) {
  const line = String(text || '').split('\n')[0];
  const idx = line.indexOf('さん');
  const name = (idx >= 0 ? line.slice(0, idx) : line).trim();
  return name.slice(0, 60);
}

/**
 * rows: [{time, roomName, sender, body, messageId, roomId, senderId}]
 * opts: { me: {id, name}, sinceMs }
 */
function buildTasks(rows, opts) {
  const me = (opts && opts.me) || { id: '', name: '' };
  const sinceMs = (opts && opts.sinceMs) || 0;
  rows = rows.slice().sort((a, b) => a.time - b.time);

  // 1. アカウントID ⇔ 名前 の対応表を作る
  const idToName = {};       // id -> 表示名
  const baseToId = {};       // baseName -> id
  const setName = (id, name, strong) => {
    if (!id || !name) return;
    if (strong || !idToName[id]) idToName[id] = name;
    const b = baseName(name);
    if (b) baseToId[b] = id;
  };
  if (me.id) setName(me.id, me.name, true);
  const tagRe = /\[(?:To:(\d+)|rp aid=(\d+) to=\d+-\d+)\]([^\[\n]*)/g;
  for (const r of rows) {
    let m;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(r.body))) setName(m[1] || m[2], nameAfterTag_(m[3]), false);
  }
  for (const r of rows) if (r.senderId) setName(r.senderId, r.sender, true);

  const senderIdOf = r => r.senderId || baseToId[baseName(r.sender)] || '';

  // 2. 返信（RE）の索引：「room-message」→ そのメッセージに返信した人のID一覧
  const replies = {};
  const rpRe = /\[rp aid=\d+ to=(\d+)-(\d+)\]/g;
  for (const r of rows) {
    const sid = senderIdOf(r);
    if (!sid) continue;
    let m;
    rpRe.lastIndex = 0;
    while ((m = rpRe.exec(r.body))) {
      const k = m[1] + '-' + m[2];
      (replies[k] = replies[k] || []).push({ by: sid, time: r.time, messageId: r.messageId, roomId: r.roomId });
    }
  }

  // 2b. REを使わずに「To」で相手に返した場合の索引：room -> [{by, to, time, messageId}]
  const toBacks = {};
  const toBackRe = /\[To:(\d+)\]/g;
  for (const r of rows) {
    const sid = senderIdOf(r);
    if (!sid) continue;
    let m;
    toBackRe.lastIndex = 0;
    while ((m = toBackRe.exec(r.body))) {
      (toBacks[r.roomId] = toBacks[r.roomId] || []).push({ by: sid, to: m[1], time: r.time, messageId: r.messageId, roomId: r.roomId });
    }
  }

  // 3. Toメンションをタスクにする（1通に複数Toがあれば人ごとに1件）
  const tasks = [];
  const toRe = /\[To:(\d+)\]/g;
  for (const r of rows) {
    if (r.time < sinceMs) continue;
    if (/^\[deleted\]$/.test(r.body.trim())) continue;
    const fromId = senderIdOf(r);
    const seen = {};
    let m;
    toRe.lastIndex = 0;
    while ((m = toRe.exec(r.body))) {
      const toId = m[1];
      if (seen[toId] || toId === fromId) continue;
      seen[toId] = true;
      const k = r.roomId + '-' + r.messageId;
      // RE（返信ボタン）で返した → 完了。REを使わず同じルームで送り主にToを返した場合も完了とみなす
      let reply = (replies[k] || []).find(x => x.by === toId && x.time >= r.time);
      let doneBy = reply ? 're' : null;
      if (!reply && fromId) {
        reply = (toBacks[r.roomId] || []).find(x => x.by === toId && x.to === fromId && x.time > r.time);
        if (reply) doneBy = 'to';
      }
      tasks.push({
        id: k + '-' + toId,
        roomId: r.roomId,
        roomName: r.roomName,
        messageId: r.messageId,
        time: r.time,
        fromId: fromId,
        fromName: fromId && idToName[fromId] ? idToName[fromId] : r.sender,
        toId: toId,
        toName: idToName[toId] || ('ID:' + toId),
        isMe: toId === me.id,
        body: cleanBody(r.body).slice(0, 1200),
        url: 'https://www.chatwork.com/#!rid' + r.roomId + '-' + r.messageId,
        done: !!reply,
        doneAt: reply ? reply.time : null,
        doneBy: doneBy,
        replyUrl: reply ? 'https://www.chatwork.com/#!rid' + reply.roomId + '-' + reply.messageId : null
      });
    }
  }

  const rooms = {};
  const people = {};
  tasks.forEach(t => { rooms[t.roomId] = t.roomName; people[t.toId] = t.toName; });

  return {
    me: { id: me.id, name: me.name },
    generatedAt: Date.now(),
    rooms: Object.keys(rooms).map(id => ({ id: id, name: rooms[id] })).sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    people: Object.keys(people).map(id => ({ id: id, name: people[id] })).sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    tasks: tasks
  };
}
