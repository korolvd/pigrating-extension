import { DEFAULTS, fetchSheetRows, getLots, parseSheetRef, buildAppsScript, healthCheck, normNick, MOVIE_BADGE_POOL, movieBadgeImage, expectedScriptConfig } from './core.js';
import { connectTwitch, syncRewards, syncReward, setRewardsEnabled, deleteReward, updateReward, getChatBadges, DEFAULT_TWITCH_CLIENT_ID } from './twitch.js';

// ─────────────────────────────────────────────────────────────────────────────
// Карта видимости/гейтов UI. Каскад настройки таблицы:
//   чтение (sheetUrl) → [ PigPoints-в-ставке + запись (webAppUrl) ] → награды для PigPoints
//
// Полностью СКРЫВАЕТСЯ (hidden / display:none):
//   • чип «таблица» — есть sheetUrl;  чип «apps script» — есть sheetUrl && webAppUrl   (renderStatusStrip)
//   • модуль «PigPoints» #pigpointsCard — (sheetUrl && webAppUrl) || twitchRewardsActive (updatePurchaseVisibility)
//   • кнопка «Отключить» Twitch — когда подключён                                       (renderTwitchStatus)
//   • подсказка #moviePointaucHint — только когда тумблер ставок включён                (syncMovieBar)
//   • поле «столбец покупок» #buyColWrap — когда снята галка buySameCol                 (toggleBuyCol)
//   • #pendingCount / #pendingBulk — когда очередь подтверждения непуста                (renderTwitchPending)
//
// ПРИГЛУШАЕТСЯ + неактивно (класс .off + подсказка), пока не настроено звено каскада:
//   • #moviePointsCfg (PigPoints в ставке)   — нужен sheetUrl                  (updatePointsCfgVisibility) + #moviePointsHint
//   • #purchaseCfg    (Покупка / Apps Script) — нужен sheetUrl                  (updatePurchaseCfg)         + #purchaseGateHint
//   • #pigRewardsCfg  (Награды для PigPoints) — нужны sheetUrl && webAppUrl     (updatePigRewardsCfg)       + #pigRewardsHint (+ #addReward.disabled)
//
// Действие БЛОКИРУЕТСЯ (тумблер не включается, всплывает setStatus-ошибка):
//   • rewardsActive — нужен Twitch + webAppUrl + непустой rewardMap            (onToggleRewards)
//   • movieActive   — нужен Twitch                                            (onToggleMovieBids)
//   • «Скопировать скрипт» — нужна ссылка на таблицу + валидные столбцы        (onCopyScript)
// ─────────────────────────────────────────────────────────────────────────────

const loadSettings = () => chrome.storage.local.get(DEFAULTS);
const saveSettings = (patch) => chrome.storage.local.set(patch);
const $ = (id) => document.getElementById(id);
const syncRewardBar = () => $('rewardSwitch').classList.toggle('on', $('rewardsActive').checked); // зелёный значок награды при включённых
const setStatus = (msg, cls = '') => { const el = $('status'); el.textContent = msg; el.className = 'status ' + cls; };

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
let webappState = 'off';   // 'ok' | 'err' | 'off' — запись (Apps Script)
let sheetState = 'off';    // 'ok' | 'err' | 'off' — чтение таблицы (реальная доступность)
let pointaucState = 'off'; // 'ok' | 'err' | 'off' — токен/API pointauc (реальная проверка через getLots)
function chipHtml(label, ok, target, icon, iconColor) {
  const color = ok === 'ok' ? '#27ae60' : ok === 'err' ? '#eb5757' : '#5f6470';
  const ic = icon ? `<svg class="ic" style="color:${iconColor || 'currentColor'}"><use href="#${icon}"/></svg>` : '';
  return `<span class="chip" data-target="${target}"><span class="dot" style="background:${color}"></span>${ic}${escapeHtml(label)}</span>`;
}
function renderStatusStrip(s) {
  const chips = [
    chipHtml('pointauc', s.token ? pointaucState : 'off', 'token'),
    chipHtml(s.twitchLogin || 'Twitch', s.twitchToken ? 'ok' : 'off', 'twitchConnect', 'ic-twitch', '#a970ff'),
  ];
  if (String(s.sheetUrl || '').trim()) chips.push(chipHtml('таблица', sheetState, 'sheetUrl'));       // только если настроено чтение
  if (String(s.webAppUrl || '').trim() && String(s.sheetUrl || '').trim()) chips.push(chipHtml('apps script', webappState, 'webAppUrl')); // запись активна только при чтении
  $('statusStrip').innerHTML = chips.join('');
}
async function refreshStrip() { renderStatusStrip(await loadSettings()); }

// ── хелсчек Apps Script: индикатор «работает / ошибка» ──
async function runHealthCheck() {
  const el = $('webAppHealth');
  const url = $('webAppUrl').value.trim();
  const secret = $('webAppSecret').value.trim();
  if (!url || !$('sheetUrl').value.trim()) { el.textContent = ''; el.className = 'health'; webappState = 'off'; refreshStrip(); return; } // запись неактивна без чтения → не проверяем
  el.innerHTML = '<span class="dot" style="background:#9aa3b2"></span> проверяю…'; el.className = 'health pending';
  try {
    const r = await healthCheck(url, secret);
    const exp = expectedScriptConfig({ nickCol: $('nickCol').value, pointsCol: $('pointsCol').value, firstRow: $('firstRow').value, sheetName: $('sheetName').value, buySameCol: $('buySameCol').checked, buyPointsCol: $('buyPointsCol').value });
    const sheetMismatch = r.sheet != null && r.sheet !== exp.sheetName;                                            // имя листа скрипт отдаёт всегда (даже когда лист не найден)
    const colsMismatch = r.pointsCol != null && (r.pointsCol !== exp.pointsCol || r.nickCol !== exp.nickCol || r.firstRow !== exp.firstRow); // столбцы — только если скрипт их сообщает (старые не отдают)
    const stale = sheetMismatch || colsMismatch;                                                                   // задеплоенный скрипт разошёлся с настройками
    if (stale) { el.innerHTML = '<span class="dot" style="background:#f2c94c"></span> ⚠ скрипт устарел (имя листа/столбцы не совпадают) — пере-скопируй и задеплой новую версию'; el.className = 'health err'; webappState = 'err'; }
    else if (r.sheetFound === false) { el.innerHTML = `<span class="dot" style="background:#eb5757"></span> лист «${escapeHtml(r.sheet)}» не найден — переименуй вкладку или поправь «Имя листа»`; el.className = 'health err'; webappState = 'err'; }
    else { el.innerHTML = `<span class="dot" style="background:#27ae60"></span> работает — лист «${escapeHtml(r.sheet)}» найден`; el.className = 'health ok'; webappState = 'ok'; }
  } catch (e) {
    el.innerHTML = `<span class="dot" style="background:#eb5757"></span> ${escapeHtml(e.message)}`; el.className = 'health err'; webappState = 'err';
  }
  refreshStrip();
}

// ── проверка pointauc: валиден ли токен и отвечает ли API (через getLots) ──
async function runPointaucCheck() {
  const el = $('tokenHealth');
  const token = $('token').value.trim();
  if (!token) { el.textContent = ''; el.className = 'health'; pointaucState = 'off'; refreshStrip(); return; }
  el.innerHTML = '<span class="dot" style="background:#9aa3b2"></span> проверяю…'; el.className = 'health pending';
  try {
    const lots = await getLots(token);
    el.innerHTML = `<span class="dot" style="background:#27ae60"></span> токен работает — лотов на доске: ${lots.length}`; el.className = 'health ok'; pointaucState = 'ok';
  } catch (e) {
    el.innerHTML = `<span class="dot" style="background:#eb5757"></span> ${escapeHtml(e.message)}`; el.className = 'health err'; pointaucState = 'err';
  }
  refreshStrip();
}

// ── проверка ЧТЕНИЯ таблицы: реально ли доступна (фетч CSV-экспорта) ──
async function runSheetCheck() {
  const el = $('sheetHealth');
  const url = $('sheetUrl').value.trim();
  if (!url) { el.textContent = ''; el.className = 'health'; sheetState = 'off'; refreshStrip(); return; }
  el.innerHTML = '<span class="dot" style="background:#9aa3b2"></span> проверяю…'; el.className = 'health pending';
  try {
    const rows = await fetchSheetRows(url, { nickCol: $('nickCol').value.trim() || 'A', pointsCol: $('pointsCol').value.trim() || 'B', firstRow: parseInt($('firstRow').value, 10) || 2 });
    el.innerHTML = `<span class="dot" style="background:#27ae60"></span> читается — строк: ${rows.length}`; el.className = 'health ok'; sheetState = 'ok';
  } catch (e) {
    el.innerHTML = `<span class="dot" style="background:#eb5757"></span> ${escapeHtml(e.message)}`; el.className = 'health err'; sheetState = 'err';
  }
  refreshStrip();
  renderMoviePointsSrc(); // статус в модуле лота зависит от доступности таблицы
}

// модуль «PigPoints» показываем, когда настроен весь конвейер (чтение + запись) ИЛИ награды уже активны
// (страховка: включённую покупку не прячем, даже если настройку потом сломали — чтобы выключить/видеть очередь)
function updatePurchaseVisibility(s) {
  const show = (!!String(s.sheetUrl || '').trim() && !!String(s.webAppUrl || '').trim()) || !!s.twitchRewardsActive;
  const card = $('pigpointsCard'); if (card) card.hidden = !show;
}
// галки PigPoints-в-ставке активны только при подключённой таблице (чтение); иначе приглушены + подсказка
function updatePointsCfgVisibility(s) {
  const has = !!String(s.sheetUrl || '').trim();
  const el = $('moviePointsCfg'); if (el) el.classList.toggle('off', !has);
  const hint = $('moviePointsHint'); if (hint) hint.hidden = has;
}
// конфиг «Награды для PigPoints» доступен только при настроенной записи (Apps Script) — иначе покупки некуда писать
function updatePigRewardsCfg(s) {
  const has = !!String(s.webAppUrl || '').trim() && !!String(s.sheetUrl || '').trim(); // нужны и чтение, и запись — весь конвейер таблицы
  const cfg = $('pigRewardsCfg'); if (cfg) cfg.classList.toggle('off', !has);
  const hint = $('pigRewardsHint'); if (hint) hint.hidden = has;
  const add = $('addReward'); if (add) add.disabled = !has;
}
// блок записи (покупка PigPoints) активен только при настроенном чтении (Ссылка на таблицу) — покупки пишутся в ту же таблицу
function updatePurchaseCfg(s) {
  const has = !!String(s.sheetUrl || '').trim();
  const cfg = $('purchaseCfg'); if (cfg) cfg.classList.toggle('off', !has);
  const hint = $('purchaseGateHint'); if (hint) hint.hidden = has;
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
  if (active && !String(s.webAppUrl || '').trim()) { $('rewardsActive').checked = false; syncRewardBar(); return setStatus('Сначала настрой запись в таблицу (Apps Script) — без неё покупки не запишутся.', 'error'); }
  const rows = readRewardMap();
  if (active && !rows.length) { $('rewardsActive').checked = false; syncRewardBar(); return setStatus('Нет наград в таблице.', 'error'); }
  const ctx = { clientId: s.twitchClientId || DEFAULT_TWITCH_CLIENT_ID, token: s.twitchToken, broadcasterId: s.twitchUserId };
  setStatus(active ? 'Создаю и включаю награды…' : 'Выключаю награды…');
  try {
    let res;
    if (active) {
      res = await syncRewards(ctx, rows, [s.movieRewardId].filter(Boolean)); // не снести награду «Предложить лот» при зачистке
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
  updatePurchaseVisibility(await loadSettings());
}

// ── фича «ставка за значки на лот» ──
let badgeImgMap = {}; // set_id→version→url из Twitch Helix (getChatBadges); грузится при подключённом Twitch
function badgeImgHtml(pool) {
  const url = pool ? movieBadgeImage(pool, badgeImgMap) : null;
  return url ? `<img class="badge-ic" src="${escapeHtml(url)}" alt="" loading="lazy" />` : '<span class="badge-ic badge-none" title="нет значка чата">—</span>';
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
  $('movieBadgeList').innerHTML = rows.length ? rows.map(movieBadgeRowHtml).join('') : '';
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
async function saveMovie() { await saveSettings({ movieRewardTitle: $('movieRewardTitle').value.trim() || 'Предложить лот', movieBase: parseInt($('movieBase').value, 10) || 0, movieAsDonation: $('movieAsDonation').checked, movieUsePoints: $('movieUsePoints').checked, movieDropNegForeign: $('movieDropNegForeign').checked, movieBadges: readMovieBadges() }); flashSaved(); renderMoviePointsSrc(); }
function syncMovieBar() { const on = $('movieActive').checked; $('movieSwitch').classList.toggle('on', on); const h = $('moviePointaucHint'); if (h) h.hidden = !on; } // напоминание про приём ставок в pointauc — только когда ставки включены
// Статус источника PigPoints в модуле (под тумблером): вкл/выкл + подключена ли таблица.
function renderMoviePointsSrc(s) {
  const el = $('moviePointsSrc'); if (!el) return;
  const use = s ? s.movieUsePoints !== false : $('movieUsePoints').checked;
  const hasSheet = !!((s ? s.sheetUrl : $('sheetUrl').value) || '').trim();
  if (!hasSheet) { el.textContent = 'ставка: база + значки чата (таблица не используется)'; el.className = 'health'; } // значки-only — валидный режим, не ошибка
  else if (!use) { el.textContent = 'PigPoints в ставке: выкл'; el.className = 'health'; }
  else if (sheetState === 'err') { el.textContent = '⚠ таблица недоступна — пока только база и значки чата'; el.className = 'health err'; }
  else { el.textContent = '✓ PigPoints: из таблицы'; el.className = 'health ok'; }
}

// тумблер фичи: вкл → создать/включить награду «Предложить лот» (новый раунд); выкл → выключить
async function onToggleMovieBids() {
  const active = $('movieActive').checked;
  syncMovieBar();
  const s = await loadSettings();
  if (!s.twitchToken || !s.twitchUserId) { $('movieActive').checked = false; syncMovieBar(); return setStatus('Сначала подключи Twitch.', 'error'); }
  const ctx = { clientId: s.twitchClientId || DEFAULT_TWITCH_CLIENT_ID, token: s.twitchToken, broadcasterId: s.twitchUserId };
  const title = ($('movieRewardTitle').value || 'Предложить лот').trim(); // из поля (могли только что поменять)
  setStatus(active ? `Создаю награду «${title}»…` : 'Выключаю награду…');
  try {
    if (active) {
      const reward = await syncReward(ctx, { rewardId: s.movieRewardId || '', rewardTitle: title, cost: 1, points: 0, target: 'input', prompt: 'Напиши название лота' });
      await saveSettings({ movieRewardId: reward.id, movieBidsActive: true, movieRewardTitle: title, movieBase: parseInt($('movieBase').value, 10) || 0, movieAsDonation: $('movieAsDonation').checked });
      await chrome.runtime.sendMessage({ type: 'movie-new-round' }).catch(() => {}); // сброс раунда атомарно в фоне (очередь + зачёт + журнал + кэши)
      chrome.runtime.sendMessage({ type: 'movie-subscribe' }).catch(() => {}); // поднять чат-подписку на текущей сессии
      renderMovieJournal([]);
      setStatus(`Награда «${title}» активна.`, 'ok');
    } else {
      let warn = '';
      if (s.movieRewardId) { try { await updateReward(ctx, s.movieRewardId, { is_enabled: false }); } catch (err) { warn = ` (⚠ могла остаться активной: ${err.message})`; } }
      await saveSettings({ movieBidsActive: false }); // id сохраняем (keepExtra защитит, можно снова включить)
      setStatus('Награда «Предложить лот» выключена.' + warn, warn ? 'error' : 'ok');
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
  { const pr = $('pigpointsCard'); if (pr) pr.classList.toggle('has-pending', rows.length > 0); } // подсветить свёрнутый модуль, когда есть заявки
  if (rows.length > prevPendingCount) { card.open = true; const pr = $('pigpointsCard'); if (pr) pr.open = true; } // всплываем только при НОВОЙ заявке
  prevPendingCount = rows.length;
  const el = $('twitchPending');
  if (!rows.length) { el.innerHTML = '<div class="muted" style="font-size:11px">пока пусто</div>'; return; }
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
  setStatus(`Скрипт скопирован, секрет ${newSecret ? 'сгенерён и ' : ''}сохранён. Вставь в Apps Script → Deploy (Web app: Me/Anyone) → и вставь URL сюда.`, 'ok');
}

// сообщения от worker (прогресс/итог, если окно открыто)
chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'progress') setStatus(`Обрабатываю… ${m.done}/${m.total}`);
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
  if (s.sheetUrl) runSheetCheck();
  if (s.token) runPointaucCheck();
  updatePurchaseVisibility(s);
  updatePointsCfgVisibility(s);
  updatePigRewardsCfg(s);
  updatePurchaseCfg(s);

  // авто-сохранение: любое изменение поля в настройках сразу пишется в storage (input — с задержкой, change — сразу)
  $('settings').addEventListener('input', () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveAll, 400); renderMoviePointsSrc(); });
  $('settings').addEventListener('change', async (e) => {
    await saveAll();
    refreshStrip();                                                          // токен/таблица/twitch — обновить чипы статуса
    renderMoviePointsSrc();                                                  // таблица подключена/нет → статус PigPoints в модуле
    { const ns = await loadSettings(); updatePurchaseVisibility(ns); updatePointsCfgVisibility(ns); updatePigRewardsCfg(ns); updatePurchaseCfg(ns); } // запись → модуль покупок + награды PigPoints; таблица → настройки PigPoints + блок записи
    if (['sheetUrl', 'nickCol', 'pointsCol', 'firstRow'].includes(e.target.id)) runSheetCheck();                                                  // влияет на чтение CSV
    if (['sheetUrl', 'sheetName', 'nickCol', 'pointsCol', 'firstRow', 'buySameCol', 'buyPointsCol'].includes(e.target.id) && $('webAppUrl').value.trim()) runHealthCheck(); // влияет на скрипт/гейт записи → детект «устарел»
    if (e.target.id === 'token') runPointaucCheck();
  });
  $('webAppUrl').addEventListener('change', runHealthCheck);
  $('webAppHealth').addEventListener('click', runHealthCheck);
  $('sheetHealth').addEventListener('click', runSheetCheck);
  $('tokenHealth').addEventListener('click', runPointaucCheck);
  $('copyScript').addEventListener('click', onCopyScript);
  $('howto').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('help.html#install') }));
  $('helpBtn').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('help.html') }));
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
  $('statusStrip').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) gotoSetting(c.dataset.target); }); // чип → секция настроек
  document.addEventListener('click', (e) => { const l = e.target.closest('.settings-link'); if (l) gotoSetting(l.dataset.target); }); // «⚙ настроить» в модуле → секция настроек
}
// открыть Настройки и проскроллить к нужному полю/секции
function gotoSetting(id) {
  $('settings').open = true;
  const el = document.getElementById(id);
  if (el) { const card = el.closest('details'); if (card && card !== $('settings')) card.open = true; el.scrollIntoView({ block: 'center' }); el.focus?.(); }
}

init();
