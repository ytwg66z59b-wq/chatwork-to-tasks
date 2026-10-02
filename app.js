(() => {
  'use strict';

  const REFRESH_MS = 2 * 60 * 1000;
  const LS = {
    apiUrl: 'toTasks.apiUrl',
    apiKey: 'toTasks.apiKey',
    days: 'toTasks.days',
    view: 'toTasks.view',
    manual: 'toTasks.manualDone'
  };

  // ---------- storage (失敗しても動くように) ----------
  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem(k); return v === null ? fallback : v; } catch (_) { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* noop */ } },
    getJSON(k, fallback) { try { return JSON.parse(store.get(k, '')) || fallback; } catch (_) { return fallback; } },
    setJSON(k, v) { store.set(k, JSON.stringify(v)); }
  };

  // ---------- state ----------
  const params = new URLSearchParams(location.search);
  const state = {
    demo: params.get('demo') === '1',
    data: null,
    loading: false,
    error: null,
    manual: store.getJSON(LS.manual, {}),   // id -> 'done' | 'open'（手動の上書き）
    view: Object.assign({ status: 'open', person: 'me', room: 'all', order: 'asc', q: '', group: false }, store.getJSON(LS.view, {})),
    expanded: new Set()
  };
  if (!['notice', 'open', 'done', 'all'].includes(state.view.status)) state.view.status = 'open'; // 旧タブ（要返信など）からの移行

  // URLの #api=...&key=... から設定を取り込む（スマホへの設定の受け渡し用）
  (function importFromHash() {
    if (!location.hash || location.hash.length < 2) return;
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('api') && h.get('key')) {
      store.set(LS.apiUrl, h.get('api'));
      store.set(LS.apiKey, h.get('key'));
      history.replaceState(null, '', location.pathname + location.search);
    }
  })();

  const $ = sel => document.querySelector(sel);
  const el = {
    list: $('#list'), notice: $('#notice'), summary: $('#summary'), filters: $('#filters'),
    statOpen: $('#statOpen'), statDone: $('#statDone'), statOldest: $('#statOldest'),
    statNotice: $('#statNotice'),
    personSel: $('#personSel'), roomSel: $('#roomSel'), orderSel: $('#orderSel'), search: $('#searchInput'),
    group: $('#groupToggle'), updated: $('#updated'), subtitle: $('#subtitle'),
    refresh: $('#refreshBtn'), settingsBtn: $('#settingsBtn'), dialog: $('#settings'), form: $('#settingsForm'),
    apiUrl: $('#apiUrlInput'), apiKey: $('#apiKeyInput'), days: $('#daysInput'),
    cancel: $('#cancelBtn'), demoBtn: $('#demoBtn'), tpl: $('#cardTpl')
  };

  const config = () => ({
    apiUrl: store.get(LS.apiUrl, ''),
    apiKey: store.get(LS.apiKey, ''),
    days: store.get(LS.days, '60')
  });

  // ---------- data ----------
  async function load(opts) {
    const force = opts && opts.force;
    const cfg = config();
    if (!state.demo && (!cfg.apiUrl || !cfg.apiKey)) {
      state.data = null;
      render();
      openSettings();
      return;
    }
    state.loading = true;
    el.refresh.classList.add('is-spinning');
    try {
      let json;
      if (state.demo) {
        const res = await fetch('demo.json', { cache: 'no-store' });
        json = await res.json();
        // デモの日時を「今」基準にずらす
        const shift = Date.now() - (json.baseNow || json.generatedAt);
        json.tasks.forEach(t => { t.time += shift; if (t.doneAt) t.doneAt += shift; });
        if (json.judgedAt) json.judgedAt += shift;
        json.generatedAt = Date.now();
      } else {
        const url = new URL(cfg.apiUrl);
        url.searchParams.set('key', cfg.apiKey);
        url.searchParams.set('days', cfg.days);
        if (force) url.searchParams.set('nocache', '1');
        const res = await fetch(url.toString(), { method: 'GET', redirect: 'follow', cache: 'no-store' });
        const text = await res.text();
        try { json = JSON.parse(text); } catch (_) {
          throw new Error('APIの応答を読めませんでした。ウェブアプリの「アクセスできるユーザー」が「全員」になっているか確認してください。');
        }
      }
      if (!json.ok) throw new Error(json.error || '読み込みに失敗しました');
      state.data = json;
      state.error = null;
    } catch (err) {
      state.error = err && err.message ? err.message : String(err);
      if (/Failed to fetch|NetworkError|Load failed/i.test(state.error)) {
        state.error = 'APIに接続できませんでした。URLが正しいか、ウェブアプリが「全員」に公開されているか確認してください。';
      }
    } finally {
      state.loading = false;
      el.refresh.classList.remove('is-spinning');
      render();
    }
  }

  // ---------- helpers ----------
  const pad = n => String(n).padStart(2, '0');
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  function fmtTime(ms) {
    const d = new Date(ms);
    return (d.getMonth() + 1) + '/' + d.getDate() + '(' + WD[d.getDay()] + ') ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'たった今';
    if (s < 3600) return Math.floor(s / 60) + '分前';
    if (s < 86400) return Math.floor(s / 3600) + '時間前';
    return Math.floor(s / 86400) + '日前';
  }
  function linkify(text, node) {
    const re = /(https?:\/\/[^\s<>"「」）)]+)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = m[1]; a.textContent = m[1]; a.target = '_blank'; a.rel = 'noopener';
      node.appendChild(a);
      last = m.index + m[1].length;
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
  }
  // 本文冒頭の「〇〇さん」「cc〇〇さん」だけの行を省く
  function stripAddressLines(body) {
    const lines = String(body || '').split('\n');
    while (lines.length && (/^\s*$/.test(lines[0]) || /^\s*(cc|CC|ＣＣ|Cc)?\s*[^\s。、！？!?]{1,50}さん\s*$/.test(lines[0]))) lines.shift();
    return lines.join('\n').trim();
  }
  const shortName = n => String(n || '').replace(/[（(【].*$/, '').split(/[｜|]/)[0].trim() || n;

  // ---------- 振り分け（AIは使わず、チャットの文面だけで判断） ----------
  // 通知用：①送信者名に「通知用」が入っている ②自分が「CC」として書かれている ③本文に「返信不要」などとある
  const escRe = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function noticeReason(t) {
    if (t._notice !== undefined) return t._notice;
    let why = '';
    if (/通知用/.test(t.fromName || '')) why = '通知用アカウントからの通知';
    else {
      const name = shortName(t.toName).split(/[/／]/)[0].replace(/\s+/g, '');
      const nameRe = name.split('').map(escRe).join('[\\s　]*');
      if (name && new RegExp('(?:^|[^A-Za-z])(?:cc|CC|Cc|ｃｃ|ＣＣ|Ｃｃ)[\\s　:：]*' + nameRe).test(t.body || '')) why = 'CCで入っているだけ';
      else if (/返信不要|返信は不要|返信には(?:及|およ)びません|返信なしで/.test(t.body || '')) why = '「返信不要」と書かれている';
    }
    t._notice = why;
    return why;
  }
  // 手動で動かしたもの（完了にした・未対応に移した など）は通知用に入れない
  const isNotice = t => !state.manual[t.id] && !!noticeReason(t);

  // 対応済み：宛先の人が、そのToにREで返した／同じルームで送り主にToを返した（または手動で完了にした）
  function isDone(t) {
    const o = state.manual[t.id];
    if (o === 'done') return true;
    if (o === 'open') return false;
    return !!t.done;
  }
  const isOpen = t => !isNotice(t) && !isDone(t);
  const isDoneTask = t => !isNotice(t) && isDone(t);

  function saveView() { store.setJSON(LS.view, state.view); }

  // ---------- filtering & sorting ----------
  function visibleTasks() {
    const d = state.data;
    if (!d) return [];
    const v = state.view;
    const meId = d.me && d.me.id;
    const q = v.q.trim().toLowerCase();
    return d.tasks.filter(t => {
      if (v.person === 'me' && t.toId !== meId) return false;
      if (v.person !== 'me' && v.person !== 'all' && t.toId !== v.person) return false;
      if (v.room !== 'all' && t.roomId !== v.room) return false;
      if (q && !(t.body + ' ' + t.fromName + ' ' + t.toName + ' ' + t.roomName).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function sortTasks(list) {
    const dir = state.view.order === 'desc' ? -1 : 1;
    return list.slice().sort((a, b) => {
      const da = isDone(a) ? 1 : 0, db = isDone(b) ? 1 : 0;
      if (da !== db) return da - db;                                  // 1. 未対応が先
      if (a.time !== b.time) return (a.time - b.time) * dir;          // 2. 時系列
      return shortName(a.toName).localeCompare(shortName(b.toName), 'ja'); // 3. 宛先の名前順
    });
  }

  // ---------- render ----------
  function renderSelects() {
    const d = state.data;
    const meId = d.me && d.me.id;
    const v = state.view;

    const people = (d.shared ? [] : [{ id: 'me', name: '自分' + (d.me && d.me.name ? '（' + shortName(d.me.name) + '）' : '') }])
      .concat([{ id: 'all', name: d.shared ? '全員（自分の名前を選んでください）' : '全員' }])
      .concat(d.people.filter(p => p.id !== meId).map(p => ({ id: p.id, name: shortName(p.name) + 'さん' })));
    if (!people.some(p => p.id === v.person)) v.person = d.shared ? 'all' : 'me';
    el.personSel.replaceChildren(...people.map(p => new Option(p.name, p.id, false, p.id === v.person)));

    const rooms = [{ id: 'all', name: 'すべてのルーム' }].concat(d.rooms);
    if (!rooms.some(r => r.id === v.room)) v.room = 'all';
    el.roomSel.replaceChildren(...rooms.map(r => new Option(r.name, r.id, false, r.id === v.room)));

    el.orderSel.value = v.order;
    if (el.search.value !== v.q) el.search.value = v.q;
    el.group.checked = !!v.group;
    document.querySelectorAll('.seg__btn').forEach(b => b.setAttribute('aria-checked', String(b.dataset.status === v.status)));
  }

  function makeCard(t) {
    const node = el.tpl.content.firstElementChild.cloneNode(true);
    const done = isDone(t);
    const meId = state.data.shared ? state.view.person : (state.data.me && state.data.me.id);
    node.classList.toggle('is-done', done);

    const chip = node.querySelector('.chip--to');
    chip.textContent = (t.toId === meId ? 'あなた' : shortName(t.toName) + 'さん') + '宛て';
    chip.classList.toggle('chip--me', t.toId === meId);
    chip.title = t.toName;

    node.querySelector('.card__room').textContent = t.roomName;
    const time = node.querySelector('.card__time');
    time.textContent = fmtTime(t.time) + '・' + ago(t.time);
    time.dateTime = new Date(t.time).toISOString();

    const from = node.querySelector('.card__from');
    from.append('送信者 ');
    const strong = document.createElement('strong');
    strong.textContent = shortName(t.fromName);
    from.append(strong);

    const body = node.querySelector('.card__body');
    const text = stripAddressLines(t.body);
    t._text = text;
    linkify(text || '（本文なし）', body);
    const more = node.querySelector('.card__more');
    if (state.expanded.has(t.id)) body.classList.add('is-open');
    if (text.split('\n').length > 4 || text.length > 160) {
      more.hidden = false;
      more.textContent = state.expanded.has(t.id) ? '閉じる' : 'もっと見る';
      more.addEventListener('click', () => {
        if (state.expanded.has(t.id)) state.expanded.delete(t.id); else state.expanded.add(t.id);
        body.classList.toggle('is-open');
        more.textContent = body.classList.contains('is-open') ? '閉じる' : 'もっと見る';
      });
    }

    const notice = isNotice(t);
    const aiLine = node.querySelector('.card__ai');
    if (notice) {
      aiLine.hidden = false;
      const badge = document.createElement('span');
      badge.className = 'ai-badge ai-badge--notice';
      badge.textContent = '通知用';
      aiLine.append(badge, document.createTextNode(noticeReason(t)));
    }
    node.classList.toggle('is-notice', notice);

    const status = node.querySelector('.status');
    const manual = state.manual[t.id];
    if (notice) {
      status.className = 'status status--notice';
      status.textContent = done ? '通知（返信あり）' : '通知';
    } else if (!done) {
      status.className = 'status status--open';
      status.textContent = '未対応';
    } else {
      status.className = 'status status--done';
      if (manual === 'done') status.textContent = '✓ 手動で完了';
      else status.textContent = '✓ ' + (t.doneBy === 'to' ? 'Toで返信' : 'REで返信') + (t.doneAt ? '（' + fmtTime(t.doneAt) + '）' : '');
    }

    const reply = node.querySelector('.card__reply');
    if (t.replyUrl && done && manual !== 'done') { reply.hidden = false; reply.href = t.replyUrl; }

    const mbtn = node.querySelector('.card__manual');
    mbtn.textContent = notice ? '未対応に移す' : done ? '未対応に戻す' : '完了にする';
    mbtn.addEventListener('click', () => {
      const next = notice ? false : !done;
      if (noticeReason(t)) state.manual[t.id] = next ? 'done' : 'open';     // 通知用だったものは手動の状態を残す
      else if (next === !!t.done) delete state.manual[t.id]; else state.manual[t.id] = next ? 'done' : 'open';
      store.setJSON(LS.manual, state.manual);
      render();
    });

    node.querySelector('.card__open').href = t.url;
    return node;
  }

  function sectionTitle(text, count, cls) {
    const h = document.createElement('h2');
    h.className = 'section-title' + (cls ? ' ' + cls : '');
    h.append(text + ' ');
    const c = document.createElement('span');
    c.className = 'count';
    c.textContent = count;
    h.append(c);
    return h;
  }

  function appendGroup(frag, list) {
    if (!state.view.group) { list.forEach(t => frag.append(makeCard(t))); return; }
    const byRoom = new Map();
    list.forEach(t => { if (!byRoom.has(t.roomId)) byRoom.set(t.roomId, []); byRoom.get(t.roomId).push(t); });
    byRoom.forEach(items => {
      const h = document.createElement('h3');
      h.className = 'room-title';
      h.textContent = items[0].roomName + '（' + items.length + '）';
      frag.append(h);
      items.forEach(t => frag.append(makeCard(t)));
    });
  }

  function showNotice(html, isError) {
    el.notice.hidden = false;
    el.notice.className = 'notice' + (isError ? ' notice--error' : '');
    el.notice.innerHTML = html;
  }

  function render() {
    const d = state.data;
    el.notice.hidden = true;

    if (!d) {
      el.summary.hidden = true; el.filters.hidden = true; el.list.replaceChildren();
      if (state.error) {
        showNotice('<h2>読み込めませんでした</h2><p></p><button class="btn btn--ghost" data-act="settings">設定を開く</button><button class="btn btn--primary" data-act="retry">もう一度</button>', true);
        el.notice.querySelector('p').textContent = state.error;
      } else if (!state.loading) {
        showNotice('<h2>はじめに接続の設定をしてください</h2><p>Google Apps Script のウェブアプリURLとAPIキーを入れると、自分宛てのToが一覧になります。</p><button class="btn btn--ghost" data-act="demo">デモを見る</button><button class="btn btn--primary" data-act="settings">設定を開く</button>');
      } else {
        showNotice('<p>読み込み中…</p>');
      }
      return;
    }

    if (state.error) {
      showNotice('<p></p>', true);
      el.notice.querySelector('p').textContent = '更新に失敗しました（前回のデータを表示中）：' + state.error;
    }

    const selPerson = d.people.find(p => p.id === state.view.person);
    el.subtitle.textContent = state.demo ? 'デモ表示中（架空のデータ）'
      : d.shared ? (selPerson ? shortName(selPerson.name) + 'さん宛てのTo' : '共有ルームのTo')
      : (d.me && d.me.name ? shortName(d.me.name) + 'さん宛てのTo' : 'Chatworkの自分宛てToを一覧で');
    el.updated.textContent = '更新 ' + pad(new Date(d.generatedAt).getHours()) + ':' + pad(new Date(d.generatedAt).getMinutes());
    el.summary.hidden = false; el.filters.hidden = false;
    renderSelects();
    if (d.shared && state.view.person === 'all' && !state.error) {
      showNotice('<p><strong>「宛先」で自分の名前を選んでください。</strong><br>次からは自分宛てのToだけが表示されます。</p>');
    }

    const base = sortTasks(visibleTasks());
    const open = base.filter(isOpen);
    const done = base.filter(isDoneTask);
    const notices = base.filter(isNotice);
    el.statOpen.textContent = open.length;
    el.statDone.textContent = done.length;
    el.statNotice.textContent = notices.length;
    const oldest = open.slice().sort((a, b) => a.time - b.time)[0];
    el.statOldest.textContent = oldest ? ago(oldest.time) + '・' + shortName(oldest.fromName) + '（' + oldest.roomName + '）' : 'なし 🎉';
    document.title = (open.length ? '(' + open.length + ') ' : '') + 'Toタスク';

    const frag = document.createDocumentFragment();
    const st = state.view.status;
    const all = st === 'all';
    if (st === 'open' || all) {
      if (all) frag.append(sectionTitle('未対応', open.length, 'section-title--open'));
      if (open.length) appendGroup(frag, open);
      else frag.append(emptyBox('未対応のToはありません', 'すべて返信済みです'));
    }
    if (st === 'done' || all) {
      if (all) frag.append(sectionTitle('対応済み', done.length));
      if (done.length) appendGroup(frag, done);
      else if (!all) frag.append(emptyBox('対応済みのToはまだありません', ''));
    }
    if (st === 'notice' || all) {
      if (all) frag.append(sectionTitle('通知用', notices.length));
      if (notices.length) appendGroup(frag, notices);
      else if (!all) frag.append(emptyBox('通知用のToはありません', '通知用アカウントからの通知や、CCで入っているだけのToがここに入ります'));
    }
    el.list.replaceChildren(frag);
  }

  function emptyBox(title, sub) {
    const div = document.createElement('div');
    div.className = 'empty';
    const s = document.createElement('strong');
    s.textContent = title;
    div.append(s, sub);
    return div;
  }

  // ---------- settings ----------
  function openSettings() {
    const cfg = config();
    el.apiUrl.value = cfg.apiUrl;
    el.apiKey.value = cfg.apiKey;
    el.days.value = cfg.days;
    if (typeof el.dialog.showModal === 'function') { if (!el.dialog.open) el.dialog.showModal(); }
    else el.dialog.setAttribute('open', '');
  }
  function closeSettings() { if (el.dialog.open) el.dialog.close(); }

  el.form.addEventListener('submit', e => {
    e.preventDefault();
    store.set(LS.apiUrl, el.apiUrl.value.trim());
    store.set(LS.apiKey, el.apiKey.value.trim());
    store.set(LS.days, el.days.value);
    closeSettings();
    if (state.demo) { history.replaceState(null, '', location.pathname); state.demo = false; }
    state.data = null; state.error = null;
    load({ force: true });
  });
  el.cancel.addEventListener('click', closeSettings);
  el.demoBtn.addEventListener('click', () => { closeSettings(); location.search = '?demo=1'; });
  el.settingsBtn.addEventListener('click', openSettings);
  el.refresh.addEventListener('click', () => load({ force: true }));
  el.notice.addEventListener('click', e => {
    const act = e.target && e.target.dataset && e.target.dataset.act;
    if (act === 'settings') openSettings();
    if (act === 'retry') load({ force: true });
    if (act === 'demo') location.search = '?demo=1';
  });

  // ---------- filters ----------
  document.querySelectorAll('.seg__btn').forEach(b => b.addEventListener('click', () => {
    state.view.status = b.dataset.status; saveView(); render();
  }));
  el.personSel.addEventListener('change', () => { state.view.person = el.personSel.value; saveView(); render(); });
  el.roomSel.addEventListener('change', () => { state.view.room = el.roomSel.value; saveView(); render(); });
  el.orderSel.addEventListener('change', () => { state.view.order = el.orderSel.value; saveView(); render(); });
  el.group.addEventListener('change', () => { state.view.group = el.group.checked; saveView(); render(); });
  let qTimer;
  el.search.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.view.q = el.search.value; saveView(); render(); }, 150);
  });

  // ---------- auto refresh ----------
  setInterval(() => { if (!document.hidden && !state.loading) load(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.data && Date.now() - state.data.generatedAt > 60 * 1000) load();
  });

  render();
  load();
})();
