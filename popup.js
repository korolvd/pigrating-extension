import { DEFAULTS, LOT_PREFIX, fetchSheetRows, getLots, buildPlan, resolveChoice, buildRollbackPlan, parseSheetRef, buildAppsScript, healthCheck, normNick, MOVIE_BADGE_POOL, movieBadgeImage, expectedScriptConfig } from './core.js';
import { connectTwitch, syncRewards, syncReward, setRewardsEnabled, deleteReward, updateReward, getChatBadges, DEFAULT_TWITCH_CLIENT_ID } from './twitch.js';

// ⚠️ DEPRECATED (на удаление) — ручной залив PigPoints из таблицы в лоты pointauc (Предпросмотр/Применить/Откатить).
// UI убран, слушатели сняты → функции ниже не вызываются. Логика залива в core.js/background.js помечена так же.
let currentPlan = null;       // план залива (предпросмотр)
let currentSettings = null;   // настройки на момент предпросмотра/отката
let currentLots = [];         // лоты на момент предпросмотра
let currentRollback = null;   // список меток для отката
let mode = 'apply';           // 'apply' | 'roll'
let armed = false, armTimer = null; // подтверждение «Применить» вторым кликом

const loadSettings = () => chrome.storage.local.get(DEFAULTS);
const saveSettings = (patch) => chrome.storage.local.set(patch);

const $ = (id) => document.getElementById(id);
const setLabel = (id, text) => { const l = $(id).querySelector('.btn-label'); if (l) l.textContent = text; }; // менять подпись, не затирая SVG-иконку
const syncRewardBar = () => $('rewardSwitch').classList.toggle('on', $('rewardsActive').checked); // зелёный значок награды при включённых
const norm = (s) => (s || '').trim().toLowerCase();
const setStatus = (msg, cls = '') => { const el = $('status'); el.textContent = msg; el.className = 'status ' + cls; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ACTION_LABEL = { update: '+ к лоту', create: 'новый лот', skip: 'пропуск', resolve: 'выбрать лот' };
// Порядок: авто «+ к лоту» → много лотов → групповой → без лота → уже применено → пропуск.
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
    const actLabel = it.applied ? '⚠ уже применено' : ACTION_LABEL[it.action];
    const canUndo = it.applied || (withStatus && it.status === 'ok' && (it.action === 'update' || it.action === 'create'));
    const undo = canUndo ? `<button class="undo" data-nick="${esc(it.nick)}" title="Откатить ${esc(it.nick)}" aria-label="Откатить ник"><svg class="ic"><use href="#ic-rollback"/></svg></button>` : '';
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
  const summary = `+ к лоту: <b>${counts.update || 0}</b> · новых: <b>${counts.create || 0}</b> · выбрать лот: <b>${counts.resolve || 0}</b> · пропуск: <b>${counts.skip || 0}</b>${applied ? ` · ⚠ уже применено: <b>${applied}</b>` : ''}`;
  $('result').innerHTML = `<div class="muted" style="margin:6px 0">${summary}</div>
    <table><thead><tr><th>Ник</th><th class="num">Баллы</th><th>Действие</th><th>Куда</th><th>Примечание</th><th></th>${withStatus ? '<th>Итог</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>`;
}

// ───────────────────────── таблица отката ─────────────────────────
function renderRoll(items) {
  if (!items.length) { $('result').innerHTML = '<div class="muted" style="margin:8px 0">Меток PigPoints на доске нет — откатывать нечего.</div>'; return; }
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
  $('lastApplied').textContent = lastApplied ? `Последнее применение: ${new Date(lastApplied.at).toLocaleString()} — изменено ${lastApplied.count}` : '';
}

// «Откатить» активна только если на доске есть метки PigPoints (+ показывает их число).
// Доска обновляется с задержкой → если сразу после залива/отката меток 0, перепроверяем.
async function refreshRollbackButton(retries = 2) {
  const btn = $('rollback');
  const s = await loadSettings();
  if (!s.token) { btn.disabled = true; setLabel('rollback', 'Откатить'); return; }
  try {
    const n = buildRollbackPlan(await getLots(s.token)).length;
    btn.disabled = n === 0;
    setLabel('rollback', n ? `Откатить (${n})` : 'Откатить');
    if (n === 0 && retries > 0) setTimeout(() => refreshRollbackButton(retries - 1), 800);
  } catch {
    // API не ответил (504/таймаут) — кнопку не выключаем, дадим шанс кликнуть и перепроверим
    if (retries > 0) setTimeout(() => refreshRollbackButton(retries - 1), 800);
  }
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
  const prefix = LOT_PREFIX;
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
function disarm() { armed = false; clearTimeout(armTimer); $('apply').classList.remove('armed'); setLabel('apply', 'Применить'); }

function onApplyClick() {
  const finalPlan = finalize();
  const actionable = finalPlan.filter((it) => it.action === 'update' || it.action === 'create').length;
  if (!actionable) { disarm(); return setStatus('Нечего применять — разреши спорные ники или проверь план.'); }
  if (!armed) { armed = true; $('apply').classList.add('armed'); setLabel('apply', `Точно? (${actionable})`); setStatus('Балы прибавляются — повтор удвоит. Нажми «Применить» ещё раз.'); armTimer = setTimeout(disarm, 5000); return; }
  disarm(); sendApply(finalize());
}

async function sendApply(plan) {
  $('apply').disabled = true; $('preview').disabled = true; $('rollback').disabled = true;
  setStatus('Применяю… окно можно закрыть — идёт в фоне.');
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
    currentRollback = buildRollbackPlan(lots);
    renderRoll(currentRollback);
    setStatus(currentRollback.length ? `Меток на доске: ${currentRollback.length}. Отметь и сними.` : 'Меток PigPoints нет.', 'ok');
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
    const items = buildRollbackPlan(lots).filter((it) => norm(it.nick) === norm(nick));
    if (!items.length) return setStatus(`У «${nick}» нет меток для отката.`);
    const resp = await chrome.runtime.sendMessage({ type: 'rollback', items });
    if (resp?.error) throw new Error(resp.error);
    setStatus(`«${nick}» откачен.`, 'ok');
    mode === 'roll' ? onRollback() : onPreview(); // обновить вид
    refreshRollbackButton();
  } catch (e) { setStatus(e.message, 'error'); }
}

// показать поле «столбец покупок» только когда галка «тот же столбец» снята
function toggleBuyCol() { $('buyColWrap').style.display = $('buySameCol').checked ? 'none' : ''; }

// ── авто-сохранение настроек (без отдельной кнопки) ──
let saveTimer;
function readSettingsFromForm() {
  return {
    token: $('token').value.trim(), sheetUrl: $('sheetUrl').value.trim(), sheetName: $('sheetName').value.trim(),
    firstRow: Math.max(1, parseInt($('firstRow').value, 10) || 1),
    nickCol: $('nickCol').value.trim().toUpperCase() || 'A',
    pointsCol: $('pointsCol').value.trim().toUpperCase() || 'B',
    webAppUrl: $('webAppUrl').value.trim(), webAppSecret: $('webAppSecret').value.trim(),
    buySameCol: $('buySameCol').checked, buyPointsCol: $('buyPointsCol').value.trim().toUpperCase(),
  };
}
async function saveAll() { await saveSettings(readSettingsFromForm()); flashSaved(); }
function flashSaved() {
  const h = $('savedHint'); if (!h) return;
  h.classList.add('show'); clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => h.classList.remove('show'), 1200);
}

// ── строка статуса подключений (чипы) ──
let webappState = 'off'; // 'ok' | 'err' | 'off'
function chipHtml(label, ok, target, icon, iconColor) {
  const color = ok === 'ok' ? '#27ae60' : ok === 'err' ? '#eb5757' : '#5f6470';
  const ic = icon ? `<svg class="ic" style="color:${iconColor || 'currentColor'}"><use href="#${icon}"/></svg>` : '';
  return `<span class="chip" data-target="${target}"><span class="dot" style="background:${color}"></span>${ic}${escapeHtml(label)}</span>`;
}
function renderStatusStrip(s) {
  $('statusStrip').innerHTML = [
    chipHtml('pointauc', s.token ? 'ok' : 'off', 'token'),
    chipHtml('таблица', (s.sheetUrl && s.sheetName) ? 'ok' : 'off', 'sheetUrl'),
    chipHtml('веб-апп', webappState, 'webAppUrl'),
    chipHtml(s.twitchLogin || 'Twitch', s.twitchToken ? 'ok' : 'off', 'twitchConnect', 'ic-twitch', '#a970ff'),
  ].join('');
}
async function refreshStrip() { renderStatusStrip(await loadSettings()); }

// ── хелсчек веб-аппа: индикатор «работает / ошибка» ──
async function runHealthCheck() {
  const el = $('webAppHealth');
  const url = $('webAppUrl').value.trim();
  const secret = $('webAppSecret').value.trim();
  if (!url) { el.textContent = ''; el.className = 'health'; webappState = 'off'; refreshStrip(); return; }
  el.innerHTML = '<span class="dot" style="background:#9aa3b2"></span> проверяю…'; el.className = 'health pending';
  try {
    const r = await healthCheck(url, secret);
    const exp = expectedScriptConfig({ nickCol: $('nickCol').value, pointsCol: $('pointsCol').value, firstRow: $('firstRow').value, sheetName: $('sheetName').value, buySameCol: $('buySameCol').checked, buyPointsCol: $('buyPointsCol').value });
    const stale = r.pointsCol != null && (r.pointsCol !== exp.pointsCol || r.nickCol !== exp.nickCol || r.firstRow !== exp.firstRow || (r.sheet || '') !== exp.sheetName); // задеплоенный скрипт не совпал с настройками
    if (stale) { el.innerHTML = '<span class="dot" style="background:#f2c94c"></span> ⚠ скрипт устарел (столбцы/лист не совпадают) — пере-скопируй и задеплой новую версию'; el.className = 'health err'; webappState = 'err'; }
    else { el.innerHTML = `<span class="dot" style="background:#27ae60"></span> работает — лист «${escapeHtml(r.sheet)}» найден`; el.className = 'health ok'; webappState = 'ok'; }
  } catch (e) {
    el.innerHTML = `<span class="dot" style="background:#eb5757"></span> ${escapeHtml(e.message)}`; el.className = 'health err'; webappState = 'err';
  }
  refreshStrip();
}

// ── маппинг наград Twitch → PigPoints (динамические строки таблицы) ──
let rmapTimer;
let movieTimer;
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function rewardRowHtml(r = {}) {
  const tgt = r.target === 'input' ? 'input' : 'self';
  const pts = Number.isFinite(parseInt(r.points, 10)) ? parseInt(r.points, 10) : 50;
  const cost = Number.isFinite(parseInt(r.cost, 10)) ? parseInt(r.cost, 10) : 1000;
  return `<tr class="rmap-row" data-id="${escapeHtml(r.rewardId || '')}">
    <td><input class="rm-title" type="text" placeholder="название награды" value="${escapeHtml(r.rewardTitle || '')}"></td>
    <td><input class="rm-cost mini" type="number" min="1" value="${cost}"></td>
    <td><input class="rm-points mini" type="number" value="${pts}"></td>
    <td><select class="rm-target"><option value="self"${tgt === 'self' ? ' selected' : ''}>себе</option><option value="input"${tgt === 'input' ? ' selected' : ''}>ник из ввода</option></select></td>
    <td class="act"><button class="rm-del" title="удалить">✕</button></td>
  </tr>`;
}
function renderRewardMap(rows) {
  $('rewardMap').querySelector('tbody').innerHTML = (Array.isArray(rows) ? rows : []).map(rewardRowHtml).join('');
}
function readRewardMap() {
  return [...document.querySelectorAll('#rewardMap .rmap-row')].map((tr) => ({
    rewardId: tr.dataset.id || '',
    rewardTitle: tr.querySelector('.rm-title').value.trim(),
    cost: parseInt(tr.querySelector('.rm-cost').value, 10) || 0,
    points: parseInt(tr.querySelector('.rm-points').value, 10) || 0,
    target: tr.querySelector('.rm-target').value === 'input' ? 'input' : 'self',
  })).filter((r) => r.rewardTitle || r.rewardId);   // пустые строки не сохраняем
}
async function saveRewardMap() { await saveSettings({ rewardMap: readRewardMap() }); flashSaved(); }

// мастер-переключатель наград: вкл → создать/обновить + включить; выкл → выключить (зрители не могут покупать)
async function onToggleRewards() {
  const active = $('rewardsActive').checked;
  syncRewardBar();
  const s = await loadSettings();
  if (!s.twitchToken || !s.twitchUserId) { $('rewardsActive').checked = false; syncRewardBar(); return setStatus('Сначала подключи Twitch.', 'error'); }
  const rows = readRewardMap();
  if (active && !rows.length) { $('rewardsActive').checked = false; syncRewardBar(); return setStatus('Нет наград в таблице.', 'error'); }
  const ctx = { clientId: s.twitchClientId || DEFAULT_TWITCH_CLIENT_ID, token: s.twitchToken, broadcasterId: s.twitchUserId };
  setStatus(active ? 'Создаю и включаю награды…' : 'Выключаю награды…');
  try {
    let res;
    if (active) {
      res = await syncRewards(ctx, rows, [s.movieRewardId].filter(Boolean)); // не снести награду «Предложить фильм» при зачистке
      const persist = res.map(({ rewardId, rewardTitle, cost, points, target }) => ({ rewardId: rewardId || '', rewardTitle, cost, points, target }));
      await saveSettings({ rewardMap: persist, twitchRewardsActive: true });
      renderRewardMap(persist);
    } else {
      res = await setRewardsEnabled(ctx, rows, false);
      await saveSettings({ twitchRewardsActive: false });
    }
    const errs = res.filter((r) => r.syncStatus === 'error');
    if (errs.length) setStatus(`${active ? 'Включено' : 'Выключено'} с ошибками: ${errs.map((e) => `«${e.rewardTitle}» — ${e.syncError}`).join('; ')}`, 'error');
    else setStatus(active ? `Награды активны: ${res.filter((r) => r.syncStatus === 'ok').length}.` : 'Награды выключены.', 'ok');
  } catch (e) {
    $('rewardsActive').checked = !active; syncRewardBar(); // откат визуального состояния
    setStatus(`Twitch: ${e.message}`, 'error');
  }
}

// ── фича «ставка за значки на фильм» ──
let badgeImgMap = {}; // set_id→version→url из Twitch Helix (getChatBadges); грузится при подключённом Twitch
function badgeImgHtml(pool) {
  const url = pool ? movieBadgeImage(pool, badgeImgMap) : null;
  return url ? `<img class="badge-ic" src="${escapeHtml(url)}" alt="" loading="lazy" />` : '<span class="badge-ic badge-none" title="нет значка Twitch">—</span>';
}
function movieBadgeRowHtml(b) {
  const pool = MOVIE_BADGE_POOL.find((p) => p.key === b.key);
  return `<div class="row mbadge-row" data-key="${escapeHtml(b.key)}" style="gap:8px; align-items:center; padding:3px 0">
    <span style="flex:1; min-width:0">${escapeHtml(pool ? pool.label : b.key)}</span>
    ${badgeImgHtml(pool)}
    <input class="mb-price mini" type="number" min="0" value="${Number(b.price) || 0}" style="width:74px; text-align:right" />
    <button class="mb-del undo" title="убрать">✕</button>
  </div>`;
}
function renderMovieBadges(list) {
  const rows = Array.isArray(list) ? list : [];
  $('movieBadgeList').innerHTML = rows.length ? rows.map(movieBadgeRowHtml).join('') : '<div class="muted" style="font-size:11px">пока ничего — добавь значок ниже</div>';
}
function readMovieBadges() {
  return [...document.querySelectorAll('#movieBadgeList .mbadge-row')].map((r) => ({ key: r.dataset.key, price: parseInt(r.querySelector('.mb-price').value, 10) || 0 }));
}
// кастомный пикер с иконками вместо нативного select (option картинки не умеет)
function populateMoviePicker(list) {
  const used = new Set((Array.isArray(list) ? list : []).map((b) => b.key));
  const avail = MOVIE_BADGE_POOL.filter((p) => !used.has(p.key));
  $('badgePickMenu').innerHTML = avail.length
    ? avail.map((p) => `<button type="button" class="badge-opt" data-key="${p.key}"><span class="badge-opt-label">${escapeHtml(p.label)}</span>${badgeImgHtml(p)}</button>`).join('')
    : '<div class="muted" style="font-size:11px; padding:6px">все значки добавлены</div>';
}
function rerenderBadges() { const list = readMovieBadges(); renderMovieBadges(list); populateMoviePicker(list); }
// иконки значков Twitch (Helix): мгновенно из кэша + свежий фетч, потом перерисовка строк и меню
async function loadBadgeImages() {
  const { badgeImages } = await chrome.storage.local.get('badgeImages');
  if (badgeImages && typeof badgeImages === 'object') { badgeImgMap = badgeImages; rerenderBadges(); }
  const s = await loadSettings();
  if (!s.twitchToken || !s.twitchUserId) return;
  try {
    const map = await getChatBadges({ clientId: s.twitchClientId || DEFAULT_TWITCH_CLIENT_ID, token: s.twitchToken, broadcasterId: s.twitchUserId });
    if (map && Object.keys(map).length) { badgeImgMap = map; await saveSettings({ badgeImages: map }); rerenderBadges(); }
  } catch { /* иконок не будет — не критично */ }
}
async function saveMovie() { await saveSettings({ movieRewardTitle: $('movieRewardTitle').value.trim() || 'Предложить фильм', movieBase: parseInt($('movieBase').value, 10) || 0, movieAsDonation: $('movieAsDonation').checked, movieUsePoints: $('movieUsePoints').checked, movieDropNegForeign: $('movieDropNegForeign').checked, movieBadges: readMovieBadges() }); flashSaved(); renderMoviePointsSrc(); }
function syncMovieBar() { const on = $('movieActive').checked; $('movieSwitch').classList.toggle('on', on); const h = $('moviePointaucHint'); if (h) h.hidden = !on; } // напоминание про приём ставок в pointauc — только когда ставки включены
// Статус источника PigPoints в модуле (под тумблером): вкл/выкл + подключена ли таблица.
function renderMoviePointsSrc(s) {
  const el = $('moviePointsSrc'); if (!el) return;
  const use = s ? s.movieUsePoints !== false : $('movieUsePoints').checked;
  const hasSheet = !!((s ? s.sheetUrl : $('sheetUrl').value) || '').trim();
  if (!use) { el.textContent = 'PigPoints в ставке: выкл'; el.className = 'health'; }
  else if (!hasSheet) { el.textContent = '⚠ PigPoints: таблица не подключена — только база и значки'; el.className = 'health err'; }
  else { el.textContent = '✓ PigPoints: из таблицы (плюс всегда, минус — свой лот)'; el.className = 'health ok'; }
}

// тумблер фичи: вкл → создать/включить награду «Предложить фильм» (новый раунд); выкл → выключить
async function onToggleMovieBids() {
  const active = $('movieActive').checked;
  syncMovieBar();
  const s = await loadSettings();
  if (!s.twitchToken || !s.twitchUserId) { $('movieActive').checked = false; syncMovieBar(); return setStatus('Сначала подключи Twitch.', 'error'); }
  const ctx = { clientId: s.twitchClientId || DEFAULT_TWITCH_CLIENT_ID, token: s.twitchToken, broadcasterId: s.twitchUserId };
  const title = ($('movieRewardTitle').value || 'Предложить фильм').trim(); // из поля (могли только что поменять)
  setStatus(active ? `Создаю награду «${title}»…` : 'Выключаю награду…');
  try {
    if (active) {
      const reward = await syncReward(ctx, { rewardId: s.movieRewardId || '', rewardTitle: title, cost: 1, points: 0, target: 'input', prompt: 'Напиши название фильма' });
      await saveSettings({ movieRewardId: reward.id, movieBidsActive: true, movieRewardTitle: title, movieBase: parseInt($('movieBase').value, 10) || 0, movieAsDonation: $('movieAsDonation').checked });
      await chrome.runtime.sendMessage({ type: 'movie-new-round' }).catch(() => {}); // сброс раунда атомарно в фоне (очередь + зачёт + журнал + кэши)
      chrome.runtime.sendMessage({ type: 'movie-subscribe' }).catch(() => {}); // поднять чат-подписку на текущей сессии
      renderMovieJournal([]);
      setStatus(`Награда «${title}» активна. Не забудь включить приём ставок за баллы канала в pointauc (▶).`, 'ok');
    } else {
      let warn = '';
      if (s.movieRewardId) { try { await updateReward(ctx, s.movieRewardId, { is_enabled: false }); } catch (err) { warn = ` (⚠ могла остаться активной: ${err.message})`; } }
      await saveSettings({ movieBidsActive: false }); // id сохраняем (keepExtra защитит, можно снова включить)
      setStatus('Награда «Предложить фильм» выключена.' + warn, warn ? 'error' : 'ok');
    }
  } catch (e) {
    $('movieActive').checked = !active; syncMovieBar();
    setStatus(`Twitch: ${e.message}`, 'error');
  }
}

// ── подключение Twitch (OAuth) ──
function renderTwitchStatus(s) {
  const conn = !!s.twitchToken;
  $('twitchConnect').textContent = conn ? 'Переподключить' : 'Подключить Twitch';
  $('twitchDisconnect').hidden = !conn;
  const st = $('twitchStatus');
  st.innerHTML = conn ? `<span class="dot" style="background:#27ae60"></span> подключён: ${escapeHtml(s.twitchLogin || '?')}` : '<span class="dot"></span> не подключён';
  st.className = 'health' + (conn ? ' ok' : '');
}
async function onTwitchConnect() {
  const clientId = DEFAULT_TWITCH_CLIENT_ID;                     // встроенное приложение (своего Client ID больше нет)
  setStatus('Открываю окно авторизации Twitch…');
  try {
    const r = await connectTwitch(clientId);
    await saveSettings({ twitchToken: r.token, twitchUserId: r.userId, twitchLogin: r.login });
    chrome.runtime.sendMessage({ type: 'twitch-reconnect' }).catch(() => {}); // запустить слушатель
    { const ns = await loadSettings(); renderTwitchStatus(ns); renderStatusStrip(ns); }
    loadBadgeImages(); // подтянуть картинки значков канала
    setStatus(`Twitch подключён: ${r.login}.`, 'ok');
  } catch (e) { setStatus(`Twitch: ${e.message}`, 'error'); }
}
async function onTwitchDisconnect() {
  await saveSettings({ twitchToken: '', twitchUserId: '', twitchLogin: '' });
  chrome.runtime.sendMessage({ type: 'twitch-reconnect' }).catch(() => {}); // остановить слушатель
  { const ns = await loadSettings(); renderTwitchStatus(ns); renderStatusStrip(ns); }
  setStatus('Twitch отключён.', 'ok');
}

let prevPendingCount = 0;
function renderTwitchPending(list) {
  const rows = Array.isArray(list) ? list : [];
  const card = $('pendingCard');
  $('pendingCount').textContent = rows.length || '';
  $('pendingCount').style.display = rows.length ? 'inline-block' : 'none';
  $('pendingBulk').style.display = rows.length ? '' : 'none';
  card.classList.toggle('has-items', rows.length > 0);
  if (rows.length > prevPendingCount) { card.open = true; const pr = $('pigpointsCard'); if (pr) pr.open = true; } // всплываем только при НОВОЙ заявке (раскрываем и свёрнутый модуль «PigPoints · таблица»)
  prevPendingCount = rows.length;
  const el = $('twitchPending');
  if (!rows.length) { el.innerHTML = '<div class="muted" style="font-size:11px">пока нет</div>'; return; }
  el.innerHTML = rows.map((p) => {
    const buyer = normNick(p.userLogin);
    const who = (buyer && buyer !== p.nick) ? `<span class="muted">@${escapeHtml(buyer)} →</span> ` : ''; // кто→кому
    const warn = p.nickExists === false ? ' <span class="neg" title="ник не найден на Twitch">⚠</span>' : '';
    const pts = `<span class="${p.points < 0 ? 'neg' : 'pos'}">${p.points > 0 ? '+' : ''}${p.points}</span>`;
    const sug = p.suggestion && p.suggestion.nick
      ? `<div style="margin-top:2px"><span class="muted">возможно:</span> <button class="psuggest" data-nick="${escapeHtml(p.suggestion.nick)}" title="начислить на ${escapeHtml(p.suggestion.nick)} вместо «${escapeHtml(p.nick || '')}»">к ${escapeHtml(p.suggestion.nick)}</button></div>`
      : '';
    return `<div class="prow" data-id="${escapeHtml(p.redemptionId)}">
      <span style="flex:1; min-width:0">${who}<b>${escapeHtml(p.nick || '—')}</b> ${pts}${warn} <span class="muted">${escapeHtml(p.rewardTitle || '')}</span>${sug}</span>
      <button class="pconfirm ok" title="начислить" aria-label="начислить"><svg class="ic"><use href="#ic-check"/></svg></button>
      <button class="preject danger-text" title="вернуть баллы" aria-label="вернуть баллы"><svg class="ic"><use href="#ic-x"/></svg></button>
    </div>`;
  }).join('');
}

function renderTwitchLog(log) {
  const el = $('twitchLog');
  const rows = Array.isArray(log) ? log : [];
  if (!rows.length) { el.innerHTML = '<div class="muted" style="font-size:11px">пока пусто</div>'; return; }
  el.innerHTML = rows.map((e) => {
    const t = new Date(e.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const buyer = (e.buyer || '').toLowerCase();
    const name = e.nick || buyer || '—';
    const who = (buyer && buyer !== name) ? `<span class="muted">@${escapeHtml(buyer)} →</span> ` : ''; // покупатель → кому (для адресных)
    const pts = (e.points != null) ? `<span class="${e.points < 0 ? 'neg' : 'pos'}">${e.points > 0 ? '+' : ''}${e.points}</span>` : '';
    const note = e.note ? ` <span class="muted">${escapeHtml(e.note)}</span>` : '';
    return `<div style="font-size:11px; padding:3px 0; border-bottom:1px solid var(--border)"><span class="dot" style="background:${e.ok ? '#27ae60' : '#eb5757'}"></span> ${who}<b>${escapeHtml(name)}</b> ${pts}${e.total != null ? ` → ${escapeHtml(String(e.total))}` : ''}<span class="muted" style="float:right">${t}</span>${note}</div>`;
  }).join('');
}

function renderMovieJournal(log) {
  const el = $('movieJournal'); if (!el) return;
  const rows = Array.isArray(log) ? log : [];
  if (!rows.length) { el.innerHTML = '<div class="muted" style="font-size:11px">пока пусто</div>'; return; }
  el.innerHTML = rows.map((e) => {
    const t = new Date(e.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const who = e.userLogin ? `<span class="muted">@${escapeHtml(e.userLogin)} →</span> ` : '';
    const head = e.ok
      ? `<b style="font-weight:500" class="pos">${e.amount}</b><span class="muted"> → pointauc</span>`
      : `<span class="neg">${e.refunded ? 'балл возвращён' : 'ошибка'}</span>`;
    const own = e.ownership === 'foreign' ? '<span class="tag skip">поддув</span> '
      : (e.ownership === 'new' || e.ownership === 'sole') ? '<span class="tag update">свой</span> '
      : e.ownership === 'unknown' ? '<span class="tag skip">доска недоступна</span> ' : '';
    let detail;
    if (e.ok) {
      const parts = (e.badges || []).map((b) => { const p = MOVIE_BADGE_POOL.find((x) => x.key === b.key); return `<span class="pos">${escapeHtml(p ? p.label : b.key)} +${b.price}</span>`; });
      parts.push(e.base != null ? `база +${e.base}` : 'база');
      if (e.pointsApplied) parts.push(`<span class="${e.pointsApplied < 0 ? 'neg' : 'pos'}">PigPoints ${e.pointsApplied > 0 ? '+' : ''}${e.pointsApplied}</span>`);
      detail = own + parts.join(' · ');
      if (!e.pointsApplied && e.points) detail += ` · <span class="muted" style="text-decoration:line-through">PigPoints ${e.points > 0 ? '+' : ''}${e.points}</span>${e.pointsSkip ? ` <span class="muted">(${escapeHtml(e.pointsSkip)})</span>` : ''}`;
      if (e.note) detail += ` · ⚠ ${escapeHtml(e.note)}`;
    } else {
      detail = own + escapeHtml(e.note || 'новых значков нет — все уже зачтены');
    }
    return `<div style="font-size:11px; padding:5px 0; border-top:1px solid var(--border)">`
      + `<div><span class="dot" style="background:${e.ok ? '#27ae60' : '#eb5757'}"></span> ${who}<b style="font-weight:500">«${escapeHtml(e.movie || '')}»</b> ${head}<span class="muted" style="float:right">${t}</span></div>`
      + `<div class="muted" style="margin-left:14px; margin-top:2px">${detail}</div></div>`;
  }).join('');
}

async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; }
    catch { return false; }
  }
}

// Скопировать готовый Apps Script: подставить настройки таблицы, сгенерить секрет (если нет), сохранить его в плагин.
async function onCopyScript() {
  const s = await loadSettings();
  const sheetUrl = $('sheetUrl').value.trim();
  if (!parseSheetRef(sheetUrl)) return setStatus('Сначала укажи ссылку на таблицу в настройках.', 'error');
  let secret = $('webAppSecret').value.trim() || s.webAppSecret;          // не плодим новый секрет, если уже есть сохранённый
  const newSecret = !secret;
  if (newSecret) secret = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `pig-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cfg = {
    sheetUrl,
    sheetName: $('sheetName').value.trim(),
    nickCol: $('nickCol').value.trim().toUpperCase() || 'A',
    pointsCol: $('pointsCol').value.trim().toUpperCase() || 'B',
    firstRow: parseInt($('firstRow').value, 10) || 2,
    buySameCol: $('buySameCol').checked,
    buyPointsCol: $('buyPointsCol').value.trim().toUpperCase(),
  };
  let script;
  try { script = buildAppsScript(cfg, secret); }
  catch (e) { return setStatus(e.message, 'error'); }                      // битый столбец → не копируем
  if (!(await copyToClipboard(script))) return setStatus('Не удалось скопировать в буфер — попробуй ещё раз.', 'error');
  $('webAppSecret').value = secret;                                        // секрет фиксируем только после успешного копирования
  await saveSettings({ ...cfg, webAppSecret: secret });                   // настройки = то, что зашито в скопированный скрипт (без рассинхрона с заливом)
  setStatus(`Скрипт скопирован, секрет ${newSecret ? 'сгенерён и ' : ''}сохранён. Вставь в Apps Script → Deploy (Web app: Me/Anyone) → вставь URL сюда.`, 'ok');
}

// сообщения от worker (прогресс/итог, если окно открыто)
chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'progress') setStatus(`Идёт… ${m.done}/${m.total}`);
  else if (m?.type === 'error') setStatus(m.message, 'error');
  else if (m?.type === 'twitch-log') loadSettings().then((s) => renderTwitchLog(s.twitchLog));
  else if (m?.type === 'twitch-pending') loadSettings().then((s) => renderTwitchPending(s.twitchPending));
  else if (m?.type === 'movie-journal') loadSettings().then((s) => renderMovieJournal(s.movieJournal));
});

// ───────────────────────── инициализация ─────────────────────────
async function init() {
  const s = await loadSettings();
  $('token').value = s.token; $('sheetUrl').value = s.sheetUrl; $('sheetName').value = s.sheetName;
  $('firstRow').value = s.firstRow; $('nickCol').value = s.nickCol; $('pointsCol').value = s.pointsCol;
  $('webAppUrl').value = s.webAppUrl; $('webAppSecret').value = s.webAppSecret;
  $('buySameCol').checked = s.buySameCol; $('buyPointsCol').value = s.buyPointsCol; toggleBuyCol();
  renderRewardMap(s.rewardMap);
  $('rewardsActive').checked = s.twitchRewardsActive; syncRewardBar();
  $('movieRewardTitle').value = s.movieRewardTitle; $('movieAsDonation').checked = s.movieAsDonation;
  $('movieBase').value = s.movieBase; $('movieUsePoints').checked = s.movieUsePoints !== false; $('movieDropNegForeign').checked = s.movieDropNegForeign !== false; $('movieActive').checked = s.movieBidsActive; syncMovieBar();
  renderMovieBadges(s.movieBadges); populateMoviePicker(s.movieBadges); loadBadgeImages();
  $('autoApprove').checked = s.twitchAutoApprove;
  renderTwitchStatus(s);
  renderStatusStrip(s);
  renderTwitchPending(s.twitchPending);
  renderTwitchLog(s.twitchLog);
  renderMovieJournal(s.movieJournal);
  renderMoviePointsSrc(s);
  if (!s.token || !s.sheetUrl) $('settings').open = true;
  if (s.webAppUrl) runHealthCheck();

  // авто-сохранение: любое изменение поля в настройках сразу пишется в storage (input — с задержкой, change — сразу)
  $('settings').addEventListener('input', () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveAll, 400); renderMoviePointsSrc(); });
  $('settings').addEventListener('change', async (e) => {
    await saveAll();
    refreshStrip();                                                          // токен/таблица/twitch — обновить чипы статуса
    renderMoviePointsSrc();                                                  // таблица подключена/нет → статус PigPoints в модуле
  });
  $('webAppUrl').addEventListener('change', runHealthCheck);
  $('webAppHealth').addEventListener('click', runHealthCheck);
  $('copyScript').addEventListener('click', onCopyScript);
  $('howto').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('help.html') }));
  $('settingsBtn').addEventListener('click', () => { $('settings').open = true; $('settings').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('buySameCol').addEventListener('change', toggleBuyCol);
  $('addReward').addEventListener('click', () => $('rewardMap').querySelector('tbody').insertAdjacentHTML('beforeend', rewardRowHtml()));
  $('rewardMap').addEventListener('input', () => { clearTimeout(rmapTimer); rmapTimer = setTimeout(saveRewardMap, 400); });
  $('rewardMap').addEventListener('change', saveRewardMap);
  $('rewardMap').addEventListener('click', async (e) => {
    const b = e.target.closest('.rm-del'); if (!b) return;
    const tr = b.closest('tr');
    const rewardId = tr.dataset.id || '';
    tr.remove();
    await saveRewardMap();
    if (!rewardId) return; // не была создана на Twitch — удалять нечего
    const s = await loadSettings();
    if (!s.twitchToken || !s.twitchUserId) return; // Twitch не подключён — осиротевшую зачистит ближайшее включение наград
    const ctx = { clientId: s.twitchClientId || DEFAULT_TWITCH_CLIENT_ID, token: s.twitchToken, broadcasterId: s.twitchUserId };
    try { await deleteReward(ctx, rewardId); setStatus('Награда удалена с Twitch.', 'ok'); }
    catch (err) { if (err.status !== 404) setStatus(`Не удалось удалить награду с Twitch: ${err.message}`, 'error'); }
  });
  $('twitchConnect').addEventListener('click', onTwitchConnect);
  $('twitchDisconnect').addEventListener('click', onTwitchDisconnect);
  $('rewardsActive').addEventListener('change', onToggleRewards);
  $('movieActive').addEventListener('change', onToggleMovieBids);
  $('movieBase').addEventListener('input', () => { clearTimeout(movieTimer); movieTimer = setTimeout(saveMovie, 400); });
  $('movieRewardTitle').addEventListener('input', () => { clearTimeout(movieTimer); movieTimer = setTimeout(saveMovie, 400); });
  $('movieAsDonation').addEventListener('change', saveMovie);
  $('movieUsePoints').addEventListener('change', saveMovie);
  $('movieDropNegForeign').addEventListener('change', saveMovie);
  $('movieBadgeList').addEventListener('input', () => { clearTimeout(movieTimer); movieTimer = setTimeout(saveMovie, 400); });
  $('movieBadgeList').addEventListener('click', async (e) => { if (!e.target.closest('.mb-del')) return; e.target.closest('.mbadge-row').remove(); const list = readMovieBadges(); renderMovieBadges(list); populateMoviePicker(list); await saveMovie(); });
  $('badgePickBtn').addEventListener('click', () => { const m = $('badgePickMenu'); m.hidden = !m.hidden; });
  $('badgePickMenu').addEventListener('click', async (e) => { const b = e.target.closest('.badge-opt'); if (!b) return; const list = readMovieBadges(); list.push({ key: b.dataset.key, price: 0 }); renderMovieBadges(list); populateMoviePicker(list); $('badgePickMenu').hidden = true; await saveMovie(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#badgePicker')) { const m = $('badgePickMenu'); if (m) m.hidden = true; } }); // клик вне пикера — закрыть меню
  $('twitchPending').addEventListener('click', (e) => {
    const row = e.target.closest('.prow'); if (!row) return;
    const sug = e.target.closest('.psuggest');
    if (sug) { chrome.runtime.sendMessage({ type: 'twitch-resolve', redemptionId: row.dataset.id, action: 'confirm', overrideNick: sug.dataset.nick }).catch(() => {}); return; }
    const action = e.target.closest('.pconfirm') ? 'confirm' : e.target.closest('.preject') ? 'reject' : null;
    if (action) chrome.runtime.sendMessage({ type: 'twitch-resolve', redemptionId: row.dataset.id, action }).catch(() => {});
  });
  $('confirmAll').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'twitch-resolve-all', action: 'confirm' }).catch(() => {}));
  $('rejectAll').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'twitch-resolve-all', action: 'reject' }).catch(() => {}));
  $('clearLog').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'twitch-log-clear' }).catch(() => {}));
  $('autoApprove').addEventListener('change', async () => { await saveSettings({ twitchAutoApprove: $('autoApprove').checked }); renderTwitchPending((await loadSettings()).twitchPending); });
  $('autoCtl').addEventListener('click', (e) => e.stopPropagation()); // клик по тумблеру в шапке не сворачивает карточку
  $('statusStrip').addEventListener('click', (e) => {                        // клик по чипу → открыть нужную секцию настроек
    const c = e.target.closest('.chip'); if (!c) return;
    $('settings').open = true;
    const el = document.getElementById(c.dataset.target);
    if (el) { const card = el.closest('details'); if (card && card !== $('settings')) card.open = true; el.scrollIntoView({ block: 'center' }); el.focus?.(); }
  });
}

init();
