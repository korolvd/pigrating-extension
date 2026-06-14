// Фоновый service worker: выполняет заливку и откат независимо от popup.
// Окно расширения можно закрыть — операция дойдёт до конца.

import { executePlan, executeRollback } from './core.js';

let running = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'apply') { runApply(msg.plan).then(sendResponse).catch((e) => sendResponse({ error: e.message })); return true; }
  if (msg?.type === 'rollback') { runRollback(msg.items).then(sendResponse).catch((e) => sendResponse({ error: e.message })); return true; }
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
