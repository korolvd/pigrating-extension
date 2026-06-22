// Фоновый service worker: выполняет заливку и откат независимо от popup.
// Окно расширения можно закрыть — операция дойдёт до конца.

import { executePlan, executeRollback, resolveRedemption, addPoints, normNick } from './core.js';
import { subscribeRedemptions, updateRedemptionStatus, redemptionEvent, userExists, DEFAULT_TWITCH_CLIENT_ID } from './twitch.js';

let running = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'apply') { runApply(msg.plan).then(sendResponse).catch((e) => sendResponse({ error: e.message })); return true; }
  if (msg?.type === 'rollback') { runRollback(msg.items).then(sendResponse).catch((e) => sendResponse({ error: e.message })); return true; }
  if (msg?.type === 'twitch-reconnect') { paused = false; ensureListener(); sendResponse?.({ ok: true }); return; }
  if (msg?.type === 'twitch-resolve') { resolvePending(msg.redemptionId, msg.action).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message })); return true; }
  if (msg?.type === 'twitch-resolve-all') { resolveAllPending(msg.action).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message })); return true; }
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
      break;
    case 'revocation':
      await logEvent({ ok: false, note: 'Twitch отозвал подписку (токен/награда) — переподключи канал.' });
      break;
    // session_keepalive — соединение живо, ничего не делаем
  }
}

async function onRedemption(eventPayload) {
  const ev = redemptionEvent(eventPayload);
  if (!ev.redemptionId || seen.has(ev.redemptionId)) return;
  seen.add(ev.redemptionId);
  if (seen.size > 5000) seen.delete(seen.values().next().value); // FIFO-эвикция: дедуп нужен лишь на короткое окно переотправки
  const s = await chrome.storage.local.get(null);
  const res = resolveRedemption(s.rewardMap, ev);
  if (!res) return; // награда не из нашего маппинга — игнор (напр. награда pointauc)
  const ctx = ctxFrom(s);
  if (res.skip) { // обработать нельзя → вернуть баллы
    await updateRedemptionStatus(ctx, ev.rewardId, ev.redemptionId, 'CANCELED').catch(() => {});
    return logEvent({ ok: false, nick: ev.userLogin, note: res.skip });
  }
  // валидация ника: только для адресных (ник ≠ самому редемптору)
  let nickExists = null;
  if (res.nick !== normNick(ev.userLogin)) {
    try { nickExists = await userExists(ctx, res.nick); } catch { nickExists = null; }
  }
  // в очередь на ручное подтверждение стримером (не начисляем сразу)
  await addPending({ redemptionId: ev.redemptionId, rewardId: ev.rewardId, rewardTitle: ev.rewardTitle, nick: res.nick, points: res.points, userLogin: ev.userLogin, nickExists, at: Date.now() });
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
async function resolvePending(redemptionId, action) {
  if (processing.has(redemptionId)) return; // уже обрабатывается (двойной клик)
  processing.add(redemptionId);
  try {
    const item = await claimPending(redemptionId);
    if (!item) return; // уже обработан/удалён
    const s = await chrome.storage.local.get(null);
    const ctx = ctxFrom(s);
    if (action === 'confirm') {
      try {
        const r = await addPoints(s.webAppUrl, s.webAppSecret, item.nick, item.points);
        await updateRedemptionStatus(ctx, item.rewardId, redemptionId, 'FULFILLED').catch(() => {});
        await logEvent({ ok: true, nick: item.nick, points: item.points, total: r && r.total });
      } catch (e) { // запись не удалась → вернуть баллы
        await updateRedemptionStatus(ctx, item.rewardId, redemptionId, 'CANCELED').catch(() => {});
        await logEvent({ ok: false, nick: item.nick, points: item.points, note: e.message });
      }
    } else { // reject
      await updateRedemptionStatus(ctx, item.rewardId, redemptionId, 'CANCELED').catch(() => {});
      await logEvent({ ok: false, nick: item.nick, points: item.points, note: 'отклонено стримером' });
    }
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

chrome.runtime.onStartup?.addListener(ensureListener);
chrome.runtime.onInstalled?.addListener(ensureListener);
chrome.alarms?.create('twitch-keepalive', { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((a) => { if (a.name === 'twitch-keepalive') ensureListener(); });
ensureListener(); // при загрузке/пробуждении воркера
