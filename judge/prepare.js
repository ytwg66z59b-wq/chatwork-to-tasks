/**
 * 判定が必要なToを取り出す。
 *
 * 使い方: node judge/prepare.js rows.json prev.json candidates.json [days]
 *   rows.json      … xlsx_to_rows.py の出力
 *   prev.json      … 前回の判定結果（なければ存在しないパスでOK）
 *   candidates.json… Claudeに判定してもらう対象（出力）
 *
 * 対象になるのは、
 *   - まだ判定していないTo
 *   - 前回「返答が必要・未回答」と判定し、その後に宛先の人がそのルームで発言したTo
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const [rowsPath, prevPath, outPath, daysArg] = process.argv.slice(2);
const days = Number(daysArg) || 60;

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8'), ctx);
const buildTasks = vm.runInContext('buildTasks', ctx);
const cleanBody = vm.runInContext('cleanBody', ctx);
const baseName = vm.runInContext('baseName', ctx);

const rows = JSON.parse(fs.readFileSync(rowsPath, 'utf8')).sort((a, b) => a.time - b.time);
const judgments = require('./judgments').loadJudgments(prevPath);

const result = buildTasks(rows, { me: { id: '', name: '' }, sinceMs: Date.now() - days * 86400000 });

// 宛先の人の発言かどうか（送信者ID、なければ名前で照合）
const isBy = (r, t) => (r.senderId ? r.senderId === t.toId : baseName(r.sender) === baseName(t.toName));

const byRoom = {};
rows.forEach(r => { (byRoom[r.roomId] = byRoom[r.roomId] || []).push(r); });

const candidates = [];
for (const t of result.tasks) {
  const roomRows = byRoom[t.roomId] || [];
  const later = roomRows.filter(r => r.time > t.time && !/^\[deleted\]$/.test(r.body.trim()));
  const byRecipient = later.filter(r => isBy(r, t));
  const lastRecipientMsg = byRecipient.length ? byRecipient[byRecipient.length - 1].time : 0;

  const j = judgments[t.id];
  if (j) {
    if (!j.needsReply || j.answered) continue;                 // 返答不要 or 回答済み → もう見ない
    if (lastRecipientMsg <= (j.lastRecipientMsg || 0)) continue; // 本人の新しい発言がない → 変わらない
  }

  // 判断材料：Toの後に宛先の人が同じルームで送ったメッセージ（最大8件・14日以内）
  const replies = byRecipient
    .filter(r => r.time - t.time <= 14 * 86400000)
    .slice(0, 8)
    .map(r => ({
      time: new Date(r.time).toISOString(),
      isReplyToThis: r.body.includes('to=' + t.roomId + '-' + t.messageId),
      body: cleanBody(r.body).slice(0, 400)
    }));

  // 同じToに宛先以外の人がREで返したもの（他の宛先の人が対応済みかの判断用）
  const others = later
    .filter(r => !isBy(r, t) && r.body.includes('to=' + t.roomId + '-' + t.messageId))
    .slice(0, 3)
    .map(r => ({ time: new Date(r.time).toISOString(), from: r.sender, body: cleanBody(r.body).slice(0, 200) }));

  candidates.push({
    key: t.id,
    room: t.roomName,
    time: new Date(t.time).toISOString(),
    from: t.fromName,
    to: t.toName,
    body: t.body.slice(0, 900),
    ruleDone: t.done ? t.doneBy : null,
    recipientMessagesAfter: replies,
    othersRepliesToThis: others,
    lastRecipientMsg: lastRecipientMsg
  });
}

fs.writeFileSync(outPath, JSON.stringify(candidates, null, 1));
fs.writeFileSync(path.join(path.dirname(outPath), 'active-keys.json'), JSON.stringify(result.tasks.map(t => t.id)));
console.log(`tasks=${result.tasks.length} judged=${Object.keys(judgments).length} candidates=${candidates.length} -> ${outPath}`);
