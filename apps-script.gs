/**
 * PigRating — приём начислений рейтинга в Google-таблицу (покупка рейтинга за балы канала).
 *
 * Проще всего: в расширении кнопка «📋 Скопировать скрипт» сама подставит сюда
 * gid таблицы, столбцы и сгенерированный секрет. Этот файл — ручной образец.
 *
 * Установка (один раз):
 *  1) Таблица → Расширения → Apps Script → вставь этот код.
 *  2) Замени SECRET, проверь SHEET_NAME (имя вкладки), NICK_COL / POINTS_COL / FIRST_ROW.
 *  3) Deploy → New deployment → Web app: Execute as Me, Who has access Anyone → Allow → скопируй URL (.../exec).
 *  4) Вставь URL и SECRET в настройки расширения.
 *
 * Расширение шлёт POST {secret, nick, points} → скрипт инкрементит баллы ника.
 */

const SECRET     = 'ПРИДУМАЙ_СЕКРЕТ';
const SHEET_NAME = 'Лист1';   // имя вкладки с ник/баллы
const NICK_COL   = 4;     // столбец ника   (A=1, B=2, C=3, D=4)
const POINTS_COL = 5;     // столбец баллов (E=5)
const FIRST_ROW  = 2;

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return out({ ok: false, error: 'busy, повтори' });
  try {
    const b = JSON.parse(e.postData.contents);
    if (b.secret !== SECRET) return out({ ok: false, error: 'bad secret' });
    if (b.ping) { const ps = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME); return out({ ok: true, sheet: SHEET_NAME, sheetFound: !!ps, nickCol: NICK_COL, pointsCol: POINTS_COL, firstRow: FIRST_ROW }); } // хелсчек + столбцы (детект «скрипт устарел»)
    const nick = String(b.nick || '').trim().replace(/^@+/, ''); // убрать ведущий @
    const pts  = Number(b.points);
    if (!nick || !isFinite(pts)) return out({ ok: false, error: 'bad input' });
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sh) return out({ ok: false, error: 'sheet not found: ' + SHEET_NAME });
    const last = sh.getLastRow();
    const col = last >= FIRST_ROW ? sh.getRange(FIRST_ROW, NICK_COL, last - FIRST_ROW + 1, 1).getValues() : [];
    let row = -1, lastNick = FIRST_ROW - 1;
    for (let i = 0; i < col.length; i++) {
      const v = String(col[i][0]).trim();
      if (v !== '') lastNick = FIRST_ROW + i;                  // последняя непустая ячейка столбца ника
      if (v.replace(/^@+/, '').toLowerCase() === nick.toLowerCase()) { row = FIRST_ROW + i; break; } // матч без учёта регистра и ведущего @
    }
    if (row === -1) { row = lastNick + 1; sh.getRange(row, NICK_COL).setValue(nick); sh.getRange(row, POINTS_COL).setValue(0); } // новый ник — сразу после последнего ника
    const cell = sh.getRange(row, POINTS_COL);
    const total = (Number(cell.getValue()) || 0) + pts;
    cell.setValue(total);
    return out({ ok: true, nick: nick, total: total });
  } catch (err) { return out({ ok: false, error: String(err) }); }
  finally { lock.releaseLock(); }
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
