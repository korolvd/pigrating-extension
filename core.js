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
  twitchAutoApprove: true,    // авто-начисление покупок (кроме ненайденных на Twitch ников — те на подтверждение)
  // фича «ставка за значки на фильм» (отдельно от соцрейтинга)
  movieBidsActive: false,     // вкл/выкл награды «Предложить фильм»
  movieBase: 1,               // база, прибавляемая к сумме цен значков
  movieRewardTitle: 'Предложить фильм', // название награды (редактируется стримером)
  movieAsDonation: false,     // слать ставку как донат (pointauc применит конвертацию деньги→баллы)
  movieUsePoints: true,       // прибавлять PigPoints зрителя из таблицы к ставке за значки (плюс всегда; минус — по галке ниже)
  movieDropNegForeign: true,  // не учитывать отрицательные PigPoints в общих (чужих) лотах; выкл → минус учитывается везде
  movieRewardId: '',          // id созданной награды на Twitch
  movieBadges: [],            // выбранные значки с ценами: [{ key, price }]
  moviePending: [],           // незавершённые активации (ждут пары/обработки) — переживают сон SW
  movieCounted: {},           // зачтённое в раунде: { userId: [badgeKey,...] } — авторитетный источник анти-повтора
  movieJournal: [],           // журнал ставок раунда (для показа)
  twitchClientId: '',     // Client ID Twitch-приложения стримера (dev.twitch.tv)
  twitchToken: '',        // user access token (implicit OAuth), скоуп channel:manage:redemptions
  twitchUserId: '',       // broadcaster user_id
  twitchLogin: '',        // логин подключённого канала
  twitchLog: [],          // лог последних начислений за балы канала (пишет background)
  twitchPending: [],      // редемпшены на ручное подтверждение стримером (пишет background)
};

// Приставка инвестора-метки для рейтинга/залива (захардкожено). Метка на лоте: "[PP] ник:сумма".
export const LOT_PREFIX = '[PP] ';

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

// Сходство строк по коэффициенту Сёренсена–Дайса (биграммы): 2·|A∩B| / (|A|+|B|), 0..1.
// Та же метрика, что в pointauc для «похожего лота» (там через либу string-similarity); реализация своя.
export function diceSimilarity(a, b) {
  a = String(a).toLowerCase().replace(/\s+/g, '');
  b = String(b).toLowerCase().replace(/\s+/g, '');
  if (a === b) return a ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (str) => {
    const m = new Map();
    for (let i = 0; i < str.length - 1; i++) { const g = str.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
    return m;
  };
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const [g, c] of A) if (B.has(g)) inter += Math.min(c, B.get(g));
  return (2 * inter) / ((a.length - 1) + (b.length - 1));
}

// Лучший похожий ник из ростера таблицы (порог как в pointauc: > 0.4). nick — уже нормализованный (normNick).
// roster — массив сырых ников из таблицы. Возвращает { nick: <сырой ник для показа/записи>, score } | null.
export function suggestNick(nick, roster, threshold = 0.4) {
  let best = null;
  for (const raw of Array.isArray(roster) ? roster : []) {
    const cand = normNick(raw);
    if (!cand || cand === nick) continue;
    const score = diceSimilarity(nick, cand);
    if (score > threshold && (!best || score > best.score)) best = { nick: String(raw).trim(), score };
  }
  return best;
}

// Пул значков для фичи «ставка за значки»: key (внутр. id), label (показ), src ('helix'|'chat') + как детектить (M2).
// helix: sub (тир), vip, mod, follower — точечный запрос. chat: setId (+version/minVersion) — из badges сообщения.
export const MOVIE_BADGE_POOL = [
  { key: 'sub1', label: 'Саб · Tier 1', src: 'helix', sub: 1 },
  { key: 'sub2', label: 'Саб · Tier 2', src: 'helix', sub: 2 },
  { key: 'sub3', label: 'Саб · Tier 3', src: 'helix', sub: 3 },
  { key: 'vip', label: 'VIP', src: 'helix' },
  { key: 'mod', label: 'Модератор', src: 'helix' },
  { key: 'follower', label: 'Фолловер', src: 'helix' },
  { key: 'artist', label: 'Артист', src: 'chat', setId: 'artist-badge' }, // выдаётся стримером; чат-значок, детект по наличию (как founder)
  { key: 'giftlead1', label: 'Топ-1 даритель', src: 'chat', setId: 'sub-gift-leader', version: '1' },
  { key: 'giftlead2', label: 'Топ-2 даритель', src: 'chat', setId: 'sub-gift-leader', version: '2' },
  { key: 'giftlead3', label: 'Топ-3 даритель', src: 'chat', setId: 'sub-gift-leader', version: '3' },
  { key: 'gifter1', label: 'Sub-gifter · 1+', src: 'chat', setId: 'sub-gifter', minVersion: 1 },
  { key: 'gifter5', label: 'Sub-gifter · 5+', src: 'chat', setId: 'sub-gifter', minVersion: 5 },
  { key: 'gifter10', label: 'Sub-gifter · 10+', src: 'chat', setId: 'sub-gifter', minVersion: 10 },
  { key: 'gifter25', label: 'Sub-gifter · 25+', src: 'chat', setId: 'sub-gifter', minVersion: 25 },
  { key: 'bits1000', label: 'Биты · 1000+', src: 'chat', setId: 'bits', minVersion: 1000 },
  { key: 'bits5000', label: 'Биты · 5000+', src: 'chat', setId: 'bits', minVersion: 5000 },
  { key: 'bits10000', label: 'Биты · 10000+', src: 'chat', setId: 'bits', minVersion: 10000 },
  { key: 'founder', label: 'Founder', src: 'chat', setId: 'founder' },
  { key: 'cliplead1', label: 'Топ-1 клипер', src: 'chat', setId: 'clips-leader', version: '1' },
  { key: 'cliplead2', label: 'Топ-2 клипер', src: 'chat', setId: 'clips-leader', version: '2' },
  { key: 'cliplead3', label: 'Топ-3 клипер', src: 'chat', setId: 'clips-leader', version: '3' },
  { key: 'bitslead1', label: 'Топ-1 по битам', src: 'chat', setId: 'bits-leader', version: '1' },
  { key: 'bitslead2', label: 'Топ-2 по битам', src: 'chat', setId: 'bits-leader', version: '2' },
  { key: 'bitslead3', label: 'Топ-3 по битам', src: 'chat', setId: 'bits-leader', version: '3' },
  { key: 'hypetrain', label: 'Кондуктор хайп-трейна', src: 'chat', setId: 'hype-train' }, // текущий/бывший лидер хайп-трейна; чат-значок, детект по наличию (версии 1=текущий, 2=бывший)
];

// URL картинки значка из карты getChatBadges (set_id→version_id→url). entry — элемент MOVIE_BADGE_POOL.
// null, если значка нет (напр. «фолловер» — у Twitch нет такого значка). Саб — базовая иконка (тир в значке не кодируется).
export function movieBadgeImage(entry, map) {
  if (!entry || !map) return null;
  if (entry.src === 'helix') {
    const setId = entry.key === 'vip' ? 'vip' : entry.key === 'mod' ? 'moderator' : entry.sub ? 'subscriber' : null;
    const vers = setId && map[setId];
    if (!vers) return null; // follower — значка нет
    return vers['1'] || vers['0'] || Object.values(vers)[0] || null;
  }
  const vers = map[entry.setId];
  if (!vers) return null;
  if (entry.version != null) return vers[String(entry.version)] || null;                               // giftlead/cliplead/bitslead/hypetrain
  if (entry.minVersion != null) return vers[String(entry.minVersion)] || Object.values(vers)[0] || null; // gifter/bits — по порогу
  return vers['0'] || vers['1'] || Object.values(vers)[0] || null;                                     // по наличию (founder/artist)
}

// Какие из ВЫБРАННЫХ значков есть у зрителя сейчас. selected: [{key,price}];
// chatBadges: [{set_id,id}] из сообщения; status: { subTier:0|1|2|3, vip, mod, follower } из Helix.
export function applicableMovieBadges(selected, chatBadges, status) {
  const verBySet = new Map();
  for (const b of (Array.isArray(chatBadges) ? chatBadges : [])) verBySet.set(b.set_id, b.id);
  const st = status || {};
  const out = [];
  for (const sel of (Array.isArray(selected) ? selected : [])) {
    const p = MOVIE_BADGE_POOL.find((x) => x.key === sel.key);
    if (!p) continue;
    let ok = false;
    if (p.src === 'helix') {
      if (p.sub) ok = st.subTier === p.sub;
      else if (p.key === 'vip') ok = !!st.vip;
      else if (p.key === 'mod') ok = !!st.mod;
      else if (p.key === 'follower') ok = !!st.follower;
    } else {
      const ver = verBySet.get(p.setId);
      if (ver != null) {
        if (p.version != null) ok = String(ver) === String(p.version);
        else if (p.minVersion != null) ok = (parseInt(ver, 10) || 0) >= p.minVersion;
        else ok = true; // founder и т.п. — по факту наличия
      }
    }
    if (ok) out.push({ key: sel.key, price: Number(sel.price) || 0 });
  }
  return out;
}

// Генерирует код Apps Script (doPost) с подставленными настройками + секретом.
// Лист ищется по имени вкладки (sheetName, обязательно); столбцы/строка — из настроек; столбец баллов — pointsCol или отдельный buyPointsCol.
// Какие столбцы/лист зашьются в скрипт при текущих настройках — для сравнения с задеплоенным (детект «скрипт устарел»).
export function expectedScriptConfig(s) {
  const nickIdx = colToIndex(s.nickCol);
  let ptsIdx = colToIndex((s.buySameCol === false && s.buyPointsCol) ? s.buyPointsCol : s.pointsCol);
  if (ptsIdx < 0) ptsIdx = colToIndex(s.pointsCol); // невалидный столбец покупок → откат на основной
  return { nickCol: nickIdx + 1, pointsCol: ptsIdx + 1, firstRow: Math.max(1, parseInt(s.firstRow, 10) || 2), sheetName: (s.sheetName || '').trim() };
}

export function buildAppsScript(s, secret) {
  const { nickCol, pointsCol: ptsCol, firstRow, sheetName } = expectedScriptConfig(s);
  if (!sheetName) throw new Error('Укажи имя листа (вкладки) в настройках.');
  if (nickCol < 1 || ptsCol < 1) throw new Error('Неверно указан столбец ника/баллов (нужно A, B, … или номер).');
  return [
    '/**',
    ' * PigPoints — приём начислений за балы канала (сгенерировано расширением).',
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
    "    if (b.ping) { const ps = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME); return out({ ok: true, sheet: SHEET_NAME, sheetFound: !!ps, nickCol: NICK_COL, pointsCol: POINTS_COL, firstRow: FIRST_ROW }); }", // столбцы — для детекта «скрипт устарел» // хелсчек без записи
    "    const nick = String(b.nick || '').trim().replace(/^@+/, '');", // убрать ведущий @
    '    const pts  = Number(b.points);',
    "    if (!nick || !isFinite(pts)) return out({ ok: false, error: 'bad input' });",
    '    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);',
    "    if (!sh) return out({ ok: false, error: 'sheet not found: ' + SHEET_NAME });",
    '    const last = sh.getLastRow();',
    '    const col = last >= FIRST_ROW ? sh.getRange(FIRST_ROW, NICK_COL, last - FIRST_ROW + 1, 1).getValues() : [];',
    '    let row = -1, lastNick = FIRST_ROW - 1;',
    '    for (let i = 0; i < col.length; i++) {',
    '      const v = String(col[i][0]).trim();',
    "      if (v !== '') lastNick = FIRST_ROW + i;",                  // последняя непустая ячейка СТОЛБЦА НИКА
    "      if (v.replace(/^@+/, '').toLowerCase() === nick.toLowerCase()) { row = FIRST_ROW + i; break; }", // матч без учёта регистра и ведущего @
    '    }',
    '    if (row === -1) { row = lastNick + 1; sh.getRange(row, NICK_COL).setValue(nick); sh.getRange(row, POINTS_COL).setValue(0); }', // новый ник — сразу после последнего ника
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

// ───────────────────────── ставка за значки + рейтинг: детект «свой/чужой» ─────────────────────────
// Фаззи-матч названия фильма по доске (та же метрика, что «похожий лот» в pointauc) + «единственный
// реальный вкладчик» (как buildPlan, метки [PP] не считаем). login — twitch-логин зрителя.
// → { isNew, isSole, matchedName, score }.
export function findMovieLot(lots, title, login, prefix = LOT_PREFIX, threshold = 0.4) {
  let best = null, score = 0;
  for (const l of (Array.isArray(lots) ? lots : [])) {
    const sc = diceSimilarity(title, l.name);
    if (sc > threshold && sc > score) { best = l; score = sc; }
  }
  if (!best) return { isNew: true, isSole: false, matchedName: null, score: 0 };
  const real = new Set((best.investors || []).filter((inv) => !isMark(inv, prefix)).map(norm));
  const isSole = real.size === 1 && real.has(norm(login));
  return { isNew: false, isSole, matchedName: best.name, score };
}

// Решение по вкладу PigPoints в ставку за значки. lot: null | { isNew, isSole } | { error: true }.
// Правило: плюс — всегда. Минус — если dropNegForeign=false, то везде; иначе только когда лот новый ИЛИ
// зритель единственный реальный вкладчик (в общий лот не идёт). Дедуп: учитывается раз в раунд (alreadyApplied → 0).
// → { value, ownership: ''|'plus'|'minus'|'new'|'sole'|'foreign'|'unknown', reason }.
export function moviePointsDecision({ points, usePoints, alreadyApplied, lot, dropNegForeign = true }) {
  if (!usePoints) return { value: 0, ownership: '', reason: 'PigPoints выкл' };
  if (alreadyApplied) return { value: 0, ownership: '', reason: 'PigPoints уже учтены в раунде' };
  if (!Number.isFinite(points) || points === 0) return { value: 0, ownership: '', reason: '' };
  if (points > 0) return { value: points, ownership: 'plus', reason: '' };
  if (!dropNegForeign) return { value: points, ownership: 'minus', reason: '' }; // галка выкл → минус везде
  if (!lot || lot.error) return { value: 0, ownership: 'unknown', reason: 'минус не применён: доска недоступна' };
  if (lot.isNew) return { value: points, ownership: 'new', reason: '' };
  if (lot.isSole) return { value: points, ownership: 'sole', reason: '' };
  return { value: 0, ownership: 'foreign', reason: 'минус не учтён: поддув в общий лот' };
}

// ⚠️ DEPRECATED (на удаление): ручной залив PigPoints из таблицы в лоты — buildPlan/resolveChoice/executePlan/
// buildRollbackPlan/planRollbackPuts/executeRollback/updateLot. UI убран; авто-формула фильм-ставки это заменяет.
export function buildPlan(rows, lots, s) {
  const prefix = LOT_PREFIX;
  const effInvestors = (l) => (l.investors || []).filter((inv) => !isMark(inv, prefix)); // реальные вкладчики

  return rows.map((r) => {
    const it = { nick: r.nick, points: r.points, rawPoints: r.rawPoints, investor: markName(prefix, r.nick, r.points), isDonation: !!s.asDonation };

    if (!r.nick) return Object.assign(it, { action: 'skip', reason: 'пустой ник' });
    if (!Number.isFinite(r.points)) return Object.assign(it, { action: 'skip', reason: `не число: "${r.rawPoints}"` });
    if (r.points === 0 && s.skipZero) return Object.assign(it, { action: 'skip', reason: 'ноль' });
    if (r.points < 0 && !s.allowNegative) return Object.assign(it, { action: 'skip', reason: 'минус выключен' });

    // совпадение по реальному вкладчику (метки [PP] не учитываем)
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
export function resolveChoice(it, choice, prefix = LOT_PREFIX, lotsById = {}) {
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
export function buildRollbackPlan(lots, prefix = LOT_PREFIX) {
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
