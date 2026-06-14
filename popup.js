import { DEFAULTS, fetchSheetRows, getLots, buildPlan, resolveChoice, buildRollbackPlan } from './core.js';

let currentPlan = null;       // план залива (предпросмотр)
let currentSettings = null;   // настройки на момент предпросмотра/отката
let currentLots = [];         // лоты на момент предпросмотра
let currentRollback = null;   // список меток для отката
let mode = 'apply';           // 'apply' | 'roll'
let armed = false, armTimer = null; // подтверждение «Залить» вторым кликом

const loadSettings = () => chrome.storage.local.get(DEFAULTS);
const saveSettings = (patch) => chrome.storage.local.set(patch);

const $ = (id) => document.getElementById(id);
const norm = (s) => (s || '').trim().toLowerCase();
const setStatus = (msg, cls = '') => { const el = $('status'); el.textContent = msg; el.className = 'status ' + cls; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ACTION_LABEL = { update: '+ к лоту', create: 'новый лот', skip: 'пропуск', resolve: 'выбрать лот' };
// Порядок: авто «+ к лоту» → много лотов → групповой → без лота → уже залито → пропуск.
const SORT_KEY = (it) => {
  if (it.action === 'update' || it.action === 'create') return 0;
  if (it.action === 'resolve') { if (it.applied) return 4; const n = (it.candidates || []).length; return n >= 2 ? 1 : n === 1 ? 2 : 3; }
  return 5;
};

// селект выбора лота: пропустить + кандидаты (★) + остальные лоты + новый лот
function resolveSelect(it, idx) {
  const candIds = new Set((it.candidates || []).map((c) => String(c.id)));
  const cand = (it.candidates || []).map((c) => `<option value="lot:${esc(c.id)}">★ ${esc(c.name)} (${c.amount})</option>`);
  const others = currentLots.filter((l) => l.name && !candIds.has(String(l.id))).map((l) => `<option value="lot:${esc(l.id)}">${esc(l.name)} (${l.amount ?? 0})</option>`);
  return `<select class="resolve" data-idx="${idx}">${['<option value="skip">— пропустить —</option>', ...cand, ...others, '<option value="new">＋ новый лот</option>'].join('')}</select>`;
}

// ───────────────────────── таблица залива ─────────────────────────
function renderApply(plan, withStatus) {
  const rows = plan.map((it, idx) => {
    const ptsCls = it.points < 0 ? 'neg' : it.points > 0 ? 'pos' : '';
    const pts = Number.isFinite(it.points) ? (it.points > 0 ? '+' : '') + it.points : it.rawPoints;
    const whereCell = (!withStatus && it.action === 'resolve') ? resolveSelect(it, idx) : esc(it.target || '');
    const actClass = it.applied ? 'applied' : it.action;
    const actLabel = it.applied ? '⚠ уже залито' : ACTION_LABEL[it.action];
    const canUndo = it.applied || (withStatus && it.status === 'ok' && (it.action === 'update' || it.action === 'create'));
    const undo = canUndo ? `<button class="undo" data-nick="${esc(it.nick)}" title="Откатить ${esc(it.nick)}" aria-label="Откатить ник">↩</button>` : '';
    const statusCell = withStatus ? `<td><span class="tag ${it.status}">${it.status === 'ok' ? '✓' : it.status === 'error' ? '✕' : '—'}</span></td>` : '';
    return `<tr>
      <td>${esc(it.nick) || '<i>—</i>'}</td>
      <td class="num ${ptsCls}">${pts}</td>
      <td><span class="tag ${actClass}">${actLabel}</span></td>
      <td>${whereCell}</td>
      <td class="muted">${esc(it.reason || '')}</td>
      <td class="act">${undo}</td>
      ${statusCell}
    </tr>`;
  }).join('');
  const counts = plan.reduce((a, it) => ((a[it.action] = (a[it.action] || 0) + 1), a), {});
  const applied = plan.filter((it) => it.applied).length;
  const summary = `+ к лоту: <b>${counts.update || 0}</b> · новых: <b>${counts.create || 0}</b> · выбрать лот: <b>${counts.resolve || 0}</b> · пропуск: <b>${counts.skip || 0}</b>${applied ? ` · ⚠ уже залито: <b>${applied}</b>` : ''}`;
  $('result').innerHTML = `<div class="muted" style="margin:6px 0">${summary}</div>
    <table><thead><tr><th>Ник</th><th class="num">Баллы</th><th>Действие</th><th>Куда</th><th>Примечание</th><th></th>${withStatus ? '<th>Итог</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>`;
}

// ───────────────────────── таблица отката ─────────────────────────
function renderRoll(items) {
  if (!items.length) { $('result').innerHTML = '<div class="muted" style="margin:8px 0">Меток рейтинга на доске нет — откатывать нечего.</div>'; return; }
  const rows = items.map((it, i) => {
    const d = -it.amount; // изменение суммы лота при снятии
    return `<tr>
      <td class="act"><input type="checkbox" class="rcb" data-i="${i}" checked></td>
      <td>${esc(it.lotName) || '<i>—</i>'}</td>
      <td class="muted">${esc(it.investor)}</td>
      <td class="num ${d < 0 ? 'neg' : 'pos'}">${d > 0 ? '+' : ''}${d}</td>
    </tr>`;
  }).join('');
  $('result').innerHTML = `<div class="actions" style="margin-bottom:8px">
      <button id="rollSel" class="danger">Снять выбранные (${items.length})</button>
      <button id="rollAllBtn" class="ghost">Снять все</button>
    </div>
    <table><thead><tr><th class="act"><input type="checkbox" id="rallcb" checked></th><th>Лот</th><th>Метка</th><th class="num">Δ</th></tr></thead><tbody>${rows}</tbody></table>`;

  const cbs = () => Array.from(document.querySelectorAll('.rcb'));
  const upd = () => { $('rollSel').textContent = `Снять выбранные (${cbs().filter((c) => c.checked).length})`; };
  cbs().forEach((c) => c.addEventListener('change', upd));
  $('rallcb').addEventListener('change', (e) => { cbs().forEach((c) => (c.checked = e.target.checked)); upd(); });
  $('rollSel').addEventListener('click', () => doRollback(cbs().filter((c) => c.checked).map((c) => items[+c.dataset.i])));
  $('rollAllBtn').addEventListener('click', () => doRollback(items.slice()));
}

async function showLastApplied() {
  const { lastApplied } = await chrome.storage.local.get('lastApplied');
  $('lastApplied').textContent = lastApplied ? `Последний залив: ${new Date(lastApplied.at).toLocaleString()} — изменено ${lastApplied.count}` : '';
}

// «Откатить» активна только если на доске есть метки рейтинга (+ показывает их число).
async function refreshRollbackButton() {
  const btn = $('rollback');
  const s = await loadSettings();
  if (!s.token) { btn.disabled = true; btn.textContent = '↩ Откатить'; return; }
  try {
    const n = buildRollbackPlan(await getLots(s.token), s.newLotPrefix).length;
    btn.disabled = n === 0;
    btn.textContent = n ? `↩ Откатить (${n})` : '↩ Откатить';
  } catch { btn.disabled = true; btn.textContent = '↩ Откатить'; }
}

// ───────────────────────── предпросмотр залива ─────────────────────────
async function onPreview() {
  disarm(); mode = 'apply'; $('apply').disabled = true; $('result').innerHTML = '';
  const s = await loadSettings();
  if (!s.token) return setStatus('Укажи Personal Token в настройках.', 'error');
  if (!s.sheetUrl) return setStatus('Укажи ссылку на таблицу в настройках.', 'error');
  setStatus('Читаю таблицу и лоты…');
  try {
    const [rows, lots] = await Promise.all([fetchSheetRows(s.sheetUrl, s), getLots(s.token)]);
    currentSettings = s; currentLots = lots;
    currentPlan = buildPlan(rows, lots, s).sort((a, b) => SORT_KEY(a) - SORT_KEY(b));
    renderApply(currentPlan, false);
    const c = currentPlan.reduce((a, it) => ((a[it.action] = (a[it.action] || 0) + 1), a), {});
    setStatus(`План: авто «+ к лоту» ${c.update || 0}${c.resolve ? `, выбрать лот ${c.resolve}` : ''}.`, 'ok');
    $('apply').disabled = !currentPlan.some((it) => ['update', 'create', 'resolve'].includes(it.action));
  } catch (e) { setStatus(e.message, 'error'); }
}

function finalize() {
  const prefix = (currentSettings && currentSettings.newLotPrefix) || '';
  const lotsById = Object.fromEntries(currentLots.map((l) => [String(l.id), l]));
  return (currentPlan || []).map((it, idx) => {
    if (it.action !== 'resolve') return it;
    const sel = document.querySelector(`select.resolve[data-idx="${idx}"]`);
    let choice = 'skip';
    if (sel) { const v = sel.value; choice = v.startsWith('lot:') ? v.slice(4) : v; }
    return resolveChoice(it, choice, prefix, lotsById);
  });
}

// ───────────────────────── залив ─────────────────────────
function disarm() { armed = false; clearTimeout(armTimer); $('apply').textContent = '🎰 Залить'; }

function onApplyClick() {
  const finalPlan = finalize();
  const actionable = finalPlan.filter((it) => it.action === 'update' || it.action === 'create').length;
  if (!actionable) { disarm(); return setStatus('Нечего заливать — разреши спорные ники или проверь план.'); }
  if (!armed) { armed = true; $('apply').textContent = `⚠️ Точно? (${actionable})`; setStatus('Балы прибавляются — повтор удвоит. Нажми «Залить» ещё раз.'); armTimer = setTimeout(disarm, 5000); return; }
  disarm(); sendApply(finalize());
}

async function sendApply(plan) {
  $('apply').disabled = true; $('preview').disabled = true; $('rollback').disabled = true;
  setStatus('Заливаю… окно можно закрыть — заливка идёт в фоне.');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'apply', plan });
    if (resp?.error) throw new Error(resp.error);
    const { lastResult } = await chrome.storage.local.get('lastResult');
    if (lastResult?.plan) { mode = 'apply'; renderApply(lastResult.plan, true); }
    await showLastApplied();
    if (resp) setStatus(`Готово: успешно ${resp.ok}${resp.err ? `, ошибок ${resp.err}` : ''}.`, resp.err ? 'error' : 'ok');
  } catch (e) { setStatus(e.message, 'error'); }
  finally { $('preview').disabled = false; $('apply').disabled = false; refreshRollbackButton(); }
}

// ───────────────────────── откат ─────────────────────────
async function onRollback() {
  disarm(); mode = 'roll'; $('apply').disabled = true; $('result').innerHTML = '';
  const s = await loadSettings();
  if (!s.token) return setStatus('Укажи Personal Token в настройках.', 'error');
  currentSettings = s;
  setStatus('Сканирую доску…');
  try {
    const lots = await getLots(s.token);
    currentLots = lots;
    currentRollback = buildRollbackPlan(lots, s.newLotPrefix);
    renderRoll(currentRollback);
    setStatus(currentRollback.length ? `Меток на доске: ${currentRollback.length}. Отметь и сними.` : 'Меток рейтинга нет.', 'ok');
  } catch (e) { setStatus(e.message, 'error'); }
}

async function doRollback(items) {
  if (!items.length) return setStatus('Ничего не выбрано.');
  $('preview').disabled = true; $('apply').disabled = true; $('rollback').disabled = true;
  setStatus(`Откатываю… (${items.length})`);
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'rollback', items });
    if (resp?.error) throw new Error(resp.error);
    setStatus(`Откат готов: лотов ${resp.ok}${resp.err ? `, ошибок ${resp.err}` : ''}.`, resp.err ? 'error' : 'ok');
    await onRollback(); // пере-сканировать доску
  } catch (e) { setStatus(e.message, 'error'); }
  finally { $('preview').disabled = false; refreshRollbackButton(); }
}

// инлайн ↩ — откат одного ника (все его метки)
async function undoNick(nick) {
  const s = currentSettings || await loadSettings();
  setStatus(`Откатываю ${nick}…`);
  try {
    const lots = await getLots(s.token);
    const items = buildRollbackPlan(lots, s.newLotPrefix).filter((it) => norm(it.nick) === norm(nick));
    if (!items.length) return setStatus(`У «${nick}» нет меток для отката.`);
    const resp = await chrome.runtime.sendMessage({ type: 'rollback', items });
    if (resp?.error) throw new Error(resp.error);
    setStatus(`«${nick}» откачен.`, 'ok');
    mode === 'roll' ? onRollback() : onPreview(); // обновить вид
    refreshRollbackButton();
  } catch (e) { setStatus(e.message, 'error'); }
}

// сообщения от worker (прогресс/итог, если окно открыто)
chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'progress') setStatus(`Идёт… ${m.done}/${m.total}`);
  else if (m?.type === 'error') setStatus(m.message, 'error');
});

// ───────────────────────── инициализация ─────────────────────────
async function init() {
  const s = await loadSettings();
  $('token').value = s.token; $('sheetUrl').value = s.sheetUrl;
  $('firstRow').value = s.firstRow; $('nickCol').value = s.nickCol; $('pointsCol').value = s.pointsCol;
  $('newLotPrefix').value = s.newLotPrefix;
  $('allowNegative').checked = s.allowNegative; $('skipZero').checked = s.skipZero; $('asDonation').checked = s.asDonation;
  if (!s.token || !s.sheetUrl) $('settings').open = true;
  showLastApplied();
  refreshRollbackButton();

  $('save').addEventListener('click', async () => {
    await saveSettings({
      token: $('token').value.trim(), sheetUrl: $('sheetUrl').value.trim(),
      firstRow: Math.max(1, parseInt($('firstRow').value, 10) || 1),
      nickCol: $('nickCol').value.trim().toUpperCase() || 'A',
      pointsCol: $('pointsCol').value.trim().toUpperCase() || 'B',
      newLotPrefix: $('newLotPrefix').value,
      allowNegative: $('allowNegative').checked, skipZero: $('skipZero').checked, asDonation: $('asDonation').checked,
    });
    setStatus('Настройки сохранены.', 'ok');
    refreshRollbackButton();
  });
  $('preview').addEventListener('click', onPreview);
  $('apply').addEventListener('click', onApplyClick);
  $('rollback').addEventListener('click', onRollback);
  // инлайн ↩ (делегирование)
  $('result').addEventListener('click', (e) => { const b = e.target.closest('.undo'); if (b) undoNick(b.dataset.nick); });
}

init();
