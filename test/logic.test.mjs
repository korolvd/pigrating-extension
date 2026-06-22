// Тесты чистой логики + батчинга. Логика импортируется из ../core.js.
// Запуск: node test/logic.test.mjs

import { parseCsv, colToIndex, buildPlan, executePlan, resolveChoice, markName, parseMark, buildRollbackPlan, planRollbackPuts, addPoints, buildAppsScript, healthCheck, resolveRedemption, normNick, diceSimilarity, suggestNick } from '../core.js';
import { validateToken, helix, createReward, syncRewards, setRewardsEnabled, subscribeRedemptions, updateRedemptionStatus, redemptionEvent, userExists } from '../twitch.js';

let failed = 0;
const eq = (label, got, exp) => {
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  if (!ok) { failed++; console.log(`✗ ${label}\n    ожидалось: ${JSON.stringify(exp)}\n    получено:  ${JSON.stringify(got)}`); }
  else console.log(`✓ ${label}`);
};

// ───────── 1) Парсинг таблицы ─────────
const cfgAB = { firstRow: 2, nickCol: 'A', pointsCol: 'B' };
const realCsv = 'Ник,Баллы\nNik,10\nnagibator,0\nfincher,-10\n';
const rows = parseCsv(realCsv, cfgAB);
eq('parseCsv: кол-во строк', rows.length, 3);
eq('parseCsv: Nik=10', rows[0], { nick: 'Nik', rawPoints: '10', points: 10 });
eq('parseCsv: fincher=-10', rows[2], { nick: 'fincher', rawPoints: '-10', points: -10 });

const noHeader = '"Лютый, Ник",5\nbob,7\n';
const r2 = parseCsv(noHeader, { firstRow: 1, nickCol: 'A', pointsCol: 'B' });
eq('parseCsv: запятая в кавычках', r2[0], { nick: 'Лютый, Ник', rawPoints: '5', points: 5 });

// Произвольная раскладка: данные в C/D, две строки шапки (как реальная вкладка ников/баллов)
const custom = 'заголовок,,,\n,,,\nx,y,alice,12\nz,w,bob,-3\n';
const r3 = parseCsv(custom, { firstRow: 3, nickCol: 'C', pointsCol: 'D' });
eq('parseCsv: C/D со строки 3 — кол-во', r3.length, 2);
eq('parseCsv: C/D — alice=12', r3[0], { nick: 'alice', rawPoints: '12', points: 12 });

eq('colToIndex A', colToIndex('A'), 0);
eq('colToIndex AA', colToIndex('AA'), 26);
eq('colToIndex D', colToIndex('D'), 3);
eq('colToIndex мусор', colToIndex('!'), -1);

// ───────── 2) Построение плана ─────────
const lots = [
  { id: 'l1', fastId: 1, name: 'Эрго прокси', amount: 2990, investors: ['Nik'] },
  { id: 'l2', fastId: 2, name: 'Мулан 2', amount: 121, investors: ['fincher', 'oridontworry'] },
  { id: 'l3', fastId: 3, name: 'kedi', amount: 10, investors: ['multi'] },
  { id: 'l4', fastId: 4, name: 'шапито шоу', amount: 10, investors: ['multi'] },
];
const settings = { newLotPrefix: '[СОЦ] ', allowNegative: true, skipZero: true };
const testRows = [
  { nick: 'Nik', rawPoints: '10', points: 10 },        // единственный вкладчик l1 → update
  { nick: 'nagibator', rawPoints: '0', points: 0 },    // ноль → skip
  { nick: 'fincher', rawPoints: '-10', points: -10 },  // в групповом лоте l2 → resolve
  { nick: 'NEWGUY', rawPoints: '15', points: 15 },     // нет лота → resolve
  { nick: 'MULTI', rawPoints: '8', points: 8 },        // в 2 лотах → resolve
];
const plan = buildPlan(testRows, lots, settings);
eq('plan: Nik → update в l1 (fastId+метка с суммой)', { a: plan[0].action, id: plan[0].lotId, f: plan[0].fastId, inv: plan[0].investor }, { a: 'update', id: 'l1', f: 1, inv: '[СОЦ] Nik:10' });
eq('plan: nagibator → skip', plan[1].action, 'skip');
eq('plan: isDonation по умолчанию false', plan[0].isDonation, false);
eq('plan: asDonation:true → isDonation true', buildPlan([{ nick: 'Nik', rawPoints: '10', points: 10 }], lots, { ...settings, asDonation: true })[0].isDonation, true);
eq('plan: fincher в групповом лоте → resolve', { a: plan[2].action, c: plan[2].candidates.map((c) => c.name) }, { a: 'resolve', c: ['Мулан 2'] });
eq('plan: NEWGUY без лота → resolve (без кандидатов)', { a: plan[3].action, c: plan[3].candidates }, { a: 'resolve', c: [] });
eq('plan: MULTI в 2 лотах → resolve', plan[4].action, 'resolve');
eq('plan: resolve кандидаты с fastId', plan[4].candidates.map((c) => `${c.name}#${c.fastId}`), ['kedi#3', 'шапито шоу#4']);

// resolveChoice: кандидат → update (fastId+investor); новый лот → create; пропуск → skip; любой лот через lotsById
const multiItem = plan[4]; // MULTI, points 8, кандидаты l3(kedi)/l4(шапито шоу)
eq('resolve → кандидат = update', (() => { const r = resolveChoice(multiItem, 'l3', '[СОЦ] '); return { a: r.action, id: r.lotId, f: r.fastId, t: r.target, inv: r.investor }; })(), { a: 'update', id: 'l3', f: 3, t: 'kedi', inv: '[СОЦ] MULTI:8' });
eq('resolve → new = create с приставкой', (() => { const r = resolveChoice(multiItem, 'new', '[СОЦ] '); return { a: r.action, t: r.target, inv: r.investor }; })(), { a: 'create', t: '[СОЦ] MULTI', inv: '[СОЦ] MULTI:8' });
eq('resolve → skip = action skip', resolveChoice(multiItem, 'skip').action, 'skip');
eq('resolve → произвольный лот (lotsById)', (() => { const r = resolveChoice(plan[3], 'l1', '[СОЦ] ', { l1: { id: 'l1', fastId: 1, name: 'Эрго прокси' } }); return { a: r.action, f: r.fastId, t: r.target }; })(), { a: 'update', f: 1, t: 'Эрго прокси' });

// Метки [СОЦ] не считаются вкладчиками + детект «уже залито»
const markedLots = [
  { id: 'm1', fastId: 9, name: 'Half-Life 2', amount: 907, investors: ['2BeFirefly', '[СОЦ] 2BeFirefly:100'] },
  { id: 'm2', fastId: 8, name: 'Solo', amount: 50, investors: ['solo', '[СОЦ] other:5'] },
];
const planMark = buildPlan([{ nick: '2BeFirefly', rawPoints: '5', points: 5 }, { nick: 'solo', rawPoints: '5', points: 5 }], markedLots, settings);
eq('plan: уже залито → resolve + applied', { a: planMark[0].action, ap: planMark[0].applied }, { a: 'resolve', ap: true });
eq('plan: метка не ломает одиночный матч (solo → update)', { a: planMark[1].action, id: planMark[1].lotId }, { a: 'update', id: 'm2' });

const planNeg = buildPlan([{ nick: 'Nik', rawPoints: '-10', points: -10 }], lots, settings);
eq('plan: Nik -10 → update', { a: planNeg[0].action, p: planNeg[0].points }, { a: 'update', p: -10 });

// Минус выключен → отрицательные пропускаются целиком
const noNeg = { ...settings, allowNegative: false };
const planNoNeg = buildPlan([
  { nick: 'ghost', rawPoints: '-5', points: -5 },     // нет лота
  { nick: 'fincher', rawPoints: '-3', points: -3 },   // в групповом лоте
], lots, noNeg);
eq('plan: минус выкл, ghost → skip', planNoNeg[0].action, 'skip');
eq('plan: минус выкл, fincher → skip', planNoNeg[1].action, 'skip');

// ───────── 2b) Метка: формат и парсинг ─────────
eq('markName', markName('[СОЦ] ', 'Nik', 10), '[СОЦ] Nik:10');
eq('parseMark: ник+сумма', parseMark('[СОЦ] Nik:10', '[СОЦ] '), { nick: 'Nik', amount: 10 });
eq('parseMark: минус', parseMark('[СОЦ] maxxsxsx:-10', '[СОЦ] '), { nick: 'maxxsxsx', amount: -10 });
eq('parseMark: ник с пробелом/слэшем', parseMark('[СОЦ] dedus / honey:9', '[СОЦ] '), { nick: 'dedus / honey', amount: 9 });
eq('parseMark: не метка → null', parseMark('2BeFirefly', '[СОЦ] '), null);
eq('parseMark: старый формат без суммы → ник, amount NaN', parseMark('[СОЦ] old', '[СОЦ] ').nick, 'old');

// ───────── 2c) Откат: сбор и группировка ─────────
const rbLots = [
  { id: 'l1', fastId: 1, name: 'Half-Life 2', amount: 900, investors: ['2BeFirefly', '[СОЦ] 2BeFirefly:100'] },
  { id: 'l2', fastId: 2, name: 'INSIDE', amount: 190, investors: ['maxxsxsx', '[СОЦ] maxxsxsx:-10'] },
  { id: 'l3', fastId: 3, name: 'Plain', amount: 50, investors: ['realguy'] },
  { id: 'l4', fastId: 4, name: 'Shared', amount: 300, investors: ['real', '[СОЦ] a:50', '[СОЦ] b:30'] },
];
const rb = buildRollbackPlan(rbLots, '[СОЦ] ');
eq('rollback: найдено 4 метки', rb.length, 4);
eq('rollback: метка HL2', { lot: rb[0].lotName, nick: rb[0].nick, amount: rb[0].amount }, { lot: 'Half-Life 2', nick: '2BeFirefly', amount: 100 });
eq('rollback: метка INSIDE минус', { nick: rb[1].nick, amount: rb[1].amount }, { nick: 'maxxsxsx', amount: -10 });

const putsAll = planRollbackPuts(rb, rbLots);
eq('rollback PUT HL2: 900-100=800, без метки', (() => { const p = putsAll.find((x) => x.lotId === 'l1'); return { amt: p.amount, inv: p.investors }; })(), { amt: 800, inv: ['2BeFirefly'] });
eq('rollback PUT INSIDE: минус назад → 190-(-10)=200', putsAll.find((x) => x.lotId === 'l2').amount, 200);
eq('rollback PUT Shared: 2 метки в одном лоте → 300-80=220', (() => { const p = putsAll.find((x) => x.lotId === 'l4'); return { amt: p.amount, inv: p.investors }; })(), { amt: 220, inv: ['real'] });
// выборочный откат: только одна метка из Shared
const putsOne = planRollbackPuts([rb.find((x) => x.investor === '[СОЦ] a:50')], rbLots);
eq('rollback выборочно: снять только [СОЦ] a:50 → 300-50=250, остаётся b', (() => { const p = putsOne[0]; return { amt: p.amount, inv: p.investors }; })(), { amt: 250, inv: ['real', '[СОЦ] b:30'] });

// ───────── 3) executePlan: всё ставками одним POST (мок fetch) ─────────
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  return { ok: true, status: 200, json: async () => (url.endsWith('/bids') ? ['bid1'] : {}) };
};

// готовый план (как после резолва): update(#1) + 2 create + skip; инвестор-метка у всех
const execPlan = [
  { nick: 'Nik', points: 10, action: 'update', fastId: 1, target: 'Эрго прокси', investor: '[СОЦ] Nik', isDonation: true },
  { nick: 'a', points: 5, action: 'create', target: '[СОЦ] a', investor: '[СОЦ] a' },
  { nick: 'b', points: -3, action: 'create', target: '[СОЦ] b', investor: '[СОЦ] b' },
  { nick: 'c', points: 3, action: 'skip' },
];
await executePlan('TOKEN', execPlan);

const puts = calls.filter((c) => c.method === 'PUT');
const posts = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/bids'));
eq('exec: PUT не используется', puts.length, 0);
eq('exec: ровно один POST /bids', posts.length, 1);
eq('exec: в батче 3 ставки (update + 2 create)', posts[0].body.bids.length, 3);
eq('exec: update-ставка = #fastId + match + метка', { msg: posts[0].body.bids[0].message, s: posts[0].body.bids[0].insertStrategy, inv: posts[0].body.bids[0].investorId }, { msg: '#1', s: 'match', inv: '[СОЦ] Nik' });
eq('exec: create-ставка = имя + force + метка', { msg: posts[0].body.bids[1].message, s: posts[0].body.bids[1].insertStrategy, inv: posts[0].body.bids[1].investorId }, { msg: '[СОЦ] a', s: 'force', inv: '[СОЦ] a' });
eq('exec: isDonation прокидывается (Nik true, a false)', { nik: posts[0].body.bids[0].isDonation, a: posts[0].body.bids[1].isDonation }, { nik: true, a: false });
eq('exec: статусы update/create = ok', execPlan.filter((it) => it.status === 'ok').length, 3);
eq('exec: skip остаётся skip', execPlan.filter((it) => it.status === 'skip').length, 1);

// ───────── 4) addPoints: запись в таблицу через Apps Script (мок fetch) ─────────
const apCalls = [];
globalThis.fetch = async (url, opts = {}) => { apCalls.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, nick: 'Nick', total: 42 }) }; };
const apRes = await addPoints('https://script.google.com/x/exec', 'sek', 'Nick', 5);
eq('addPoints: вернул total', apRes.total, 42);
eq('addPoints: POST text/plain + тело {secret,nick,points}', { m: apCalls[0].method, ct: apCalls[0].headers['Content-Type'], b: apCalls[0].body }, { m: 'POST', ct: 'text/plain;charset=utf-8', b: { secret: 'sek', nick: 'Nick', points: 5 } });

globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'bad secret' }) });
let apThrew = false; try { await addPoints('u', 's', 'n', 1); } catch { apThrew = true; }
eq('addPoints: ok:false → ошибка', apThrew, true);

globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '' });
let apThrew2 = false; try { await addPoints('u', 's', 'n', 1); } catch { apThrew2 = true; }
eq('addPoints: HTTP-ошибка → ошибка', apThrew2, true);

globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>login</html>' });
let apThrew3 = false; try { await addPoints('u', 's', 'n', 1); } catch { apThrew3 = true; }
eq('addPoints: не-JSON (auth-стена) → ошибка', apThrew3, true);

globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"nick":"x"}' });
let apThrew4 = false; try { await addPoints('u', 's', 'n', 1); } catch { apThrew4 = true; }
eq('addPoints: ответ без поля ok → ошибка', apThrew4, true);

// healthCheck: POST-ping проверка веб-аппа (тот же путь, что запись)
const hcCalls = [];
globalThis.fetch = async (url, opts = {}) => { hcCalls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, sheet: 'Лист1', sheetFound: true }) }; };
const hc = await healthCheck('https://script.google.com/x/exec', 'sek');
eq('healthCheck: ok + sheetFound', { ok: hc.ok, found: hc.sheetFound }, { ok: true, found: true });
eq('healthCheck: POST ping {secret,ping}', { m: hcCalls[0].method, b: hcCalls[0].body }, { m: 'POST', b: { secret: 'sek', ping: true } });

globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'bad input' }) });
let hcThrew4 = false; try { await healthCheck('u', 's'); } catch (e) { hcThrew4 = /пересними|старый/.test(e.message); }
eq('healthCheck: старый скрипт (bad input) → подсказка переснять', hcThrew4, true);

globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, sheet: 'X', sheetFound: false }) });
let hcThrew = false; try { await healthCheck('u', 's'); } catch (e) { hcThrew = /не найден/.test(e.message); }
eq('healthCheck: лист не найден → ошибка', hcThrew, true);

globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'bad secret' }) });
let hcThrew2 = false; try { await healthCheck('u', 's'); } catch (e) { hcThrew2 = /секрет/.test(e.message); }
eq('healthCheck: неверный секрет → ошибка', hcThrew2, true);

globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>login</html>' });
let hcThrew3 = false; try { await healthCheck('u', 's'); } catch { hcThrew3 = true; }
eq('healthCheck: не-JSON → ошибка', hcThrew3, true);

// ───────── 5) buildAppsScript: подстановка настроек + секрета (лист по имени) ─────────
const scr = buildAppsScript({ sheetName: 'Лист1', nickCol: 'D', pointsCol: 'E', firstRow: 2, buySameCol: true, buyPointsCol: '' }, 'sek-123');
eq('buildAppsScript: SECRET подставлен', /const SECRET\s*=\s*"sek-123";/.test(scr), true);
eq('buildAppsScript: SHEET_NAME подставлен', /const SHEET_NAME = "Лист1";/.test(scr), true);
eq('buildAppsScript: поиск по имени листа', /getSheetByName\(SHEET_NAME\)/.test(scr), true);
eq('buildAppsScript: gid/getSheetId не используются', !/SHEET_GID/.test(scr) && !/getSheetId/.test(scr), true);
eq('buildAppsScript: NICK_COL=4 (D)', /const NICK_COL\s*=\s*4;/.test(scr), true);
eq('buildAppsScript: POINTS_COL=5 (E)', /const POINTS_COL\s*=\s*5;/.test(scr), true);
eq('buildAppsScript: FIRST_ROW=2', /const FIRST_ROW\s*=\s*2;/.test(scr), true);
eq('buildAppsScript: есть doPost', /function doPost\(e\)/.test(scr), true);
eq('buildAppsScript: ping-ветка для хелсчека, без doGet', /if \(b\.ping\)/.test(scr) && !/function doGet/.test(scr), true);

const scr2 = buildAppsScript({ sheetName: 'Данные', nickCol: 'D', pointsCol: 'E', firstRow: 3, buySameCol: false, buyPointsCol: 'F' }, 's');
eq('buildAppsScript: отдельный столбец F → POINTS_COL=6', /const POINTS_COL\s*=\s*6;/.test(scr2), true);
eq('buildAppsScript: SHEET_NAME = Данные', /const SHEET_NAME = "Данные";/.test(scr2), true);
eq('buildAppsScript: FIRST_ROW=3', /const FIRST_ROW\s*=\s*3;/.test(scr2), true);

let baThrewName = false; try { buildAppsScript({ sheetName: '  ', nickCol: 'D', pointsCol: 'E', firstRow: 2, buySameCol: true, buyPointsCol: '' }, 's'); } catch { baThrewName = true; }
eq('buildAppsScript: пустое имя листа → throw', baThrewName, true);

let baThrew = false; try { buildAppsScript({ sheetName: 'Лист1', nickCol: '-', pointsCol: 'E', firstRow: 2, buySameCol: true, buyPointsCol: '' }, 's'); } catch { baThrew = true; }
eq('buildAppsScript: битый столбец ника → throw', baThrew, true);

const scr3 = buildAppsScript({ sheetName: 'Лист1', nickCol: 'D', pointsCol: 'E', firstRow: 2, buySameCol: false, buyPointsCol: 'F2' }, 's');
eq('buildAppsScript: мусор в buyPointsCol → откат на pointsCol=5', /const POINTS_COL\s*=\s*5;/.test(scr3), true);
eq('buildAppsScript: новый ник — после последнего ника (lastNick+1)', /lastNick \+ 1/.test(scr3) && !/Math\.max\(last/.test(scr3), true);
eq('buildAppsScript: матч ника без учёта регистра', /toLowerCase\(\) === nick\.toLowerCase\(\)/.test(scr3), true);
eq('buildAppsScript: @ убирается при матче/записи ника', /replace\(\/\^@\+\//.test(scr3), true);
eq('buildAppsScript: lock через tryLock → валидный JSON при контенции', /tryLock\(10000\)/.test(scr3) && !/waitLock/.test(scr3), true);

// ───────── 6) resolveRedemption: маппинг наград Twitch → начисление ─────────
const RMAP = [
  { rewardTitle: 'Рейтинг +50', points: 50, target: 'self' },
  { rewardId: 'abc', rewardTitle: 'старое имя', points: 100, target: 'self' },
  { rewardTitle: 'Насвинячить', points: -30, target: 'input' },
];
eq('resolve: по названию (регистр), себе → логин зрителя', resolveRedemption(RMAP, { rewardTitle: 'рейтинг +50', userLogin: 'Vasya' }), { nick: 'vasya', points: 50, target: 'self' });
eq('resolve: по rewardId (приоритет, имя другое)', resolveRedemption(RMAP, { rewardId: 'abc', rewardTitle: 'неважно', userLogin: 'Petya' }), { nick: 'petya', points: 100, target: 'self' });
eq('resolve: target input — ник из ввода (@/пробелы убраны)', resolveRedemption(RMAP, { rewardTitle: 'Насвинячить', userLogin: 'a', userInput: ' @TargetGuy ' }), { nick: 'targetguy', points: -30, target: 'input' });
eq('resolve: input без ника → начисление себе', resolveRedemption(RMAP, { rewardTitle: 'Насвинячить', userLogin: 'A', userInput: '' }), { nick: 'a', points: -30, target: 'input' });
eq('resolve: незамапленная награда → null', resolveRedemption(RMAP, { rewardTitle: 'Другая', userLogin: 'x' }), null);
eq('resolve: пустой title не матчит пустой title строки', resolveRedemption([{ rewardTitle: '', points: 5, target: 'self' }], { rewardTitle: '', userLogin: 'x' }), null);
eq('resolve: нулевые баллы → skip', !!resolveRedemption([{ rewardTitle: 'X', points: 0, target: 'self' }], { rewardTitle: 'X', userLogin: 'a' }).skip, true);
eq('normNick: @ + регистр + пробелы', normNick('  @CoolGuy '), 'coolguy');

// ───────── 6b) похожесть ников (Дайс по биграммам) для подсказок ─────────
eq('dice: идентичные = 1', diceSimilarity('refirne', 'refirne'), 1);
eq('dice: регистр игнорируется', diceSimilarity('ReFiRnE', 'refirne'), 1);
eq('dice: пример xsalreen↔xalreenstream > 0.4', diceSimilarity('xsalreen', 'xalreenstream') > 0.4, true);
eq('dice: совсем разные < 0.4', diceSimilarity('abcdef', 'zyxwvu') < 0.4, true);
eq('suggest: лучший похожий из таблицы (исходный регистр)', suggestNick('xsalreen', ['vasya', 'XAlreenStream', 'petya']).nick, 'XAlreenStream');
eq('suggest: точное совпадение не предлагается', suggestNick('vasya', ['Vasya', 'petya']), null);
eq('suggest: нет похожих → null', suggestNick('qwerty', ['vasya', 'petya']), null);

// ───────── 7) Twitch: validateToken + helix ─────────
globalThis.fetch = async (url, opts = {}) => ({ ok: true, status: 200, json: async () => ({ client_id: 'cid', login: 'streamer', user_id: '123', scopes: ['channel:manage:redemptions'] }) });
const vt = await validateToken('tok');
eq('validateToken: user_id/login', { u: vt.user_id, l: vt.login }, { u: '123', l: 'streamer' });

globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
let vtThrew = false; try { await validateToken('bad'); } catch { vtThrew = true; }
eq('validateToken: 401 → ошибка', vtThrew, true);

const hxCalls = [];
globalThis.fetch = async (url, opts = {}) => { hxCalls.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'r1' }] }) }; };
const hx = await helix('/channel_points/custom_rewards', { clientId: 'cid', token: 'tok', method: 'POST', body: { title: 'X', cost: 100 } });
eq('helix: POST с Client-Id/Bearer и телом', { m: hxCalls[0].method, ci: hxCalls[0].headers['Client-Id'], a: hxCalls[0].headers.Authorization, b: hxCalls[0].body, id: hx.data[0].id }, { m: 'POST', ci: 'cid', a: 'Bearer tok', b: { title: 'X', cost: 100 }, id: 'r1' });

globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ message: 'bad reward' }) });
let hxThrew = false; try { await helix('/x', { clientId: 'c', token: 't' }); } catch (e) { hxThrew = /bad reward/.test(e.message); }
eq('helix: ошибка → message из ответа', hxThrew, true);

globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'unauthorized' }) });
let hxErr; try { await helix('/x', { clientId: 'c', token: 't' }); } catch (e) { hxErr = e; }
eq('helix: ошибка несёт .status (для логики 401/403)', hxErr && hxErr.status, 401);

let crReq;
globalThis.fetch = async (url, opts = {}) => { crReq = { url, method: opts.method }; return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'newid' }] }) }; };
const cr = await createReward({ clientId: 'c', token: 't', broadcasterId: 'b' }, { title: 'X', cost: 100 });
eq('createReward: POST + broadcaster_id + вернул id', { m: crReq.method, q: /broadcaster_id=b/.test(crReq.url), id: cr.id }, { m: 'POST', q: true, id: 'newid' });

const scalls = [];
globalThis.fetch = async (url, opts = {}) => {
  scalls.push({ method: opts.method });
  if (opts.method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) }; // существующих наград нет
  return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: opts.method === 'POST' ? 'ridNew' : 'ridUpd' }] }) };
};
const synced = await syncRewards({ clientId: 'c', token: 't', broadcasterId: 'b' }, [
  { rewardTitle: 'A', cost: 100, points: 50, target: 'self' },
  { rewardId: 'ex', rewardTitle: 'B', cost: 200, points: 10, target: 'input' },
]);
const loopM = scalls.map((c) => c.method).filter((m) => m === 'POST' || m === 'PATCH');
eq('syncRewards: без id→POST, с id→PATCH', { m1: loopM[0], m2: loopM[1] }, { m1: 'POST', m2: 'PATCH' });
eq('syncRewards: rewardId записан + статусы ok', { id0: synced[0].rewardId, s0: synced[0].syncStatus, s1: synced[1].syncStatus }, { id0: 'ridNew', s0: 'ok', s1: 'ok' });

let dupPosts = 0;
globalThis.fetch = async (url, opts = {}) => {
  if (opts.method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
  dupPosts++;
  if (dupPosts === 1) return { ok: false, status: 400, text: async () => JSON.stringify({ message: 'DUPLICATE' }) };
  return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'ok2' }] }) };
};
const synced2 = await syncRewards({ clientId: 'c', token: 't', broadcasterId: 'b' }, [
  { rewardTitle: 'dup', cost: 100, points: 1, target: 'self' },
  { rewardTitle: 'good', cost: 100, points: 1, target: 'self' },
]);
eq('syncRewards: ошибка строки не валит остальные', { s0: synced2[0].syncStatus, s1: synced2[1].syncStatus }, { s0: 'error', s1: 'ok' });

const smethods = [];
globalThis.fetch = async (url, opts = {}) => { smethods.push(opts.method); if (opts.method === 'PATCH') return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'not found' }) }; return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'recreated' }] }) }; };
const synced3 = await syncRewards({ clientId: 'c', token: 't', broadcasterId: 'b' }, [{ rewardId: 'stale', rewardTitle: 'A', cost: 100, points: 5, target: 'self' }]);
eq('syncRewards: 404 на update → пересоздание (PATCH→POST), новый id', { ok: synced3[0].syncStatus, id: synced3[0].rewardId, seq: smethods.join(',') }, { ok: 'ok', id: 'recreated', seq: 'GET,PATCH,POST' }); // GET — листинг (адопция/зачистка) перед циклом

// зачистка осиротевших: наша награда, которой нет в маппинге (ни по id, ни по названию) → DELETE; награду из маппинга не трогаем
const orphCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  orphCalls.push({ method: opts.method, url });
  if (opts.method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'keep1', title: 'A' }, { id: 'orphan1', title: 'Z' }] }) };
  return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'keep1' }] }) };
};
await syncRewards({ clientId: 'c', token: 't', broadcasterId: 'b' }, [{ rewardId: 'keep1', rewardTitle: 'A', cost: 100, points: 5, target: 'self' }]);
eq('syncRewards: осиротевшую награду (нет в маппинге) удаляет', orphCalls.some((c) => c.method === 'DELETE' && /id=orphan1/.test(c.url)), true);
eq('syncRewards: награду из маппинга НЕ удаляет', orphCalls.some((c) => c.method === 'DELETE' && /id=keep1/.test(c.url)), false);

// адопция: строка без rewardId, но одноимённая награда уже на Twitch → переиспользуем (PATCH), без POST и без удаления
const adoptCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  adoptCalls.push({ method: opts.method, url });
  if (opts.method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'existed', title: 'Поднять рейтинг' }] }) };
  return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'existed' }] }) };
};
const adopted = await syncRewards({ clientId: 'c', token: 't', broadcasterId: 'b' }, [{ rewardTitle: 'поднять РЕЙТИНГ', cost: 100, points: 5, target: 'self' }]);
eq('syncRewards: адопция одноимённой (регистр игнор) — PATCH по id, без POST', { id: adopted[0].rewardId, patched: adoptCalls.some((c) => c.method === 'PATCH' && /id=existed/.test(c.url)), posted: adoptCalls.some((c) => c.method === 'POST') }, { id: 'existed', patched: true, posted: false });
eq('syncRewards: адоптированную одноимённую не удаляет', adoptCalls.some((c) => c.method === 'DELETE'), false);

// защита по названию: даже если sync строки упал, одноимённую награду (по названию) не сносим
const protCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  protCalls.push({ method: opts.method });
  if (opts.method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'exX', title: 'X' }] }) };
  if (opts.method === 'PATCH') return { ok: false, status: 500, text: async () => JSON.stringify({ message: 'boom' }) };
  return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'exX' }] }) };
};
const prot = await syncRewards({ clientId: 'c', token: 't', broadcasterId: 'b' }, [{ rewardTitle: 'X', cost: 100, points: 1, target: 'self' }]);
eq('syncRewards: sync упал, но одноимённую (по названию) не удаляет', { s: prot[0].syncStatus, deleted: protCalls.some((c) => c.method === 'DELETE') }, { s: 'error', deleted: false });

// протухший rewardId + одноимённая на Twitch → в ветке 404 адоптируем существующую (а не дубликат-эрор)
const staleCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  staleCalls.push({ method: opts.method, url });
  if (opts.method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'realA', title: 'A' }] }) };
  if (opts.method === 'PATCH' && /id=stale/.test(url)) return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'not found' }) };
  return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'realA' }] }) };
};
const staleSync = await syncRewards({ clientId: 'c', token: 't', broadcasterId: 'b' }, [{ rewardId: 'stale', rewardTitle: 'A', cost: 100, points: 5, target: 'self' }]);
eq('syncRewards: протухший id + одноимённая → адопция (PATCH realA), без POST', { ok: staleSync[0].syncStatus, id: staleSync[0].rewardId, posted: staleCalls.some((c) => c.method === 'POST') }, { ok: 'ok', id: 'realA', posted: false });

const seCalls = [];
globalThis.fetch = async (url, opts = {}) => { seCalls.push({ method: opts.method, body: opts.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'x' }] }) }; };
const seRes = await setRewardsEnabled({ clientId: 'c', token: 't', broadcasterId: 'b' }, [{ rewardId: 'r1', rewardTitle: 'A' }, { rewardTitle: 'B' }], false);
eq('setRewardsEnabled: PATCH is_enabled созданным, без id → skip', { m: seCalls[0].method, en: seCalls[0].body.is_enabled, n: seCalls.length, s0: seRes[0].syncStatus, s1: seRes[1].syncStatus }, { m: 'PATCH', en: false, n: 1, s0: 'ok', s1: 'skip' });

// EventSub: подписка / подтверждение / парсер
let subReq;
globalThis.fetch = async (url, opts = {}) => { subReq = { url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null }; return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'sub1' }] }) }; };
await subscribeRedemptions({ clientId: 'c', token: 't', broadcasterId: '42' }, 'sess');
eq('subscribeRedemptions: type + condition + websocket', { u: /eventsub\/subscriptions/.test(subReq.url), type: subReq.body.type, cond: subReq.body.condition.broadcaster_user_id, tr: subReq.body.transport.session_id }, { u: true, type: 'channel.channel_points_custom_reward_redemption.add', cond: '42', tr: 'sess' });

let urReq;
globalThis.fetch = async (url, opts = {}) => { urReq = { url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null }; return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'x' }] }) }; };
await updateRedemptionStatus({ clientId: 'c', token: 't', broadcasterId: 'b' }, 'rw', 'rd', 'FULFILLED');
eq('updateRedemptionStatus: PATCH + query + status', { m: urReq.method, q: /broadcaster_id=b&reward_id=rw&id=rd/.test(urReq.url), st: urReq.body.status }, { m: 'PATCH', q: true, st: 'FULFILLED' });

eq('redemptionEvent: маппинг полей', redemptionEvent({ id: 'r1', user_login: 'Vasya', user_name: 'Vasya', user_input: ' @x ', reward: { id: 'rw', title: 'T' } }), { redemptionId: 'r1', rewardId: 'rw', rewardTitle: 'T', userLogin: 'Vasya', userName: 'Vasya', userInput: ' @x ' });

globalThis.fetch = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: /login=exists/.test(url) ? [{ id: '1', login: 'exists' }] : [] }) });
eq('userExists: найден → true', await userExists({ clientId: 'c', token: 't' }, 'exists'), true);
eq('userExists: не найден → false', await userExists({ clientId: 'c', token: 't' }, 'nope'), false);

console.log(failed ? `\n❌ Провалено: ${failed}` : '\n✅ Все тесты прошли');
process.exit(failed ? 1 : 0);
