/** 判定ファイル（v1/v2どちらでも）を { key: {needsReply, answered, reason, lastRecipientMsg} } にして返す */
const fs = require('fs');

function normalize(data) {
  const out = {};
  if (!data) return out;
  if (data.v === 2 && data.j) {
    for (const k of Object.keys(data.j)) {
      const a = data.j[k];
      out[k] = { needsReply: !!a[0], answered: !!a[1], reason: a[2] || '', lastRecipientMsg: a[3] || 0, maybeDone: !!a[4], lastSignal: a[5] || a[3] || 0 };
    }
  } else if (data.judgments) {
    for (const k of Object.keys(data.judgments)) out[k] = data.judgments[k];
  }
  return out;
}

function loadJudgments(p) {
  if (!p || !fs.existsSync(p)) return {};
  return normalize(JSON.parse(fs.readFileSync(p, 'utf8')));
}

module.exports = { loadJudgments, normalize };
