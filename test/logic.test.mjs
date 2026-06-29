// Тесты чистой логики + батчинга. Логика импортируется из ../core.js.
// Запуск: node test/logic.test.mjs

import { parseCsv, colToIndex, addPoints, buildAppsScript, healthCheck, resolveRedemption, normNick, diceSimilarity, suggestNick, applicableMovieBadges, expectedScriptConfig, findMovieLot, moviePointsDecision, movieBadgeImage, MOVIE_BADGE_POOL } from '../core.js';
import { validateToken, helix, createReward, syncRewards, syncReward, setRewardsEnabled, subscribeRedemptions, updateRedemptionStatus, redemptionEvent, userExists } from '../twitch.js';

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

globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, sheet: 'X', sheetFound: false, nickCol: 1, pointsCol: 2, firstRow: 2 }) });
const hcNF = await healthCheck('u', 's');
eq('healthCheck: лист не найден → sheetFound:false без throw (решает runHealthCheck)', { ok: hcNF.ok, found: hcNF.sheetFound, sheet: hcNF.sheet }, { ok: true, found: false, sheet: 'X' });

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
eq('expectedScriptConfig: отдельный buy-столбец F', expectedScriptConfig({ sheetName: 'Лист1', nickCol: 'D', pointsCol: 'E', firstRow: 2, buySameCol: false, buyPointsCol: 'F' }), { nickCol: 4, pointsCol: 6, firstRow: 2, sheetName: 'Лист1' });
eq('expectedScriptConfig: тот же столбец (E)', expectedScriptConfig({ sheetName: 'Л', nickCol: 'D', pointsCol: 'E', firstRow: 2, buySameCol: true }).pointsCol, 5);
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

// ───────── 6в) applicableMovieBadges: подбор значков зрителя для ставки за значки ─────────
const MSEL = [
  { key: 'sub3', price: 200 }, { key: 'vip', price: 80 }, { key: 'mod', price: 10 },
  { key: 'giftlead1', price: 300 }, { key: 'giftlead2', price: 200 },
  { key: 'gifter10', price: 120 }, { key: 'gifter25', price: 90 },
  { key: 'bits1000', price: 60 }, { key: 'founder', price: 40 },
];
const MCB = [{ set_id: 'sub-gift-leader', id: '1' }, { set_id: 'sub-gifter', id: '15' }, { set_id: 'bits', id: '5000' }, { set_id: 'founder', id: '0' }];
const MST = { subTier: 3, vip: true, mod: false, follower: false };
eq('applicableMovieBadges: верный набор (тир/версия/minVersion/наличие)',
  applicableMovieBadges(MSEL, MCB, MST).map((x) => x.key).sort(),
  ['bits1000', 'founder', 'giftlead1', 'gifter10', 'sub3', 'vip'].sort());
eq('applicableMovieBadges: sub3 не сматчится при тире 2', applicableMovieBadges([{ key: 'sub3', price: 200 }], [], { subTier: 2 }).length, 0);
eq('applicableMovieBadges: невыбранный значок не учитывается', applicableMovieBadges([], MCB, MST).length, 0);
eq('applicableMovieBadges: цена сохраняется', applicableMovieBadges([{ key: 'vip', price: 77 }], [], { vip: true })[0], { key: 'vip', price: 77 });
eq('applicableMovieBadges: gifter25 не сматчится при 15 подарках', applicableMovieBadges([{ key: 'gifter25', price: 90 }], [{ set_id: 'sub-gifter', id: '15' }], {}).length, 0);
eq('applicableMovieBadges: топ-2 клипер (clips-leader/2)', applicableMovieBadges([{ key: 'cliplead2', price: 90 }], [{ set_id: 'clips-leader', id: '2' }], {}).map((x) => x.key), ['cliplead2']);
eq('applicableMovieBadges: топ-1 клипер не сматчится при ранге 2', applicableMovieBadges([{ key: 'cliplead1', price: 100 }], [{ set_id: 'clips-leader', id: '2' }], {}).length, 0);
eq('applicableMovieBadges: топ-1 по битам (bits-leader/1)', applicableMovieBadges([{ key: 'bitslead1', price: 70 }], [{ set_id: 'bits-leader', id: '1' }], {}).map((x) => x.key), ['bitslead1']);
eq('applicableMovieBadges: артист (artist-badge по наличию)', applicableMovieBadges([{ key: 'artist', price: 50 }], [{ set_id: 'artist-badge', id: '1' }], {}).map((x) => x.key), ['artist']);
eq('applicableMovieBadges: артист отсутствует → пусто', applicableMovieBadges([{ key: 'artist', price: 50 }], [], {}).length, 0);
eq('applicableMovieBadges: кондуктор хайп-трейна (текущий v1)', applicableMovieBadges([{ key: 'hypetrain', price: 40 }], [{ set_id: 'hype-train', id: '1' }], {}).map((x) => x.key), ['hypetrain']);
eq('applicableMovieBadges: кондуктор хайп-трейна (бывший v2 тоже учитывается)', applicableMovieBadges([{ key: 'hypetrain', price: 40 }], [{ set_id: 'hype-train', id: '2' }], {}).map((x) => x.key), ['hypetrain']);

// ───────── 6д) movieBadgeImage: маппинг значка → картинка Twitch ─────────
const BMAP = {
  vip: { '1': 'vip1.png' }, moderator: { '1': 'mod1.png' }, subscriber: { '0': 'sub0.png', '3': 'sub3.png' },
  'sub-gift-leader': { '1': 'gl1.png', '2': 'gl2.png' }, 'sub-gifter': { '1': 'g1.png', '5': 'g5.png' },
  founder: { '0': 'f0.png' }, 'artist-badge': { '1': 'art1.png' }, 'hype-train': { '1': 'ht1.png', '2': 'ht2.png' },
};
const poolBy = (k) => MOVIE_BADGE_POOL.find((p) => p.key === k);
eq('badgeImage: vip → vip v1', movieBadgeImage(poolBy('vip'), BMAP), 'vip1.png');
eq('badgeImage: mod → moderator v1', movieBadgeImage(poolBy('mod'), BMAP), 'mod1.png');
eq('badgeImage: sub1 → базовая subscriber (тир в значке нет)', movieBadgeImage(poolBy('sub1'), BMAP), 'sub0.png');
eq('badgeImage: follower → null (значка нет)', movieBadgeImage(poolBy('follower'), BMAP), null);
eq('badgeImage: giftlead2 → версия 2', movieBadgeImage(poolBy('giftlead2'), BMAP), 'gl2.png');
eq('badgeImage: gifter5 → порог 5', movieBadgeImage(poolBy('gifter5'), BMAP), 'g5.png');
eq('badgeImage: founder → по наличию', movieBadgeImage(poolBy('founder'), BMAP), 'f0.png');
eq('badgeImage: artist → по наличию', movieBadgeImage(poolBy('artist'), BMAP), 'art1.png');
eq('badgeImage: hypetrain → v1 по наличию', movieBadgeImage(poolBy('hypetrain'), BMAP), 'ht1.png');
eq('badgeImage: нет в карте → null', movieBadgeImage(poolBy('cliplead1'), BMAP), null);
eq('badgeImage: пустая карта → null', movieBadgeImage(poolBy('vip'), {}), null);

// ───────── 6г) findMovieLot + moviePointsDecision: соцрейтинг в ставке за значки ─────────
const MLOTS = [
  { id: 'a', name: 'Дюна', investors: ['vasya'] },
  { id: 'b', name: 'Матрица', investors: ['petya', 'kolya'] },
  { id: 'c', name: 'Один дома', investors: ['[СОЦРЕЙТИНГ] x:5', 'masha'] },
];
const pick = (r) => ({ isNew: r.isNew, isSole: r.isSole });
eq('findMovieLot: нет на доске → новый', pick(findMovieLot(MLOTS, 'Интерстеллар', 'vasya', '[СОЦРЕЙТИНГ] ')), { isNew: true, isSole: false });
eq('findMovieLot: существует, единственный вкладчик', pick(findMovieLot(MLOTS, 'Дюна', 'vasya', '[СОЦРЕЙТИНГ] ')), { isNew: false, isSole: true });
eq('findMovieLot: фаззи/регистр — «дюна» матчит «Дюна»', findMovieLot(MLOTS, 'дюна', 'vasya', '[СОЦРЕЙТИНГ] ').isNew, false);
eq('findMovieLot: есть другие вкладчики → не единственный', pick(findMovieLot(MLOTS, 'Матрица', 'petya', '[СОЦРЕЙТИНГ] ')), { isNew: false, isSole: false });
eq('findMovieLot: зритель не вкладчик существующего → не единственный', pick(findMovieLot(MLOTS, 'Матрица', 'vasya', '[СОЦРЕЙТИНГ] ')), { isNew: false, isSole: false });
eq('findMovieLot: метка [СОЦРЕЙТИНГ] не вкладчик → единственный (masha)', pick(findMovieLot(MLOTS, 'Один дома', 'masha', '[СОЦРЕЙТИНГ] ')), { isNew: false, isSole: true });

eq('moviePointsDecision: плюс — всегда', moviePointsDecision({ points: 5, usePoints: true, alreadyApplied: false, lot: null }), { value: 5, ownership: 'plus', reason: '' });
eq('moviePointsDecision: минус в новый лот — применяется', moviePointsDecision({ points: -7, usePoints: true, alreadyApplied: false, lot: { isNew: true } }), { value: -7, ownership: 'new', reason: '' });
eq('moviePointsDecision: минус, единственный вкладчик — применяется', moviePointsDecision({ points: -7, usePoints: true, alreadyApplied: false, lot: { isNew: false, isSole: true } }), { value: -7, ownership: 'sole', reason: '' });
eq('moviePointsDecision: минус в чужой (поддув) → 0', moviePointsDecision({ points: -7, usePoints: true, alreadyApplied: false, lot: { isNew: false, isSole: false } }).value, 0);
eq('moviePointsDecision: галка выкл (dropNegForeign=false) → минус везде', moviePointsDecision({ points: -7, usePoints: true, alreadyApplied: false, lot: { isNew: false, isSole: false }, dropNegForeign: false }), { value: -7, ownership: 'minus', reason: '' });
eq('moviePointsDecision: минус, доска недоступна → 0/unknown', moviePointsDecision({ points: -7, usePoints: true, alreadyApplied: false, lot: { error: true } }), { value: 0, ownership: 'unknown', reason: 'минус не применён: доска недоступна' });
eq('moviePointsDecision: выкл → 0', moviePointsDecision({ points: 5, usePoints: false, alreadyApplied: false, lot: null }).value, 0);
eq('moviePointsDecision: уже учтён в раунде → 0', moviePointsDecision({ points: 5, usePoints: true, alreadyApplied: true, lot: null }).value, 0);
eq('moviePointsDecision: рейтинг 0 → 0', moviePointsDecision({ points: 0, usePoints: true, alreadyApplied: false, lot: null }).value, 0);
eq('moviePointsDecision: NaN рейтинг → 0', moviePointsDecision({ points: NaN, usePoints: true, alreadyApplied: false, lot: null }).value, 0);

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

// syncReward (одиночная награда): prompt параметризуется (лот), без зачистки сирот
let mvBody;
globalThis.fetch = async (url, opts = {}) => { if (opts.method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) }; mvBody = opts.body ? JSON.parse(opts.body) : null; return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'mv1' }] }) }; };
const mv = await syncReward({ clientId: 'c', token: 't', broadcasterId: 'b' }, { rewardId: '', rewardTitle: 'Предложить лот', cost: 1, points: 0, target: 'input', prompt: 'Напиши название лота' });
eq('syncReward: prompt награды лота параметризован + input + cost 1', { id: mv.id, prompt: mvBody && mvBody.prompt, input: mvBody && mvBody.is_user_input_required, cost: mvBody && mvBody.cost }, { id: 'mv1', prompt: 'Напиши название лота', input: true, cost: 1 });

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
