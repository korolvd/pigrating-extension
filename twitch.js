// Twitch-интеграция: OAuth (implicit, без бэкенда) + Helix.
// Чистые fetch-функции (validateToken/helix) тестируемы; connectTwitch требует chrome.identity (живёт в расширении).

// Общий Client ID встроенного приложения PigRating (публичный, не секрет).
// Стримеры просто жмут «Подключить»; поле в настройках — необязательный override своим приложением.
export const DEFAULT_TWITCH_CLIENT_ID = 'dz9xq3cgvky8wz4qg0jbijc351ylox';

const SCOPES = 'channel:manage:redemptions';
const HELIX = 'https://api.twitch.tv/helix';

// Проверка user access token → { client_id, login, user_id, scopes, expires_in }
export async function validateToken(token) {
  const res = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${token}` } });
  if (res.status === 401) throw new Error('Токен Twitch недействителен — переподключи канал.');
  if (!res.ok) throw new Error(`Twitch validate → HTTP ${res.status}`);
  return res.json();
}

// OAuth implicit-флоу через окно авторизации → { token, userId, login, scopes }
export async function connectTwitch(clientId) {
  if (!clientId) throw new Error('Укажи Twitch Client ID.');
  const redirect = chrome.identity.getRedirectURL();
  const url = 'https://id.twitch.tv/oauth2/authorize'
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirect)}`
    + '&response_type=token'
    + `&scope=${encodeURIComponent(SCOPES)}`
    + '&force_verify=true';
  const back = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  const params = new URLSearchParams(new URL(back).hash.slice(1));
  const token = params.get('access_token');
  if (!token) throw new Error(params.get('error_description') || 'Twitch не вернул токен.');
  const info = await validateToken(token);
  if (info.client_id !== clientId) throw new Error('Токен выдан другому Client ID.');
  return { token, userId: info.user_id, login: info.login, scopes: info.scopes || [] };
}

// Базовый Helix-запрос с авторизацией (награды/редемпшены — следующий этап).
export async function helix(path, { clientId, token, method = 'GET', query, body } = {}) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const res = await fetch(`${HELIX}${path}${qs}`, {
    method,
    headers: {
      'Client-Id': clientId,
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { const e = new Error('Токен Twitch истёк — переподключи канал.'); e.status = 401; throw e; }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) { const e = new Error((data && data.message) || `Twitch → HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}

// ── награды канала (Custom Channel Points Rewards) ──
// Только награды, созданные ЭТИМ приложением, можно обновлять/удалять и подтверждать их редемпшены.
function rewardBody(row) {
  const b = {
    title: row.rewardTitle,
    cost: Math.max(1, parseInt(row.cost, 10) || 1),
    is_enabled: true,
    is_user_input_required: row.target === 'input',
    should_redemptions_skip_request_queue: false, // редемпшены идут в очередь → мы их подтверждаем/возвращаем (режим B)
  };
  if (row.target === 'input') b.prompt = 'Введи ник, кому начислить рейтинг';
  return b;
}

export async function createReward(ctx, body) {
  const r = await helix('/channel_points/custom_rewards', { clientId: ctx.clientId, token: ctx.token, method: 'POST', query: { broadcaster_id: ctx.broadcasterId }, body });
  return r.data[0];
}
export async function updateReward(ctx, rewardId, body) {
  const r = await helix('/channel_points/custom_rewards', { clientId: ctx.clientId, token: ctx.token, method: 'PATCH', query: { broadcaster_id: ctx.broadcasterId, id: rewardId }, body });
  return r.data[0];
}
export function deleteReward(ctx, rewardId) {
  return helix('/channel_points/custom_rewards', { clientId: ctx.clientId, token: ctx.token, method: 'DELETE', query: { broadcaster_id: ctx.broadcasterId, id: rewardId } });
}
// Все награды, созданные нашим приложением на канале (для зачистки осиротевших).
export function listRewards(ctx) {
  return helix('/channel_points/custom_rewards', { clientId: ctx.clientId, token: ctx.token, query: { broadcaster_id: ctx.broadcasterId, only_manageable_rewards: true } });
}

// ── EventSub (редемпшены) + подтверждение ──
// Подписка на редемпшены наград через WebSocket-транспорт (session_id из session_welcome).
export function subscribeRedemptions(ctx, sessionId) {
  return helix('/eventsub/subscriptions', {
    clientId: ctx.clientId, token: ctx.token, method: 'POST',
    body: {
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: String(ctx.broadcasterId) },
      transport: { method: 'websocket', session_id: sessionId },
    },
  });
}

// Подтвердить (FULFILLED) или вернуть баллы (CANCELED) по редемпшену — только для наших наград.
export function updateRedemptionStatus(ctx, rewardId, redemptionId, status) {
  return helix('/channel_points/custom_rewards/redemptions', {
    clientId: ctx.clientId, token: ctx.token, method: 'PATCH',
    query: { broadcaster_id: ctx.broadcasterId, reward_id: rewardId, id: redemptionId },
    body: { status },
  });
}

// Существует ли пользователь Twitch с таким логином (для валидации адресного ника).
export async function userExists(ctx, login) {
  const r = await helix('/users', { clientId: ctx.clientId, token: ctx.token, query: { login } });
  return Array.isArray(r.data) && r.data.length > 0;
}

// EventSub-payload редемпшена → ev для resolveRedemption.
export function redemptionEvent(ev) {
  return {
    redemptionId: ev.id,
    rewardId: ev.reward && ev.reward.id,
    rewardTitle: ev.reward && ev.reward.title,
    userLogin: ev.user_login,
    userName: ev.user_name,
    userInput: ev.user_input,
  };
}

// Создать/обновить награды из строк маппинга. Возвращает строки с проставленным rewardId + syncStatus/syncError.
// Мастер-переключатель: включить/выключить все награды из маппинга (как в pointauc).
export async function setRewardsEnabled(ctx, rows, enabled) {
  const out = [];
  for (const r of rows) {
    if (!r.rewardId) { out.push({ ...r, syncStatus: 'skip' }); continue; } // ещё не создана — нечего включать
    try { await updateReward(ctx, r.rewardId, { is_enabled: enabled }); out.push({ ...r, syncStatus: 'ok' }); }
    catch (e) { if (e.status === 404) out.push({ ...r, syncStatus: 'skip' }); else out.push({ ...r, syncStatus: 'error', syncError: e.message }); }
  }
  return out;
}

const titleKey = (t) => String(t || '').trim().toLowerCase();

export async function syncRewards(ctx, rows) {
  // Существующие награды нашего приложения — для переиспользования одноимённых (после переустановки/рассинхрона) и зачистки сирот.
  let existing = [];
  try { existing = (await listRewards(ctx)).data || []; } catch { /* список недоступен — без адопции и зачистки */ }
  const idByTitle = new Map();
  for (const rw of existing) idByTitle.set(titleKey(rw.title), rw.id);

  const out = [];
  for (const r of rows) {
    if (!r.rewardTitle) { out.push({ ...r, syncStatus: 'skip' }); continue; }
    try {
      const body = rewardBody(r);
      const adopt = idByTitle.get(titleKey(r.rewardTitle)); // одноимённая на Twitch (для переиспользования вместо дубликата)
      const id = r.rewardId || adopt || ''; // нет id, но одноимённая уже есть → переиспользуем
      let reward;
      if (id) {
        try { reward = await updateReward(ctx, id, body); }
        catch (e) {
          if (e.status !== 404) throw e;
          // id протух (404): если на канале есть одноимённая — переиспользуем её, иначе создаём заново
          reward = adopt && adopt !== id ? await updateReward(ctx, adopt, body) : await createReward(ctx, body);
        }
      } else {
        reward = await createReward(ctx, body);
      }
      out.push({ ...r, rewardId: reward.id, syncStatus: 'ok' });
    } catch (e) {
      out.push({ ...r, syncStatus: 'error', syncError: e.message });
    }
  }
  // Зачистка сирот: удалить наши награды, которых нет в маппинге ни по id, ни по названию.
  // По названию — критично: иначе при ошибке create (дубликат) зачистка снесла бы существующую одноимённую награду.
  try {
    const keepId = new Set(), keepTitle = new Set();
    for (const r of rows) { if (r.rewardId) keepId.add(r.rewardId); if (r.rewardTitle) keepTitle.add(titleKey(r.rewardTitle)); }
    for (const r of out) if (r.rewardId) keepId.add(r.rewardId);
    for (const rw of existing) {
      if (keepId.has(rw.id) || keepTitle.has(titleKey(rw.title))) continue;
      try { await deleteReward(ctx, rw.id); } catch { /* уже удалена — ок */ }
    }
  } catch { /* пропускаем зачистку */ }
  return out;
}
