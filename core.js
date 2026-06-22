// Общая логика плагина: парсинг таблицы, вызовы pointauc API, построение и выполнение плана.
// Используется и popup.js (UI/предпросмотр), и background.js (фоновая заливка).
// Официальный публичный API pointauc: см. Pointauc/Pointauc.Api.

export const API_BASE = 'https://pointauc.com/api/oshino';

export const DEFAULTS = {
  token: '',
  sheetUrl: '',
  firstRow: 2,            // номер первой строки с данными (1-based, как в таблице)
  nickCol: 'A',           // столбец с ником
  pointsCol: 'B',         // столбец с баллами
  newLotPrefix: '[СОЦРЕЙТИНГ] ', // приставка к имени лота при выборе «новый лот» в окне
  allowNegative: true,
  skipZero: true,
  asDonation: false,      // слать ставки как донат (isDonation: true) — применится конвертация аука
  sheetName: '',          // имя вкладки для записи (необязательно): если задано — скрипт ищет лист по имени, иначе по gid из ссылки
  webAppUrl: '',          // Apps Script Web App для записи баллов (покупка рейтинга за балы канала)
  webAppSecret: '',       // секрет веб-аппа (тот же, что в скрипте); генерится кнопкой «Скопировать скрипт»
  buySameCol: true,       // балы покупок — в тот же столбец, что pointsCol
  buyPointsCol: '',       // отдельный столбец для купленных баллов (когда buySameCol = false)
  rewardMap: [],          // награды Twitch → рейтинг: [{ rewardId, rewardTitle, cost, points, target:'self'|'input' }] (cost — цена в балах канала; расширение само создаёт награды)
  twitchRewardsActive: false, // мастер-переключатель: награды созданы и включены на Twitch
  twitchClientId: '',     // Client ID Twitch-приложения стримера (dev.twitch.tv)
  twitchToken: '',        // user access token (implicit OAuth), скоуп channel:manage:redemptions
  twitchUserId: '',       // broadcaster user_id
  twitchLogin: '',        // логин подключённого канала
  twitchLog: [],          // лог последних начислений за балы канала (пишет background)
  twitchPending: [],      // редемпшены на ручное подтверждение стримером (пишет background)
};

// ───────────────────────── Google Sheets ─────────────────────────
export function parseSheetRef(url) {
  const id = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const gid = url.match(/[?#&]gid=(\d+)/);
  if (!id) return null;
  return { id: id[1], gid: gid ? gid[1] : '0' };
}

export async function fetchSheetRows(url, s) {
  const ref = parseSheetRef(url);
  if (!ref) throw new Error('Ссылка не похожа на Google Sheets.');
  const csvUrl = `https://docs.google.com/spreadsheets/d/${ref.id}/export?format=csv&gid=${ref.gid}`;
  const res = await fetch(csvUrl, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Таблица недоступна (HTTP ${res.status}). Открой доступ «по ссылке: просмотр».`);
  return parseCsv(await res.text(), s);
}

// Мини-парсер CSV: поддерживает кавычки и запятые внутри полей.
export function splitCsv(text) {
  const rows = [];
  let field = '', row = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// "A" → 0, "B" → 1, … "AA" → 26; также принимает номер столбца (1-based).
export function colToIndex(col) {
  const s = String(col).trim().toUpperCase();
  if (/^\d+$/.test(s)) return Math.max(0, parseInt(s, 10) - 1);
  if (!/^[A-Z]+$/.test(s)) return -1;
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function parseCsv(text, s) {
  const lines = splitCsv(text.replace(/^﻿/, ''));
  const nickIdx = colToIndex(s.nickCol);
  const ptsIdx = colToIndex(s.pointsCol);
  if (nickIdx < 0 || ptsIdx < 0) throw new Error('Неверно указан столбец ника/баллов (нужно A, B, … или номер).');
  const start = Math.max(0, (parseInt(s.firstRow, 10) || 1) - 1);
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i];
    const name = (cols[nickIdx] || '').trim();
    const raw = (cols[ptsIdx] || '').trim();
    if (!name && !raw) continue;
    const n = Number(raw.replace(',', '.'));
    out.push({ nick: name, rawPoints: raw, points: Number.isFinite(n) ? Math.trunc(n) : NaN });
  }
  return out;
}

// ───────────────────────── pointauc API ─────────────────────────
const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

export async function getLots(token) {
  const res = await fetch(`${API_BASE}/lots`, { headers: headers(token) });
  if (res.status === 401) throw new Error('Неверный токен (401). Проверь Personal Token.');
  if (!res.ok) throw new Error(`GET /lots → HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.lots || []);
}

// Сырой POST ставок одним запросом. bids — массив объектов ставок.
export async function postBids(token, bids) {
  if (!bids.length) return [];
  const res = await fetch(`${API_BASE}/bids`, { method: 'POST', headers: headers(token), body: JSON.stringify({ bids }) });
  if (!res.ok) throw new Error(`POST /bids → HTTP ${res.status}`);
  return res.json();
}

// Начислить балы нику через Apps Script Web App (покупка рейтинга). Возвращает { ok, nick, total }.
// text/plain — чтобы не словить CORS-preflight; ответ читаем благодаря host_permissions на script(.googleusercontent).com.
export async function addPoints(url, secret, nick, points) {
  if (!url) throw new Error('Не задан URL веб-аппа (Apps Script).');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret, nick, points }),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Веб-апп → HTTP ${res.status}`);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } // не-JSON (страница логина/«нет доступа») = неправильный деплой
  catch { throw new Error('Веб-апп вернул не JSON. Проверь деплой: Execute as Me, Who has access Anyone, и что URL заканчивается на /exec.'); }
  if (data.ok === false) throw new Error(`Веб-апп: ${data.error || 'ошибка'}`);
  if (typeof data.ok === 'undefined') throw new Error('Неожиданный ответ веб-аппа.');
  return data;
}

// Проверка веб-аппа тем же POST-путём, что и запись (без записи в лист): доступность, корректный деплой (JSON, а не HTML), секрет, наличие листа.
export async function healthCheck(url, secret) {
  if (!url) throw new Error('Не задан URL веб-аппа.');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret, ping: true }),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('ответ не JSON — задеплой как Web app: Execute as Me, Who has access Anyone, URL …/exec'); }
  if (data.ok === false) {
    if (data.error === 'bad secret') throw new Error('неверный секрет');
    if (data.error === 'bad input') throw new Error('старый скрипт — пересними кнопкой и задеплой заново (New deployment)');
    throw new Error(data.error || 'ошибка');
  }
  if (data.sheetFound === false) throw new Error(`лист «${data.sheet}» не найден`);
  return data;
}

// ───────────────────────── Twitch: маппинг наград → рейтинг ─────────────────────────
// ник из ввода зрителя: убрать ведущий @, пробелы, нижний регистр (логин Twitch — регистронезависим)
export function normNick(s) { return String(s || '').trim().replace(/^@+/, '').trim().toLowerCase(); }

// По событию редемпшена и маппингу определить начисление.
// ev: { rewardId, rewardTitle, userLogin, userInput }
// → { nick, points, target } | { skip: '<причина>' } | null (награда не замаплена — игнор)
export function resolveRedemption(map, ev) {
  const rows = Array.isArray(map) ? map : [];
  const evTitle = String(ev.rewardTitle || '').trim().toLowerCase();
  const row = rows.find((r) => r.rewardId && r.rewardId === ev.rewardId)
    || rows.find((r) => !r.rewardId && evTitle !== '' && String(r.rewardTitle || '').trim().toLowerCase() === evTitle);
  if (!row) return null;
  const points = parseInt(row.points, 10);
  if (!Number.isFinite(points) || points === 0) return { skip: 'нулевые/нечисловые баллы' };
  const self = normNick(ev.userLogin);
  const nick = row.target === 'input' ? (normNick(ev.userInput) || self) : self; // пустой ввод → начисление себе
  if (!nick) return { skip: 'нет ника' };
  return { nick, points, target: row.target === 'input' ? 'input' : 'self' };
}

// Генерирует код Apps Script (doPost) с подставленными настройками + секретом.
// Лист ищется по имени вкладки (sheetName, обязательно); столбцы/строка — из настроек; столбец баллов — pointsCol или отдельный buyPointsCol.
export function buildAppsScript(s, secret) {
  const sheetName = (s.sheetName || '').trim();
  if (!sheetName) throw new Error('Укажи имя листа (вкладки) в настройках.');
  const nickIdx = colToIndex(s.nickCol);
  let ptsIdx = colToIndex((s.buySameCol === false && s.buyPointsCol) ? s.buyPointsCol : s.pointsCol);
  if (ptsIdx < 0) ptsIdx = colToIndex(s.pointsCol); // невалидный столбец покупок → откат на основной
  if (nickIdx < 0 || ptsIdx < 0) throw new Error('Неверно указан столбец ника/баллов (нужно A, B, … или номер).');
  const nickCol = nickIdx + 1;
  const ptsCol = ptsIdx + 1;
  const firstRow = Math.max(1, parseInt(s.firstRow, 10) || 2);
  return [
    '/**',
    ' * PigRating — приём начислений рейтинга (сгенерировано расширением).',
    ' * Deploy → New deployment → Web app: Execute as Me, Who has access Anyone → скопируй URL в расширение.',
    ' */',
    `const SECRET     = ${JSON.stringify(secret)};`,
    `const SHEET_NAME = ${JSON.stringify(sheetName)};`,
    `const NICK_COL   = ${nickCol};`,
    `const POINTS_COL = ${ptsCol};`,
    `const FIRST_ROW  = ${firstRow};`,
    '',
    'function doPost(e) {',
    '  const lock = LockService.getScriptLock();',
    "  if (!lock.tryLock(10000)) return out({ ok: false, error: 'busy, повтори' });",
    '  try {',
    '    const b = JSON.parse(e.postData.contents);',
    "    if (b.secret !== SECRET) return out({ ok: false, error: 'bad secret' });",
    "    if (b.ping) { const ps = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME); return out({ ok: true, sheet: SHEET_NAME, sheetFound: !!ps }); }", // хелсчек без записи
    "    const nick = String(b.nick || '').trim();",
    '    const pts  = Number(b.points);',
    "    if (!nick || !isFinite(pts)) return out({ ok: false, error: 'bad input' });",
    '    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);',
    "    if (!sh) return out({ ok: false, error: 'sheet not found: ' + SHEET_NAME });",
    '    const last = sh.getLastRow();',
    '    const col = last >= FIRST_ROW ? sh.getRange(FIRST_ROW, NICK_COL, last - FIRST_ROW + 1, 1).getValues() : [];',
    '    let row = -1;',
    '    for (let i = 0; i < col.length; i++)',
    '      if (String(col[i][0]).trim().toLowerCase() === nick.toLowerCase()) { row = FIRST_ROW + i; break; }',
    '    if (row === -1) { row = Math.max(last + 1, FIRST_ROW); sh.getRange(row, NICK_COL).setValue(nick); sh.getRange(row, POINTS_COL).setValue(0); }', // аппенд ниже всех данных — не перезатирает итог/футер
    '    const cell = sh.getRange(row, POINTS_COL);',
    '    const total = (Number(cell.getValue()) || 0) + pts;',
    '    cell.setValue(total);',
    '    return out({ ok: true, nick: nick, total: total });',
    '  } catch (err) { return out({ ok: false, error: String(err) }); }',
    '  finally { lock.releaseLock(); }',
    '}',
    'function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }',
    '',
  ].join('\n');
}

// ───────────────────────── построение плана ─────────────────────────
export const norm = (s) => (s || '').trim().toLowerCase();
// Инвестор-метка рейтинга: "<префикс>ник:сумма" (сумма зашита в имя — для отката).
const isMark = (inv, prefix) => { const p = norm(prefix); return !!p && norm(inv).startsWith(p); };
export const markName = (prefix, nick, points) => `${prefix}${nick}:${points}`;
// Разобрать метку → { nick, amount } | null. Понимает старый формат без ":сумма" (amount = NaN).
export function parseMark(investor, prefix) {
  const inv = (investor || '').trim();
  const p = (prefix || '').trim();
  if (!p || inv.toLowerCase().indexOf(p.toLowerCase()) !== 0) return null;
  const rest = inv.slice(p.length).replace(/^\s+/, '');
  const i = rest.lastIndexOf(':');
  if (i < 0) return { nick: rest, amount: NaN };
  const amount = parseInt(rest.slice(i + 1), 10);
  return { nick: rest.slice(0, i).trim(), amount: Number.isFinite(amount) ? amount : NaN };
}

export function buildPlan(rows, lots, s) {
  const prefix = s.newLotPrefix || '';
  const effInvestors = (l) => (l.investors || []).filter((inv) => !isMark(inv, prefix)); // реальные вкладчики

  return rows.map((r) => {
    const it = { nick: r.nick, points: r.points, rawPoints: r.rawPoints, investor: markName(prefix, r.nick, r.points), isDonation: !!s.asDonation };

    if (!r.nick) return Object.assign(it, { action: 'skip', reason: 'пустой ник' });
    if (!Number.isFinite(r.points)) return Object.assign(it, { action: 'skip', reason: `не число: "${r.rawPoints}"` });
    if (r.points === 0 && s.skipZero) return Object.assign(it, { action: 'skip', reason: 'ноль' });
    if (r.points < 0 && !s.allowNegative) return Object.assign(it, { action: 'skip', reason: 'минус выключен' });

    // совпадение по реальному вкладчику (метки [СОЦРЕЙТИНГ] не учитываем)
    const matched = lots.filter((l) => effInvestors(l).some((inv) => norm(inv) === norm(r.nick)));
    const candidates = matched.map((l) => ({ id: l.id, fastId: l.fastId, name: l.name, amount: l.amount }));

    // уже залито: где-то есть инвестор-метка этого ника → предупреждаем, по умолчанию пропуск
    const appliedLot = prefix ? lots.find((l) => (l.investors || []).some((inv) => { const m = parseMark(inv, prefix); return m && norm(m.nick) === norm(r.nick); })) : null;
    if (appliedLot) {
      return Object.assign(it, { action: 'resolve', applied: true, candidates, reason: `уже залито (от ${it.investor}) — выбери` });
    }

    // Единственный реальный вкладчик одного лота → автоматически «+ к лоту».
    if (matched.length === 1 && effInvestors(matched[0]).length <= 1) {
      const lot = matched[0];
      return Object.assign(it, { action: 'update', lotId: lot.id, fastId: lot.fastId, target: lot.name, reason: 'единственный вкладчик' });
    }

    // Остальное (нет лота / групповой лот / ник в нескольких лотах) — лот выбирается в окне.
    const reason = matched.length === 0
      ? 'нет лота — выбери лот'
      : matched.length === 1
        ? `групповой лот «${matched[0].name}» — выбери лот`
        : `ник в ${matched.length} лотах — выбери лот`;
    return Object.assign(it, { action: 'resolve', candidates, reason });
  });
}

// Применяет выбор пользователя к пункту resolve. choice: 'skip' | 'new' | <lotId>.
// lotsById — карта id→лот (с fastId) для лотов вне кандидатов (когда выбирается любой лот).
export function resolveChoice(it, choice, prefix = '', lotsById = {}) {
  if (it.action !== 'resolve') return it;
  if (choice === 'new') return { ...it, action: 'create', target: prefix + it.nick };
  if (choice && choice !== 'skip') {
    const id = String(choice);
    const c = (it.candidates || []).find((x) => String(x.id) === id) || lotsById[id];
    return { ...it, action: 'update', lotId: id, fastId: c ? c.fastId : undefined, target: c ? c.name : id };
  }
  return { ...it, action: 'skip' };
}

// ───────────────────────── выполнение ─────────────────────────
// Всё применяется ставками (POST /bids) одним батчем, инвестор/автор у всех — it.investor:
//  • «+ к лоту» / выбранный лот → message "#fastId", insertStrategy "match";
//  • «новый лот» → message = имя лота, insertStrategy "force".
export async function executePlan(token, plan, onProgress = () => {}) {
  const items = plan.filter((it) => it.action === 'update' || it.action === 'create');
  const bids = items.map((it) => it.action === 'update'
    ? { cost: it.points, message: `#${it.fastId}`, investorId: it.investor, username: it.investor, insertStrategy: 'match', isDonation: !!it.isDonation }
    : { cost: it.points, message: it.target, investorId: it.investor, username: it.investor, insertStrategy: 'force', isDonation: !!it.isDonation });

  if (bids.length) {
    try { await postBids(token, bids); items.forEach((it) => { it.status = 'ok'; }); }
    catch (e) { items.forEach((it) => { it.status = 'error'; it.error = e.message; }); }
  }
  onProgress(bids.length, bids.length);
  for (const it of plan) if (!it.status) it.status = 'skip';
  return plan;
}

// ───────────────────────── откат рейтинга ─────────────────────────
export async function updateLot(token, id, lot) {
  const res = await fetch(`${API_BASE}/lot`, { method: 'PUT', headers: headers(token), body: JSON.stringify({ query: { id }, lot }) });
  if (!res.ok) throw new Error(`PUT /lot → HTTP ${res.status}`);
}

// Сканирует доску: каждая метка [префикс]ник:сумма → строка отката.
export function buildRollbackPlan(lots, prefix) {
  const items = [];
  for (const l of lots) for (const inv of (l.investors || [])) {
    const m = parseMark(inv, prefix);
    if (!m) continue;
    items.push({ lotId: l.id, fastId: l.fastId, lotName: l.name, investor: inv, nick: m.nick, amount: Number.isFinite(m.amount) ? m.amount : 0 });
  }
  return items;
}

// Группирует выбранные метки по лоту → один PUT на лот: абсолютная сумма (текущая − снятое) + investors без снятых меток.
export function planRollbackPuts(items, lots) {
  const byLot = new Map();
  for (const it of items) { if (!byLot.has(it.lotId)) byLot.set(it.lotId, []); byLot.get(it.lotId).push(it); }
  const puts = [];
  for (const [lotId, its] of byLot) {
    const lot = lots.find((l) => String(l.id) === String(lotId));
    const remove = new Set(its.map((x) => norm(x.investor)));
    const investors = (lot ? (lot.investors || []) : []).filter((inv) => !remove.has(norm(inv)));
    const sum = its.reduce((s, x) => s + (Number.isFinite(x.amount) ? x.amount : 0), 0);
    const cur = lot && Number.isFinite(lot.amount) ? lot.amount : 0;
    puts.push({ lotId, lotName: lot ? lot.name : '', amount: cur - sum, investors, removed: its.length });
  }
  return puts;
}

// Выполняет откат: берёт свежие лоты, считает PUT'ы, применяет (параллельно).
export async function executeRollback(token, items, onProgress = () => {}) {
  if (!items.length) return [];
  const lots = await getLots(token);
  const puts = planRollbackPuts(items, lots);
  let done = 0;
  await Promise.all(puts.map(async (p) => {
    try { await updateLot(token, p.lotId, { amount: p.amount, investors: p.investors }); p.status = 'ok'; }
    catch (e) { p.status = 'error'; p.error = e.message; }
    onProgress(++done, puts.length);
  }));
  return puts;
}
