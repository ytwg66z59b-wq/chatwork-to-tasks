/**
 * Claudeの判定を前回の結果に統合する。
 *
 * 使い方: node judge/merge.js prev.json candidates.json decisions.json out.json
 *   decisions.json … [{ "key": "...", "needsReply": true, "answered": false, "reason": "..." }, ...]
 *
 *   たぶん対応済みなら "maybeDone": true を付ける（needsReply: true, answered: false のときだけ有効）
 *
 * 出力形式（v2）: { "v": 2, "u": 更新時刻ms, "j": { key: [needsReply(0/1), answered(0/1), "理由", lastRecipientMsg, maybeDone(0/1), lastSignal] } }
 * maybeDone のときは理由の頭に「たぶん済：」を付ける（画面はこれでも判別できる）
 * 今の表示期間に入っていないToの判定は捨てる（prepare.js が書く active-keys.json を使う）。
 */
const fs = require('fs');
const path = require('path');
const { loadJudgments } = require('./judgments');

const [prevPath, candPath, decPath, outPath] = process.argv.slice(2);

const prev = loadJudgments(prevPath);
const candidates = JSON.parse(fs.readFileSync(candPath, 'utf8'));
const decisions = JSON.parse(fs.readFileSync(decPath, 'utf8'));
const activePath = path.join(path.dirname(candPath), 'active-keys.json');
const active = fs.existsSync(activePath) ? new Set(JSON.parse(fs.readFileSync(activePath, 'utf8'))) : null;

const cand = {};
candidates.forEach(c => { cand[c.key] = c; });

const j = {};
for (const k of Object.keys(prev)) {
  const p = prev[k];
  j[k] = [p.needsReply ? 1 : 0, p.answered ? 1 : 0, p.reason, p.lastRecipientMsg || 0, p.maybeDone ? 1 : 0, p.lastSignal || 0];
}
let n = 0;
const unknown = [];
for (const d of decisions) {
  const c = cand[d.key];
  if (!c) { unknown.push(d.key); continue; }
  const needs = !!d.needsReply;
  const answered = needs && !!d.answered;
  const maybe = needs && !answered && !!d.maybeDone;
  const reason = String(d.reason || '').replace(/^たぶん済[:：]\s*/, '').slice(0, 30);
  j[d.key] = [needs ? 1 : 0, answered ? 1 : 0, (maybe ? 'たぶん済：' : '') + reason, c.lastRecipientMsg || 0, maybe ? 1 : 0, c.lastSignal || 0];
  n++;
}
const notDecided = candidates.filter(c => !decisions.some(d => d.key === c.key)).map(c => c.key);

if (active) for (const k of Object.keys(j)) if (!active.has(k)) delete j[k];

fs.writeFileSync(outPath, JSON.stringify({ v: 2, u: Date.now(), j }));
console.log(`merged=${n} total=${Object.keys(j).length} unknownKeys=${unknown.length} notDecided=${notDecided.length} bytes=${fs.statSync(outPath).size}`);
if (notDecided.length) console.log('判定が抜けているkey:', notDecided.join(', '));
