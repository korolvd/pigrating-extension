// Тесты чистой логики + батчинга. Логика импортируется из ../core.js.
// Запуск: node test/logic.test.mjs

import { parseCsv, colToIndex, buildPlan, executePlan, resolveChoice, markName, parseMark, buildRollbackPlan, planRollbackPuts } from '../core.js';

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

console.log(failed ? `\n❌ Провалено: ${failed}` : '\n✅ Все тесты прошли');
process.exit(failed ? 1 : 0);
