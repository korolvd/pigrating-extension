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

// ───────────────────────── построение плана ─────────────────────────
export const norm = (s) => (s || '').trim().toLowerCase();
// Инвестор-метка нашего рейтинга — его имя начинается с приставки (его не считаем при матчинге).
const isMark = (inv, prefix) => { const p = norm(prefix); return !!p && norm(inv).startsWith(p); };

export function buildPlan(rows, lots, s) {
  const prefix = s.newLotPrefix || '';
  const effInvestors = (l) => (l.investors || []).filter((inv) => !isMark(inv, prefix)); // реальные вкладчики

  return rows.map((r) => {
    const it = { nick: r.nick, points: r.points, rawPoints: r.rawPoints, investor: prefix + r.nick };

    if (!r.nick) return Object.assign(it, { action: 'skip', reason: 'пустой ник' });
    if (!Number.isFinite(r.points)) return Object.assign(it, { action: 'skip', reason: `не число: "${r.rawPoints}"` });
    if (r.points === 0 && s.skipZero) return Object.assign(it, { action: 'skip', reason: 'ноль' });
    if (r.points < 0 && !s.allowNegative) return Object.assign(it, { action: 'skip', reason: 'минус выключен' });

    // совпадение по реальному вкладчику (метки [СОЦРЕЙТИНГ] не учитываем)
    const matched = lots.filter((l) => effInvestors(l).some((inv) => norm(inv) === norm(r.nick)));
    const candidates = matched.map((l) => ({ id: l.id, fastId: l.fastId, name: l.name, amount: l.amount }));

    // уже залито: где-то есть инвестор-метка этого ника → предупреждаем, по умолчанию пропуск
    const appliedLot = prefix ? lots.find((l) => (l.investors || []).some((inv) => norm(inv) === norm(it.investor))) : null;
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
    ? { cost: it.points, message: `#${it.fastId}`, investorId: it.investor, username: it.investor, insertStrategy: 'match', isDonation: false }
    : { cost: it.points, message: it.target, investorId: it.investor, username: it.investor, insertStrategy: 'force', isDonation: false });

  if (bids.length) {
    try { await postBids(token, bids); items.forEach((it) => { it.status = 'ok'; }); }
    catch (e) { items.forEach((it) => { it.status = 'error'; it.error = e.message; }); }
  }
  onProgress(bids.length, bids.length);
  for (const it of plan) if (!it.status) it.status = 'skip';
  return plan;
}
