import { DEFAULTS, fetchSheetRows, getLots, buildPlan, resolveChoice } from './core.js';

let currentPlan = null;      // план из предпросмотра
let currentSettings = null;  // настройки на момент предпросмотра
let currentLots = [];        // лоты на момент предпросмотра (для выпадающих списков)
let armed = false, armTimer = null;

const loadSettings = () => chrome.storage.local.get(DEFAULTS);
const saveSettings = (patch) => chrome.storage.local.set(patch);

const $ = (id) => document.getElementById(id);
const setStatus = (msg, cls = '') => { const el = $('status'); el.textContent = msg; el.className = 'status ' + cls; };

const ACTION_LABEL = { update: '+ к лоту', create: 'новый лот', skip: 'пропуск', resolve: 'выбрать лот' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Порядок строк: авто «+ к лоту» → много лотов → групповой (1 лот) → без лота → уже залито → пропуск.
const SORT_KEY = (it) => {
  if (it.action === 'update' || it.action === 'create') return 0;
  if (it.action === 'resolve') {
    if (it.applied) return 4;
    const n = (it.candidates || []).length;
    return n >= 2 ? 1 : n === 1 ? 2 : 3;
  }
  return 5; // skip
};

// селект выбора лота: пропустить + кандидаты (★) + остальные лоты + новый лот
function resolveSelect(it, idx) {
  const candIds = new Set((it.candidates || []).map((c) => String(c.id)));
  const cand = (it.candidates || []).map((c) => `<option value="lot:${esc(c.id)}">★ ${esc(c.name)} (${c.amount})</option>`);
  const others = currentLots
    .filter((l) => l.name && !candIds.has(String(l.id)))
    .map((l) => `<option value="lot:${esc(l.id)}">${esc(l.name)} (${l.amount ?? 0})</option>`);
  const opts = ['<option value="skip">— пропустить —</option>', ...cand, ...others, '<option value="new">＋ новый лот</option>'];
  return `<select class="resolve" data-idx="${idx}">${opts.join('')}</select>`;
}

function renderTable(plan, withStatus) {
  const rows = plan.map((it, idx) => {
    const ptsCls = it.points < 0 ? 'neg' : it.points > 0 ? 'pos' : '';
    const pts = Number.isFinite(it.points) ? (it.points > 0 ? '+' : '') + it.points : it.rawPoints;
    const whereCell = (!withStatus && it.action === 'resolve')
      ? resolveSelect(it, idx)
      : esc(it.target || '');
    const actClass = it.applied ? 'applied' : it.action;
    const actLabel = it.applied ? '⚠ уже залито' : ACTION_LABEL[it.action];
    const statusCell = withStatus
      ? `<td><span class="tag ${it.status}">${it.status === 'ok' ? '✓' : it.status === 'error' ? '✕' : '—'}</span>${it.error ? ' ' + esc(it.error) : ''}</td>`
      : '';
    return `<tr>
      <td>${esc(it.nick) || '<i>—</i>'}</td>
      <td class="num ${ptsCls}">${pts}</td>
      <td><span class="tag ${actClass}">${actLabel}</span></td>
      <td>${whereCell}</td>
      <td class="muted">${esc(it.reason || '')}</td>
      ${statusCell}
    </tr>`;
  }).join('');

  const counts = plan.reduce((a, it) => ((a[it.action] = (a[it.action] || 0) + 1), a), {});
  const applied = plan.filter((it) => it.applied).length;
  const summary = `+ к лоту: <b>${counts.update || 0}</b> · новых: <b>${counts.create || 0}</b> · выбрать лот: <b>${counts.resolve || 0}</b> · пропуск: <b>${counts.skip || 0}</b>${applied ? ` · ⚠ уже залито: <b>${applied}</b>` : ''}`;

  $('result').innerHTML = `<div class="muted" style="margin:6px 0">${summary}</div>
    <table><thead><tr>
      <th>Ник</th><th class="num">Баллы</th><th>Действие</th><th>Куда</th><th>Примечание</th>${withStatus ? '<th>Итог</th>' : ''}
    </tr></thead><tbody>${rows}</tbody></table>`;
}

async function showLastApplied() {
  const { lastApplied } = await chrome.storage.local.get('lastApplied');
  $('lastApplied').textContent = lastApplied
    ? `Последний залив: ${new Date(lastApplied.at).toLocaleString()} — изменено ${lastApplied.count}`
    : '';
}

async function showLastResult() {
  const { lastResult } = await chrome.storage.local.get('lastResult');
  if (lastResult?.plan) renderTable(lastResult.plan, true);
}

// Применяет выбор из селектов к пунктам resolve → финальный план для заливки.
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

// ───────────────────────── предпросмотр ─────────────────────────
async function onPreview() {
  disarm();
  $('apply').disabled = true;
  $('result').innerHTML = '';
  const s = await loadSettings();
  if (!s.token) return setStatus('Укажи Personal Token в настройках.', 'error');
  if (!s.sheetUrl) return setStatus('Укажи ссылку на таблицу в настройках.', 'error');
  setStatus('Читаю таблицу и лоты…');
  try {
    const [rows, lots] = await Promise.all([fetchSheetRows(s.sheetUrl, s), getLots(s.token)]);
    currentSettings = s;
    currentLots = lots;
    currentPlan = buildPlan(rows, lots, s).sort((a, b) => SORT_KEY(a) - SORT_KEY(b)); // стабильно: в группе — порядок таблицы
    renderTable(currentPlan, false);
    const counts = currentPlan.reduce((a, it) => ((a[it.action] = (a[it.action] || 0) + 1), a), {});
    const res = counts.resolve || 0;
    setStatus(`Готов план: строк ${rows.length}, авто «+ к лоту» ${counts.update || 0}${res ? `, выбрать лот ${res} — задай в таблице` : ''}.`, 'ok');
    $('apply').disabled = !currentPlan.some((it) => ['update', 'create', 'resolve'].includes(it.action));
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

// ───────────────────────── заливка ─────────────────────────
function disarm() { armed = false; clearTimeout(armTimer); $('apply').textContent = '🎰 Залить'; }

function onApplyClick() {
  const finalPlan = finalize();
  const actionable = finalPlan.filter((it) => it.action === 'update' || it.action === 'create').length;
  if (!actionable) { disarm(); return setStatus('Нечего заливать — разреши спорные ники или проверь план.'); }

  if (!armed) { // подтверждение прямо в окне (без нативного confirm)
    armed = true;
    $('apply').textContent = `⚠️ Точно? (${actionable})`;
    setStatus('Балы прибавляются — повторный запуск удвоит их. Нажми «Залить» ещё раз для подтверждения.');
    armTimer = setTimeout(disarm, 5000);
    return;
  }
  disarm();
  doApply(finalize()); // перечитываем селекты на момент подтверждения
}

async function doApply(plan) {
  $('apply').disabled = true;
  $('preview').disabled = true;
  setStatus('Заливаю… окно можно закрыть — заливка идёт в фоне.');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'apply', plan });
    if (resp?.error) throw new Error(resp.error);
    await showLastResult();
    await showLastApplied();
    if (resp) setStatus(`Готово: успешно ${resp.ok}${resp.err ? `, ошибок ${resp.err}` : ''}.`, resp.err ? 'error' : 'ok');
  } catch (e) {
    setStatus(e.message, 'error');
  } finally {
    $('preview').disabled = false;
    $('apply').disabled = false;
  }
}

// прогресс/итог от worker (если окно осталось открытым)
chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'progress') setStatus(`Заливаю… ${m.done}/${m.total}`);
  else if (m?.type === 'done') { showLastResult(); showLastApplied(); setStatus(`Готово: успешно ${m.ok}${m.err ? `, ошибок ${m.err}` : ''}.`, m.err ? 'error' : 'ok'); }
  else if (m?.type === 'error') setStatus(m.message, 'error');
});

// ───────────────────────── инициализация ─────────────────────────
async function init() {
  const s = await loadSettings();
  $('token').value = s.token;
  $('sheetUrl').value = s.sheetUrl;
  $('firstRow').value = s.firstRow;
  $('nickCol').value = s.nickCol;
  $('pointsCol').value = s.pointsCol;
  $('newLotPrefix').value = s.newLotPrefix;
  $('allowNegative').checked = s.allowNegative;
  $('skipZero').checked = s.skipZero;
  if (!s.token || !s.sheetUrl) $('settings').open = true;
  showLastApplied();

  $('save').addEventListener('click', async () => {
    await saveSettings({
      token: $('token').value.trim(),
      sheetUrl: $('sheetUrl').value.trim(),
      firstRow: Math.max(1, parseInt($('firstRow').value, 10) || 1),
      nickCol: $('nickCol').value.trim().toUpperCase() || 'A',
      pointsCol: $('pointsCol').value.trim().toUpperCase() || 'B',
      newLotPrefix: $('newLotPrefix').value, // без trim — хвостовой пробел важен
      allowNegative: $('allowNegative').checked,
      skipZero: $('skipZero').checked,
    });
    setStatus('Настройки сохранены.', 'ok');
  });
  $('preview').addEventListener('click', onPreview);
  $('apply').addEventListener('click', onApplyClick);
}

init();
