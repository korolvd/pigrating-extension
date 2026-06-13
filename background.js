// Фоновый service worker: выполняет готовый план заливки независимо от popup.
// Окно расширения можно закрыть (переключиться на аук) — заливка дойдёт до конца.

import { executePlan } from './core.js';

let running = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'apply') {
    runApply(msg.plan).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true; // ответ асинхронный; SW живёт, пока промис не зарезолвится
  }
});

const broadcast = (m) => chrome.runtime.sendMessage(m).catch(() => {}); // popup мог закрыться — игнорируем

async function runApply(plan) {
  if (running) return { error: 'Заливка уже идёт.' };
  if (!Array.isArray(plan) || !plan.length) return { error: 'Пустой план.' };
  running = true;
  try {
    const { token } = await chrome.storage.local.get('token');
    if (!token) throw new Error('Не задан Personal Token.');

    const total = plan.filter((it) => it.action === 'update' || it.action === 'create').length;
    broadcast({ type: 'progress', done: 0, total });
    await executePlan(token, plan, (done, t) => broadcast({ type: 'progress', done, total: t }));

    const ok = plan.filter((it) => it.status === 'ok').length;
    const err = plan.filter((it) => it.status === 'error').length;
    const result = { at: Date.now(), ok, err, plan };
    await chrome.storage.local.set({ lastResult: result, lastApplied: { at: result.at, count: ok } });
    broadcast({ type: 'done', ok, err });
    return { ok, err };
  } catch (e) {
    broadcast({ type: 'error', message: e.message });
    return { error: e.message };
  } finally {
    running = false;
  }
}
