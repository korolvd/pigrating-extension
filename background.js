// Фоновый service worker: выполняет заливку и откат независимо от popup.
// Окно расширения можно закрыть — операция дойдёт до конца.

import { executePlan, executeRollback, resolveRedemption, addPoints, normNick, fetchSheetRows, suggestNick, applicableMovieBadges, postBids } from './core.js';
import { subscribeRedemptions, updateRedemptionStatus, redemptionEvent, userExists, subscribeChatMessages, chatMessageEvent, getSubTier, isVip, isMod, isFollower, DEFAULT_TWITCH_CLIENT_ID } from './twitch.js';

let running = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'apply') { runApply(msg.plan).then(sendResponse).catch((e) => sendResponse({ error: e.message })); return true; }
  if (msg?.type === 'rollback') { runRollback(msg.items).then(sendResponse).catch((e) => sendResponse({ error: e.message })); return true; }
  if (msg?.type === 'twitch-reconnect') { paused = false; ensureListener(); sendResponse?.({ ok: true }); return; }
  if (msg?.type === 'twitch-resolve') { resolvePending(msg.redemptionId, msg.action, msg.overrideNick).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message })); return true; }
  if (msg?.type === 'twitch-resolve-all') { resolveAllPending(msg.action).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message })); return true; }
  if (msg?.type === 'movie-subscribe') { subscribeMovieChat().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message })); return true; } // тумблер фичи включили в середине сессии → поднять чат-подписку
  if (msg?.type === 'movie-new-round') { newMovieRound().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message })); return true; } // сброс раунда атомарно в SW
});

const broadcast = (m) => chrome.runtime.sendMessage(m).catch(() => {});

async function token() {
  const { token } = await chrome.storage.local.get('token');
  if (!token) throw new Error('Не задан Personal Token.');
  return token;
}

async function runApply(plan) {
  if (running) return { error: 'Операция уже идёт.' };
  if (!Array.isArray(plan) || !plan.length) return { error: 'Пустой план.' };
  running = true;
  try {
    const tok = await token();
    const total = plan.filter((it) => it.action === 'update' || it.action === 'create').length;
    broadcast({ type: 'progress', done: 0, total });
    await executePlan(tok, plan, (done, t) => broadcast({ type: 'progress', done, total: t }));
    const ok = plan.filter((it) => it.status === 'ok').length;
    const err = plan.filter((it) => it.status === 'error').length;
    await chrome.storage.local.set({ lastResult: { at: Date.now(), ok, err, plan }, lastApplied: { at: Date.now(), count: ok } });
    broadcast({ type: 'done', ok, err });
    return { ok, err };
  } catch (e) { broadcast({ type: 'error', message: e.message }); return { error: e.message }; }
  finally { running = false; }
}

async function runRollback(items) {
  if (running) return { error: 'Операция уже идёт.' };
  if (!Array.isArray(items) || !items.length) return { error: 'Нечего откатывать.' };
  running = true;
  try {
    const tok = await token();
    broadcast({ type: 'progress', done: 0, total: items.length });
    const puts = await executeRollback(tok, items, (done, t) => broadcast({ type: 'progress', done, total: t }));
    const ok = puts.filter((p) => p.status === 'ok').length;
    const err = puts.filter((p) => p.status === 'error').length;
    await chrome.storage.local.set({ lastRollback: { at: Date.now(), ok, err } });
    broadcast({ type: 'done', ok, err });
    return { ok, err };
  } catch (e) { broadcast({ type: 'error', message: e.message }); return { error: e.message }; }
  finally { running = false; }
}

// ───────────────────────── Twitch EventSub: покупка рейтинга ─────────────────────────
const WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
let ws = null;          // активный сокет
let pendingWs = null;   // новый сокет во время graceful-reconnect (Twitch session_reconnect)
let sessionId = null;
let reconnectTimer = null;
let backoffMs = 1000;
let paused = false;     // невалидный токен (401/403): не переподключаемся авто, ждём ручного «Подключить»
const seen = new Set(); // id редемпшенов — дедуп (сбрасывается при перезапуске SW, не страшно)
const processing = new Set(); // редемпшены в процессе подтверждения/отказа — защита от двойного клика
// сериализация RMW над twitchPending/twitchLog (chrome.storage не атомарен → гонки теряют/воскрешают записи)
function mutex() { let chain = Promise.resolve(); return (fn) => { const run = chain.then(() => fn()); chain = run.catch(() => {}); return run; }; }
const lockPending = mutex();
const lockLog = mutex();

const ctxFrom = (s) => ({ clientId: s.twitchClientId || DEFAULT_TWITCH_CLIENT_ID, token: s.twitchToken, broadcasterId: s.twitchUserId });

function detach(s) { if (s) { s.onopen = s.onclose = s.onmessage = s.onerror = null; } }
function killSock(s) { detach(s); if (s) { try { s.close(); } catch { /* ignore */ } } }

function closeWs() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  killSock(ws); killSock(pendingWs);
  ws = null; pendingWs = null; sessionId = null; paused = false;
}

// Быстрый авто-reconnect после неожиданного обрыва (экспоненциальный backoff до 60с); alarm — страховка.
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, 60000);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; ensureListener(); }, delay);
}

function bind(sock) {
  sock.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } handleWs(sock, m); };
  sock.onerror = () => { /* далее onclose */ };
}

// Первичное подключение / авто-reconnect: сокет сразу становится основным.
function connect(url) {
  const sock = new WebSocket(url);
  ws = sock;
  bind(sock);
  sock.onclose = () => { if (ws === sock) { ws = null; sessionId = null; scheduleReconnect(); } };
}

// Graceful-reconnect: поднять новый сокет, старый держать живым до его session_welcome.
function reconnectTo(url) {
  killSock(pendingWs);
  const sock = new WebSocket(url);
  pendingWs = sock;
  bind(sock);
  sock.onclose = () => { if (pendingWs === sock) pendingWs = null; };
}

// Поднять слушатель, если подключён Twitch и он ещё не активен.
async function ensureListener() {
  const s = await chrome.storage.local.get(['twitchToken', 'twitchUserId']);
  if (!s.twitchToken || !s.twitchUserId) { closeWs(); return; }
  if (paused) return;                                       // токен невалиден — ждём ручного переподключения
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (pendingWs || reconnectTimer) return;
  connect(WS_URL);
}

async function handleWs(sock, msg) {
  const meta = msg.metadata || {};
  switch (meta.message_type) {
    case 'session_welcome': {
      sessionId = msg.payload.session.id;
      if (sock === pendingWs) {
        // graceful-reconnect завершён: Twitch перенёс подписки сам — НЕ переподписываемся
        killSock(ws);
        ws = sock; pendingWs = null;
        sock.onclose = () => { if (ws === sock) { ws = null; sessionId = null; scheduleReconnect(); } };
        backoffMs = 1000;
      } else {
        try {
          const s = await chrome.storage.local.get(null);
          await subscribeRedemptions(ctxFrom(s), sessionId);
          backoffMs = 1000;                                  // сброс backoff ТОЛЬКО после успешной подписки
          if (s.movieBidsActive) { // фича «ставка за значки» → ещё и сообщения чата (нужен скоуп user:read:chat)
            try { await subscribeChatMessages(ctxFrom(s), sessionId); }
            catch (e2) { await logEvent({ ok: false, note: `чат-подписка не удалась (переподключи Twitch для нового доступа): ${e2.message}` }); }
          }
        } catch (e) {
          killSock(ws); ws = null; sessionId = null;          // не держим живой сокет без подписки (Twitch его всё равно закроет ~10с)
          await logEvent({ ok: false, note: `подписка не удалась: ${e.message}` });
          if (e.status === 401 || e.status === 403) paused = true; // невалидный токен → пауза до ручного «Подключить» (без цикла)
          else scheduleReconnect();                            // временная ошибка → ретрай с backoff
        }
      }
      break;
    }
    case 'session_reconnect':
      reconnectTo(msg.payload.session.reconnect_url);
      break;
    case 'notification':
      if (meta.subscription_type === 'channel.channel_points_custom_reward_redemption.add') await onRedemption(msg.payload.event);
      else if (meta.subscription_type === 'channel.chat.message') await onMovieChat(msg.payload.event);
      break;
    case 'revocation':
      await logEvent({ ok: false, note: 'Twitch отозвал подписку (токен/награда) — переподключи канал.' });
      break;
    // session_keepalive — соединение живо, ничего не делаем
  }
}

// Обновить статус редемпшена на Twitch; вернуть текст ошибки или null (раньше ошибки глохли в .catch — возврат «молча» не срабатывал).
async function setRedemption(ctx, rewardId, redemptionId, status) {
  try { await updateRedemptionStatus(ctx, rewardId, redemptionId, status); return null; }
  catch (e) { return e.message; }
}

// Кэш ростера (ники из таблицы) для подсказок похожих ников. SW может выгрузиться → перечитаем по TTL.
let rosterCache = { at: 0, nicks: [] };
async function getRoster(s) {
  if (!s.sheetUrl) return []; // ростер читается из таблицы по ссылке
  if (Date.now() - rosterCache.at < 60000 && rosterCache.nicks.length) return rosterCache.nicks;
  try {
    const rows = await fetchSheetRows(s.sheetUrl, s);
    rosterCache = { at: Date.now(), nicks: rows.map((r) => r.nick).filter(Boolean) };
  } catch { /* таблица недоступна — оставляем прошлый кэш (или пусто) */ }
  return rosterCache.nicks;
}

// Начислить баллы + подтвердить (FULFILLED); при ошибке записи — вернуть баллы (CANCELED). Ошибки Twitch видны в логе.
async function creditItem(s, ctx, item) {
  let entry;
  const corr = item.correctedFrom ? `исправлено: ${item.correctedFrom} → ${item.nick}` : '';
  try { // в try только addPoints (бросает при ошибке записи); setRedemption свои ошибки не бросает
    const r = await addPoints(s.webAppUrl, s.webAppSecret, item.nick, item.points);
    const err = await setRedemption(ctx, item.rewardId, item.redemptionId, 'FULFILLED');
    entry = { ok: true, nick: item.nick, buyer: item.userLogin, points: item.points, total: r && r.total, note: [corr, err ? `⚠ подтверждение Twitch не прошло: ${err}` : ''].filter(Boolean).join(' · ') };
  } catch (e) {
    const err = await setRedemption(ctx, item.rewardId, item.redemptionId, 'CANCELED');
    entry = { ok: false, nick: item.nick, buyer: item.userLogin, points: item.points, note: `запись не удалась: ${e.message}` + (err ? ` · ⚠ возврат не прошёл: ${err}` : ' · баллы возвращены') };
  }
  await logEvent(entry); // вне try: сбой записи лога не должен триггерить ложный возврат
}

// Вернуть баллы зрителю (CANCELED) + лог; видно, если возврат не прошёл.
async function refundItem(ctx, item, reason) {
  const err = await setRedemption(ctx, item.rewardId, item.redemptionId, 'CANCELED');
  await logEvent({ ok: false, nick: item.nick, buyer: item.userLogin, points: item.points, note: reason + (err ? ` · ⚠ возврат не прошёл: ${err}` : ' · баллы возвращены') });
}

async function onRedemption(eventPayload) {
  const ev = redemptionEvent(eventPayload);
  if (!ev.redemptionId || seen.has(ev.redemptionId)) return;
  seen.add(ev.redemptionId);
  if (seen.size > 5000) seen.delete(seen.values().next().value); // FIFO-эвикция: дедуп нужен лишь на короткое окно переотправки
  const s = await chrome.storage.local.get(null);
  if (s.movieRewardId && ev.rewardId === s.movieRewardId) { // награда «Предложить фильм»
    if (s.movieBidsActive) return onMovieRedemption({ redemptionId: ev.redemptionId, userId: ev.userId, userLogin: ev.userLogin, movie: ev.userInput || '' }); // значки придут из чата
    await setRedemption(ctxFrom(s), s.movieRewardId, ev.redemptionId, 'CANCELED'); // фича выкл → вернуть балл, не зависать
    return;
  }
  const res = resolveRedemption(s.rewardMap, ev);
  if (!res) return; // награда не из нашего маппинга — игнор (напр. награда pointauc)
  const ctx = ctxFrom(s);
  const base = { redemptionId: ev.redemptionId, rewardId: ev.rewardId, rewardTitle: ev.rewardTitle, userLogin: ev.userLogin };
  if (res.skip) return refundItem(ctx, { ...base, nick: ev.userLogin }, res.skip); // обработать нельзя → вернуть баллы
  // Адресная покупка (ник ≠ самому редемптору). Себе/пустой ввод — всегда авто.
  const isAddressed = res.target === 'input' && res.nick !== normNick(ev.userLogin);
  let nickExists = null, suggestion = null, autoEligible = true;
  if (isAddressed) {
    const roster = await getRoster(s);
    if (roster.length) {
      if (roster.some((r) => normNick(r) === res.nick)) {
        autoEligible = true; // точный участник таблицы → сразу
      } else {
        suggestion = suggestNick(res.nick, roster); // лучший похожий из таблицы или null
        if (suggestion) { // есть похожий → вероятная опечатка, на ручную проверку
          autoEligible = false;
          try { nickExists = await userExists(ctx, res.nick); } catch { nickExists = null; }
        } else {
          autoEligible = true; // похожих нет → новый участник, начисляем без подтверждения
        }
      }
    } else {
      // ростер недоступен → деградация к прежнему поведению: гейт по наличию на Twitch
      try { nickExists = await userExists(ctx, res.nick); } catch { nickExists = null; }
      autoEligible = nickExists === true;
    }
  }
  const item = { ...base, nick: res.nick, points: res.points, nickExists, suggestion, at: Date.now() };
  // get(null) не мерджит DEFAULTS, поэтому отсутствие ключа = дефолт true.
  const autoApprove = s.twitchAutoApprove !== false;
  if (autoApprove && autoEligible) await creditItem(s, ctx, item);
  else await addPending(item);
}

function addPending(item) {
  return lockPending(async () => {
    const { twitchPending = [] } = await chrome.storage.local.get('twitchPending');
    if (twitchPending.some((p) => p.redemptionId === item.redemptionId)) return; // дедуп
    twitchPending.unshift(item);
    await chrome.storage.local.set({ twitchPending: twitchPending.slice(0, 200) });
    broadcast({ type: 'twitch-pending' });
  });
}

// атомарно «забрать» item из очереди (удалить и вернуть) — чтобы не обработать дважды
function claimPending(redemptionId) {
  return lockPending(async () => {
    const { twitchPending = [] } = await chrome.storage.local.get('twitchPending');
    const item = twitchPending.find((p) => p.redemptionId === redemptionId);
    if (!item) return null;
    await chrome.storage.local.set({ twitchPending: twitchPending.filter((p) => p.redemptionId !== redemptionId) });
    broadcast({ type: 'twitch-pending' });
    return item;
  });
}

// Решение стримера: confirm → начислить + FULFILLED; reject → CANCELED (возврат баллов зрителю).
// item убираем из очереди ДО начисления (at-most-once: при гибели SW безопаснее missed credit, чем двойной).
async function resolvePending(redemptionId, action, overrideNick) {
  if (processing.has(redemptionId)) return; // уже обрабатывается (двойной клик)
  processing.add(redemptionId);
  try {
    const item = await claimPending(redemptionId);
    if (!item) return; // уже обработан/удалён
    const s = await chrome.storage.local.get(null);
    const ctx = ctxFrom(s);
    if (action === 'confirm') {
      const corrected = String(overrideNick || '').trim();
      // стример выбрал похожий ник из таблицы → начисляем на него (исправление опечатки)
      if (corrected && normNick(corrected) !== item.nick) await creditItem(s, ctx, { ...item, nick: corrected, correctedFrom: item.nick });
      else await creditItem(s, ctx, item);
    } else await refundItem(ctx, item, 'отклонено стримером');
  } finally { processing.delete(redemptionId); }
}

// «подтвердить/отклонить все» — по снимку очереди, каждый элемент атомарно через resolvePending.
async function resolveAllPending(action) {
  const { twitchPending = [] } = await chrome.storage.local.get('twitchPending');
  for (const p of twitchPending.slice()) await resolvePending(p.redemptionId, action);
}

function logEvent(entry) {
  return lockLog(async () => {
    const { twitchLog = [] } = await chrome.storage.local.get('twitchLog');
    twitchLog.unshift({ at: Date.now(), ...entry });
    await chrome.storage.local.set({ twitchLog: twitchLog.slice(0, 30) });
    broadcast({ type: 'twitch-log' });
  });
}

// ── фича «ставка за значки на фильм» ──
// Надёжно, как рейтинговая ветка: незавершённые активации персистятся (moviePending) → переживают сон SW;
// обработка сериализована (drainMovie singleton + claim-перед-обработкой = at-most-once); «зачтённое» —
// отдельный movieCounted (без капа, авторитетный источник анти-повтора), журнал — только для показа.
const seenMsg = new Set();   // дедуп сообщений чата
const lockMovie = mutex();   // RMW над moviePending/movieCounted/movieJournal
const movieChat = new Map(); // userId|текст → { badges, at } — чат-значки (порядок событий в рамках сессии)
const movieNorm = (t) => String(t || '').trim().toLowerCase();
const movieKey = (userId, text) => `${userId}|${movieNorm(text)}`;
let draining = false;
let movieGen = 0; // поколение раунда: in-flight активация со старым gen не пишет в новый раунд (сброс во время обработки)

// redemption.add награды «Предложить фильм» → персист незавершённой активации (по redemptionId — без коллизий)
async function onMovieRedemption(red) { // { redemptionId, userId, userLogin, movie }
  await lockMovie(async () => {
    const { moviePending = [] } = await chrome.storage.local.get('moviePending');
    if (moviePending.some((p) => p.redemptionId === red.redemptionId)) return; // дедуп
    const c = movieChat.get(movieKey(red.userId, red.movie)); // чат уже пришёл? — забрать значки сразу
    moviePending.push({ ...red, badges: c ? c.badges : null, at: Date.now() });
    await chrome.storage.local.set({ moviePending });
  });
  drainMovie();
  setTimeout(drainMovie, 8500); // ждём чат до ~8с (если SW жив); иначе подхватит alarm/рестарт
}

// channel.chat.message награды → значки ожидающей активации (или в кэш, если редемпшен ещё не пришёл)
async function onMovieChat(eventPayload) {
  const ev = chatMessageEvent(eventPayload);
  if (!ev.rewardId || !ev.messageId) return;
  const { movieRewardId, movieBidsActive } = await chrome.storage.local.get(['movieRewardId', 'movieBidsActive']);
  if (!movieBidsActive || !movieRewardId || ev.rewardId !== movieRewardId) return;  // фича выкл / не наша награда
  if (seenMsg.has(ev.messageId)) return;
  seenMsg.add(ev.messageId); if (seenMsg.size > 5000) seenMsg.delete(seenMsg.values().next().value);
  const key = movieKey(ev.userId, ev.text || '');
  const now = Date.now();
  movieChat.set(key, { badges: ev.badges || [], at: now });
  for (const [k, v] of movieChat) if (now - v.at > 30000) movieChat.delete(k); // прунинг
  let attached = false;
  await lockMovie(async () => {
    const { moviePending = [] } = await chrome.storage.local.get('moviePending');
    const m = moviePending.find((p) => p.badges === null && movieKey(p.userId, p.movie) === key);
    if (!m) return;
    m.badges = ev.badges || [];
    await chrome.storage.local.set({ moviePending });
    attached = true;
  });
  if (attached) drainMovie();
}

// Сериализованная обработка готовых (есть значки) и протухших (>8с) активаций. claim-перед-обработкой → at-most-once.
// Сброс раунда атомарно в SW: бамп поколения + очистка очереди/зачёта/журнала/кэшей под lockMovie.
// gen-бамп под локом сериализуется с markMovieCounted/logMovie → стрэглер прошлого раунда не запишется в новый.
async function newMovieRound() {
  movieChat.clear(); seenMsg.clear();
  const leftover = await lockMovie(async () => {
    const { moviePending = [] } = await chrome.storage.local.get('moviePending');
    movieGen++;
    await chrome.storage.local.set({ moviePending: [], movieCounted: {}, movieJournal: [] });
    return moviePending; // незавершённые активации прошлого раунда (claim-нутые drain'ом сюда не попадут)
  });
  if (leftover.length) { // вернуть баллы по ним, чтобы не зависли в очереди Twitch
    const s = await chrome.storage.local.get(null);
    const ctx = ctxFrom(s);
    for (const p of leftover) await setRedemption(ctx, s.movieRewardId, p.redemptionId, 'CANCELED');
  }
  broadcast({ type: 'movie-journal' });
}

// Подписаться на channel.chat.message на ЖИВОЙ сессии (когда тумблер включили после подключения Twitch).
async function subscribeMovieChat() {
  if (!(ws && ws.readyState === WebSocket.OPEN && sessionId)) return; // нет живой сессии — подпишемся при welcome
  const s = await chrome.storage.local.get(null);
  try { await subscribeChatMessages(ctxFrom(s), sessionId); }
  catch (e) { if (e.status !== 409) await logEvent({ ok: false, note: `чат-подписка не удалась (переподключи Twitch для нового доступа): ${e.message}` }); } // 409 = уже подписаны
}

async function drainMovie() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const item = await lockMovie(async () => {
        const { moviePending = [] } = await chrome.storage.local.get('moviePending');
        const now = Date.now();
        const idx = moviePending.findIndex((p) => p.badges !== null || (now - p.at) >= 8000);
        if (idx < 0) return null;
        const [it] = moviePending.splice(idx, 1);
        it.__gen = movieGen; // штамп раунда на момент claim
        await chrome.storage.local.set({ moviePending });
        return it;
      });
      if (!item) break;
      await processMovieItem(item).catch(() => {});
    }
  } finally { draining = false; }
}

async function processMovieItem(item) { // { redemptionId, userId, userLogin, movie, badges|null }
  const s = await chrome.storage.local.get(null);
  const ctx = ctxFrom(s);
  const movie = (item.movie || '').trim();
  const userLogin = item.userLogin || '';
  const gen = item.__gen; // поколение раунда на момент claim
  const selected = Array.isArray(s.movieBadges) ? s.movieBadges : [];
  const keys = selected.map((b) => b.key);
  // свежие статусы Helix по user_id — только для выбранных типов (параллельно)
  const status = { subTier: 0, vip: false, mod: false, follower: false };
  const tasks = [];
  if (keys.some((k) => k === 'sub1' || k === 'sub2' || k === 'sub3')) tasks.push(getSubTier(ctx, item.userId).then((t) => { status.subTier = t; }).catch(() => {}));
  if (keys.includes('vip')) tasks.push(isVip(ctx, item.userId).then((v) => { status.vip = v; }).catch(() => {}));
  if (keys.includes('mod')) tasks.push(isMod(ctx, item.userId).then((v) => { status.mod = v; }).catch(() => {}));
  if (keys.includes('follower')) tasks.push(isFollower(ctx, item.userId).then((v) => { status.follower = v; }).catch(() => {}));
  await Promise.all(tasks);
  const cached = movieChat.get(movieKey(item.userId, item.movie)); // чат мог приехать в кэш после создания pending
  const applicable = applicableMovieBadges(selected, item.badges || (cached && cached.badges) || [], status);
  const base = s.movieBase == null ? 1 : (parseInt(s.movieBase, 10) || 0); // get(null) не мерджит DEFAULTS
  // зачтённое в раунде — из movieCounted (авторитетно, без капа). drainMovie сериализует, гонок нет.
  const movieCounted = (s.movieCounted && typeof s.movieCounted === 'object') ? s.movieCounted : {};
  const prior = movieCounted[item.userId];
  const participated = Array.isArray(prior);
  const counted = new Set(prior || []);
  const fresh = applicable.filter((a) => !counted.has(a.key));
  const amount = base + fresh.reduce((n, a) => n + (Number(a.price) || 0), 0);
  if (movieGen !== gen) { await setRedemption(ctx, s.movieRewardId, item.redemptionId, 'CANCELED'); return; } // раунд сброшен пока считали → возврат, без записи в новый
  if (!((fresh.length || !participated) && amount > 0)) { // нет новых значков (уже участвовал) или сумма 0 → возврат
    const err = await setRedemption(ctx, s.movieRewardId, item.redemptionId, 'CANCELED');
    return logMovie({ ok: false, refunded: true, userId: item.userId, userLogin, movie, note: err ? `возврат не прошёл: ${err}` : '' }, gen);
  }
  let bidErr = '';
  try { await postBids(s.token, [{ cost: amount, message: movie, username: userLogin, investorId: item.userId, insertStrategy: 'none', isDonation: !!s.movieAsDonation }]); }
  catch (e) { bidErr = e.message; }
  if (bidErr) { // ставка не ушла → возврат балла; значки НЕ зачтены (можно повторить)
    const err = await setRedemption(ctx, s.movieRewardId, item.redemptionId, 'CANCELED');
    return logMovie({ ok: false, refunded: true, userId: item.userId, userLogin, movie, note: `pointauc: ${bidErr}` + (err ? ` · возврат не прошёл: ${err}` : '') }, gen);
  }
  if (movieGen !== gen) { await setRedemption(ctx, s.movieRewardId, item.redemptionId, 'CANCELED'); return; } // раунд сбросили во время ставки → возврат балла, без зачёта (стрэглер-ставка уйдёт в очередь pointauc на ручной разбор)
  await markMovieCounted(item.userId, fresh.map((a) => a.key), gen); // успех → пометить новые значки зачтёнными (если раунд не сброшен)
  const err = await setRedemption(ctx, s.movieRewardId, item.redemptionId, 'FULFILLED');
  return logMovie({ ok: true, userId: item.userId, userLogin, movie, badges: fresh.map((a) => ({ key: a.key, price: a.price })), amount, note: err ? `подтверждение Twitch не прошло: ${err}` : '' }, gen);
}

function markMovieCounted(userId, badgeKeys, gen) { // запоминаем зачтённые ключи (пустой массив тоже создаёт запись → «участвовал»)
  return lockMovie(async () => {
    if (gen !== movieGen) return; // раунд сброшен во время обработки — не пишем в новый
    const { movieCounted = {} } = await chrome.storage.local.get('movieCounted');
    const set = new Set(movieCounted[userId] || []);
    for (const k of badgeKeys) set.add(k);
    movieCounted[userId] = [...set];
    await chrome.storage.local.set({ movieCounted });
  });
}

function logMovie(entry, gen) {
  return lockMovie(async () => {
    if (gen != null && gen !== movieGen) return; // стрэглер прошлого раунда — не в новый журнал
    const { movieJournal = [] } = await chrome.storage.local.get('movieJournal');
    movieJournal.unshift({ at: Date.now(), ...entry });
    await chrome.storage.local.set({ movieJournal: movieJournal.slice(0, 200) }); // только показ; зачёт отдельно в movieCounted
    broadcast({ type: 'movie-journal' });
  });
}

chrome.runtime.onStartup?.addListener(() => { ensureListener(); drainMovie(); });
chrome.runtime.onInstalled?.addListener(() => { ensureListener(); drainMovie(); });
chrome.alarms?.create('twitch-keepalive', { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((a) => { if (a.name === 'twitch-keepalive') { ensureListener(); drainMovie(); } }); // drainMovie — добивает зависшие активации после сна SW
ensureListener(); drainMovie(); // при загрузке/пробуждении воркера
