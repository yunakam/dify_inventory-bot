/** =========================
 *  Stock Monitoring, Notifications & API (GAS)
 *  - Accept waitlist requests from Dify via doPost
 *  - Periodically monitor the inventory sheet and notify on changes
 *  - Channels: Email, LINE
 *  ========================= */

/////////////////////// CONFIG ///////////////////////
const CONFIG = {

  INTENTS: { 
    ARRIVAL: 'arrival', 
    LOW_STOCK: 'low_stock' 
  },

  // How to locate the inventory sheet
  // If INVENTORY_SHEET_ID is empty, the active spreadsheet is used.
  INVENTORY_SHEET_ID: '',
  INVENTORY_SHEET_NAME: '在庫',
  REQUIRED_INVENTORY_HEADERS: ['sku', 'product_name', 'price', 'currency', 'stock', 'updated_at'],

  // Notification settings per intent
  NOTIFICATIONS: {
    arrival: {
      WAITLIST_SHEET_NAME: '入荷通知希望リスト',
      SUBJECT_TEMPLATE: ({ product_name }) => `【入荷のお知らせ】「${product_name|| '(不明)'}」が入荷しました`,
      MESSAGE_TEMPLATE: ({ product_name, price, currency, stock }) =>
        `【入荷通知】\n\n以下の商品が入荷しましたのでお知らせいたします。\n\n■商品情報\n商品名: ${product_name|| '(不明)'}\n価格: ${price} ${currency}\n現在の在庫数: ${stock}\n\n※このメッセージはシステムにより自動送信されています。`,
    },
    low_stock: {
      WAITLIST_SHEET_NAME: '在庫減通知希望リスト',
      LOW_STOCK_THRESHOLD: 5, // Threshold to trigger "low stock" notification
      SUBJECT_TEMPLATE: ({ product_name }) => `【在庫わずか】「${product_name|| '(不明)'}」`,
      MESSAGE_TEMPLATE: ({ product_name, price, currency, stock }) =>
        `【在庫減少のお知らせ】\n\n以下の商品の在庫が残りわずかとなりましたのでお知らせいたします。\n\n■商品情報\n商品名: ${product_name|| '(不明)'}\n価格: ${price} ${currency}\n現在の在庫数: ${stock}\n\n※このメッセージはシステムにより自動送信されています。`,
    },
  },

  LINE: {
    ENABLED: true,
    PUSH_URL: 'https://api.line.me/v2/bot/message/push',
    // Token is retrieved from Script Properties
    CHANNEL_ACCESS_TOKEN: PropertiesService.getScriptProperties().getProperty('LINE_MESSAGING_CHANNEL_ACCESS_TOKEN')
  },

  // Internal cache sheet
  CACHE_SHEET_NAME: '__inventory_cache__',

  // Debug log prefix
  LOG_PREFIX: '[stock-notifier]',
};


/////////////////////// Web API Entry ///////////////////////
/**
 * Accept a request from Dify to join a waitlist and append it to the sheet.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return _json({ ok: false, error: 'EMPTY_BODY' }, 400);
    }
    const body = JSON.parse(e.postData.getDataAsString());

    const sku = (body.sku || '').toString().trim();
    const productName = (body.product_name || '').toString().trim();
    if (!sku && !productName) {
      return _json({ ok: false, error: 'REQUIRED sku or product_name' }, 400);
    }
    
    const intent = String(body.intent || '').trim().toLowerCase();
    if (![CONFIG.INTENTS.ARRIVAL, CONFIG.INTENTS.LOW_STOCK].includes(intent)) {
      return _json({ ok:false, error:'INVALID_INTENT', message:'intent must be arrival or low_stock' }, 400);
    }
    const notificationConfig = CONFIG.NOTIFICATIONS[intent];
    if (!notificationConfig) {
      return _json({ ok: false, error: 'INVALID_INTENT' }, 400);
    }

    const channel = (body.channel || 'email').toString().trim().toLowerCase();
    const userId = (body.user_id || '').toString().trim();
    let finalAddress;

    if (channel === 'line') {
      if (!userId) return _json({ ok: false, error: 'REQUIRED user_id for LINE channel' }, 400);
      finalAddress = _findLineUserIdByuserId(userId);
      if (!finalAddress) return _json({ ok: false, error: 'LINE user ID not found. Please link your LINE account first.' }, 400);
    } else { // email
      finalAddress = (body.address || '').toString().trim();
      if (!finalAddress) return _json({ ok: false, error: 'REQUIRED address for email channel' }, 400);
    }

    const ss = getHomeSpreadsheet();
    const sh = getOrCreateWaitlistSheetByName(ss, notificationConfig.WAITLIST_SHEET_NAME);

    const row = [sku, productName, channel, finalAddress, userId, 'pending', new Date().toISOString(), ''];
    sh.appendRow(row);

    return _json({ ok: true, row });

  } catch (err) {
    return _json({ ok: false, error: err && err.message ? err.message : String(err) }, 500);
  }
}

function _json(obj, status) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


/////////////////////// LINE Login Callback ///////////////////////

// LINE Login channel config (IDs are stored in Script Properties)
const LINE_LOGIN_CONFIG = {
  CHANNEL_ID: PropertiesService.getScriptProperties().getProperty('LINE_LOGIN_CHANNEL_ID'),
  CHANNEL_SECRET: PropertiesService.getScriptProperties().getProperty('LINE_LOGIN_CHANNEL_SECRET'),
  USER_MAPPING_SHEET_NAME: 'UserMappings' 
};

/**
 * Lookup line_user_id in UserMappings by user_id.
 * @param {string} userId - Dify conversation ID
 * @returns {string|null}
 */
function _findLineUserIdByuserId(userId) {
  const ss = getHomeSpreadsheet();
  const sheet = ss.getSheetByName(LINE_LOGIN_CONFIG.USER_MAPPING_SHEET_NAME);
  if (!sheet) return null;

  const data = sheet.getDataRange().getValues();
  // Search from the end (prefer the latest mapping)
  for (let i = data.length - 1; i > 0; i--) {
    if (String(data[i][0]) === String(userId)) {
      return String(data[i][1] || '');
    }
  }
  return null;
}

/**
 * Callback endpoint for LINE Login; links user_id and LINE user ID.
 * @param {GoogleAppsScript.Events.DoGet} e - GET event object
 */
function doGet(e) {
  const code = e.parameter.code;
  const state = e.parameter.state; // user_id from Dify

  if (!code) {
    return HtmlService.createHtmlOutput('認証に失敗しました。無効なリクエストです。');
  }

  try {
    const tokenResponse = _getLineAccessToken(code);
    const accessToken = tokenResponse.access_token;
    
    const profileResponse = _getLineUserProfile(accessToken);
    const lineUserId = profileResponse.userId;

    _saveUserMapping(state, lineUserId);

    return HtmlService.createHtmlOutput(
      '<h1>アカウント連携が完了しました</h1><p>チャット画面に戻って会話を続けてください。このページは閉じて構いません。</p>'
    );

  } catch (err) {
    console.error('Error during LINE login: ' + err.toString());
    return HtmlService.createHtmlOutput('<h1>エラーが発生しました</h1><p>アカウント連携に失敗しました。しばらくしてからもう一度お試しください。</p><p>エラー詳細: ' + err.message + '</p>');
  }
}

/**
 * Exchange authorization code for an access token (LINE OAuth2).
 * @param {string} code
 * @returns {object}
 */
function _getLineAccessToken(code) {
  const url = 'https://api.line.me/oauth2/v2.1/token';
  const payload = {
    'grant_type': 'authorization_code',
    'code': code,
    'redirect_uri': ScriptApp.getService().getUrl(), // This GAS Web App URL
    'client_id': LINE_LOGIN_CONFIG.CHANNEL_ID,
    'client_secret': LINE_LOGIN_CONFIG.CHANNEL_SECRET
  };
  
  const response = UrlFetchApp.fetch(url, {
    'method': 'post',
    'payload': payload,
    'muteHttpExceptions': true
  });

  const result = JSON.parse(response.getContentText());
  if (result.error) {
    throw new Error('アクセストークンの取得に失敗しました: ' + result.error_description);
  }
  return result;
}

/**
 * Retrieve LINE user profile using the access token.
 * @param {string} accessToken
 * @returns {object}
 */
function _getLineUserProfile(accessToken) {
  const url = 'https://api.line.me/v2/profile';
  const response = UrlFetchApp.fetch(url, {
    'headers': {
      'Authorization': 'Bearer ' + accessToken
    },
    'muteHttpExceptions': true
  });

  const result = JSON.parse(response.getContentText());
  if (result.error) {
    throw new Error('ユーザープロファイルの取得に失敗しました: ' + result.error_description);
  }
  return result;
}

/**
 * Persist mapping between Dify user_id and LINE user ID.
 * @param {string} userId
 * @param {string} lineUserId
 */
function _saveUserMapping(userId, lineUserId) {
  const ss = getHomeSpreadsheet();
  let sheet = ss.getSheetByName(LINE_LOGIN_CONFIG.USER_MAPPING_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(LINE_LOGIN_CONFIG.USER_MAPPING_SHEET_NAME);
    sheet.appendRow(['user_id', 'line_user_id', 'linked_at']);
  }
  
  sheet.appendRow([userId, lineUserId, new Date()]);
  SpreadsheetApp.flush();
}


/////////////////////// Scheduled Entry ///////////////////////
/**
 * Main controller for inventory monitoring (time-driven trigger).
 * - Uses a script lock to avoid overlapping runs.
 * - Reads inventory and prior cache; determines notifications; then updates cache.
 */
function monitorAndNotify() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) {
    console.warn(CONFIG.LOG_PREFIX, 'another run in progress; skip');
    return;
  }

  try {
    const invSS = CONFIG.INVENTORY_SHEET_ID
      ? SpreadsheetApp.openById(CONFIG.INVENTORY_SHEET_ID)
      : SpreadsheetApp.getActiveSpreadsheet();
    
    const inventoryRows = readTable(getInventorySheet(invSS));
    const cacheSheet = getOrCreateCacheSheet(invSS);
    const initialCacheMap = readCache(cacheSheet); // Cache snapshot at start

    const arrivalWaitlistSheet = getOrCreateWaitlistSheetByName(invSS, CONFIG.NOTIFICATIONS.arrival.WAITLIST_SHEET_NAME);
    const lowStockWaitlistSheet = getOrCreateWaitlistSheetByName(invSS, CONFIG.NOTIFICATIONS.low_stock.WAITLIST_SHEET_NAME);

    _processNotifications(CONFIG.INTENTS.ARRIVAL, arrivalWaitlistSheet, inventoryRows, initialCacheMap);
    _processNotifications(CONFIG.INTENTS.LOW_STOCK, lowStockWaitlistSheet, inventoryRows, initialCacheMap);
    
    // Update cache at the end (single write)
    const newCacheMap = {};
    const now = new Date();
    for (const inv of inventoryRows) {
      const sku = String(inv.sku || '').trim();
      if (sku) {
        newCacheMap[sku] = { last_stock: toInt(inv.stock), last_seen_at: now.toISOString() };
      }
    }
    writeCache(cacheSheet, newCacheMap);
    console.log(CONFIG.LOG_PREFIX, 'Run finished successfully.');

  } catch (e) {
    console.error(CONFIG.LOG_PREFIX, 'ERROR', e.stack);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Process and send notifications for a given intent ("arrival" or "low_stock").
 * - Builds fast lookup maps from inventory.
 * - Determines eligible waiters based on stock transitions and timestamps.
 * - Sends notifications and updates statuses for successful sends.
 */
function _processNotifications(intent, waitlistSheet, inventoryRows, cacheMap) {
  const log = (...args) => console.log(CONFIG.LOG_PREFIX, `[${intent}]`, ...args);

  const notificationConfig = CONFIG.NOTIFICATIONS[intent];
  if (!notificationConfig) return;

  const waitlistRows = readTable(waitlistSheet);
  log(`Checking sheet: "${waitlistSheet.getName()}", found ${waitlistRows.length} total waiters.`);

  const parseDate = (v) => {
    if (v instanceof Date) return isNaN(v) ? null : v;
    const d = new Date(v);
    return isNaN(d) ? null : d;
  };
  const lc = (s) => String(s || '').trim().toLowerCase();

  // Build inventory lookups
  const invBySku  = {};
  const invByName = {};
  for (const inv of inventoryRows) {
    const s = lc(inv.sku);
    const n = lc(inv.product_name);
    if (s) invBySku[s] = inv;
    if (n) invByName[n] = inv;
  }

  const enqueuedRowIdx = new Set();
  const toNotify = [];

  // Core matching logic between pending waiters and current/previous stock
  function collectForTarget(inv, skuRaw, nameRaw, pendingWaiters) {
    const sku = String(skuRaw || '').trim();
    const currentStock = inv ? toInt(inv.stock) : 0; // Treat as 0 if no inventory row
    const keySku = lc(sku);
    const prev   = cacheMap[keySku];
    const prevStock    = prev ? prev.last_stock : undefined;
    const lastSeenAt   = prev && prev.last_seen_at ? parseDate(prev.last_seen_at) : null;

    let conditionNow = false;
    let justCrossed  = false;

    if (intent === CONFIG.INTENTS.ARRIVAL) {
      // Trigger: stock transitions to > 0
      conditionNow = currentStock > 0;
      justCrossed  = currentStock > 0 && (prevStock === undefined || prevStock <= 0);
    } else if (intent === CONFIG.INTENTS.LOW_STOCK) {
      const threshold = notificationConfig.LOW_STOCK_THRESHOLD;
      // Trigger: 0 < stock <= threshold
      conditionNow = currentStock > 0 && currentStock <= threshold;
      justCrossed  = prevStock !== undefined && prevStock > threshold && conditionNow;
    }

    let waitersToNotify = [];
    if (justCrossed) {
      // On threshold crossing, notify all pending waiters for the SKU
      waitersToNotify = pendingWaiters;
    } else if (conditionNow) {
      if (lastSeenAt) {
        // Notify only those created after lastSeenAt
        waitersToNotify = pendingWaiters.filter(w => {
          const t = parseDate(w.created_at);
          return t && t >= lastSeenAt;
        });
      } else {
        // For low_stock on first run (no prev), notify if condition holds
        waitersToNotify = (intent === CONFIG.INTENTS.LOW_STOCK) ? pendingWaiters : [];
      }
    }

    if (waitersToNotify.length > 0) {
      log(`SKU:${sku || '(no sku)'} notify=${waitersToNotify.length} (current:${currentStock}, prev:${prevStock})`);
      for (const waiter of waitersToNotify) {
        if (!enqueuedRowIdx.has(waiter._rowIndex)) {
          enqueuedRowIdx.add(waiter._rowIndex);
          toNotify.push({ waiter, inv: inv || { sku, product_name: nameRaw, stock: currentStock }, intent });
        }
      }
    } else {
      log(`SKU:${sku || '(no sku)'} no notify (current:${currentStock}, prev:${prevStock})`);
    }
  }

  // (1) Inventory-driven pass
  for (const inv of inventoryRows) {
    const sku = String(inv.sku || '').trim();
    if (!sku) continue;

    const pendingWaiters = findPendingWaiters(waitlistRows, sku, String(inv.product_name || ''));
    if (pendingWaiters.length === 0) continue;

    collectForTarget(inv, sku, inv.product_name, pendingWaiters);
  }

  // (2) Waitlist-driven pass (all pending)
  const pendingAll = waitlistRows.filter(r => {
    const st = lc(r.status);
    return !st || st === 'pending';
  });

  const groupMap = new Map(); // key: "sku:xxxx" or "#name:xxxx"
  for (const r of pendingAll) {
    const sku = lc(r.sku);
    const name = lc(r.product_name);
    const key = sku ? `sku:${sku}` : name ? `#name:${name}` : null;
    if (!key) continue;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(r);
  }

  for (const [key, groupWaiters] of groupMap.entries()) {
    let inv = null, skuRaw = '', nameRaw = '';
    if (key.startsWith('sku:')) {
      const skuLc = key.slice(4);
      inv = invBySku[skuLc] || null;
      skuRaw = groupWaiters[0].sku || '';
      nameRaw = groupWaiters[0].product_name || '';
    } else {
      const nameLc = key.slice(6);
      inv = invByName[nameLc] || null;
      nameRaw = groupWaiters[0].product_name || '';
      skuRaw = groupWaiters[0].sku || '';
    }

    const remaining = groupWaiters.filter(w => !enqueuedRowIdx.has(w._rowIndex));
    if (remaining.length === 0) continue;

    if (!inv) {
      log(`No inventory row for key "${key}". Will treat current stock as 0.`);
    }
    collectForTarget(inv, skuRaw, nameRaw, remaining);
  }

  // Sending notifications
  if (toNotify.length === 0) {
    log('No items to notify.');
    return;
  }

  log(`Found ${toNotify.length} total notifications to send.`);
  const results = [];
  for (const item of toNotify) {
    const sent = _sendNotification(item.waiter, item.inv, { intent: item.intent });

    log('Notify attempt', {
      sku: item.inv.sku,
      address: item.waiter.address,
      ok: sent.ok,
      detail: sent.detail
    });

    results.push({ rowIndex: item.waiter._rowIndex, ok: sent.ok });
  }

  const successCount = results.filter(r => r.ok).length;
  if (successCount > 0) {
    updateWaitlistStatuses(waitlistSheet, results);
    log(`Updated status for ${successCount} waiters in sheet "${waitlistSheet.getName()}".`);
  }
}


/**
 * Send a notification via the selected channel (Email or LINE).
 */
function _sendNotification(waiter, inv, opts) {
  const channel = String(waiter.channel || '').toLowerCase();

  if (!opts || !opts.intent) {
    return { ok: false, detail: 'opts.intent is required' };
  }

  const cfg = CONFIG.NOTIFICATIONS[opts.intent];
  if (!cfg) {
    return { ok: false, detail: 'No NOTIFICATIONS config for intent: ' + opts.intent };
  }
  if (typeof cfg.SUBJECT_TEMPLATE !== 'function' || typeof cfg.MESSAGE_TEMPLATE !== 'function') {
    return { ok: false, detail: 'Templates missing for intent: ' + opts.intent };
  }

  // Resolve subject/body once
  let subject, body;
  try {
    const resolved = _resolveTemplatesByIntent(opts.intent, inv, opts);
    subject = resolved.subject;
    body    = resolved.body;

    if (typeof subject !== 'string' || typeof body !== 'string') {
      throw new Error('Template must return string');
    }
  } catch (e) {
    return { ok: false, detail: 'Failed to resolve templates: ' + e.message };
  }

  // LINE
  if (channel === 'line') {
    const lineId = String(waiter.address || '').trim();
    if (!lineId) return { ok: false, detail: 'LINE user ID not found' };
    return _sendLinePush(lineId, body);
  }

  // Email (default)
  if (channel === 'email' || !channel) {
    const addr = String(waiter.address || '').trim();
    if (!addr) return { ok: false, detail: 'Email address is empty' };
    try {
      MailApp.sendEmail(addr, subject, body);
      return { ok: true, detail: 'Email sent to ' + addr };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  }

  return { ok: false, detail: 'Unsupported channel: ' + channel };
}


/////////////////////// Utilities ///////////////////////
/**
 * Get the inventory sheet by name, ensuring required headers exist.
 * Throws if the sheet is missing.
 */
function getInventorySheet(ss) {
  if (CONFIG.INVENTORY_SHEET_NAME) {
    const sh = ss.getSheetByName(CONFIG.INVENTORY_SHEET_NAME);
    if (!sh) throw new Error('在庫シートが見つかりません: ' + CONFIG.INVENTORY_SHEET_NAME);
    validateHeaders(sh, CONFIG.REQUIRED_INVENTORY_HEADERS);
    return sh;
  }
  const sheets = ss.getSheets();
  for (const sh of sheets) {
    try {
      validateHeaders(sh, CONFIG.REQUIRED_INVENTORY_HEADERS);
      return sh;
    } catch (_) {}
  }
  throw new Error(
    '在庫シートが見つかりません（必要ヘッダー: ' +
      CONFIG.REQUIRED_INVENTORY_HEADERS.join(', ') +
      '）'
  );
}

/**
 * Create or get the waitlist sheet for a given intent.
 */
function getOrCreateWaitlistSheetByName(ss, sheetName) {
  let sh = ss.getSheetByName(sheetName);
  if (!sh) {
    sh = ss.insertSheet(sheetName);
    sh.appendRow([
      'sku', 'product_name', 'channel', 'address', 'user_id',
      'status', 'created_at', 'notified_at',
    ]);
  }
  return sh;
}

/**
 * Create or get the cache sheet used to track prior stock values.
 */
function getOrCreateCacheSheet(ss) {
  let sh = ss.getSheetByName(CONFIG.CACHE_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.CACHE_SHEET_NAME);
    sh.appendRow(['sku', 'last_stock', 'last_seen_at', 'note']);
  }
  return sh;
}

/**
 * Ensure the given sheet includes all required header names.
 */
function validateHeaders(sheet, required) {
  const values = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const headers = normalizeHeaders(values);
  for (const key of required) {
    if (!headers.includes(key)) throw new Error('必要ヘッダーが不足: ' + key + ' @ ' + sheet.getName());
  }
}

/**
 * Read a sheet into an array of objects keyed by normalized headers.
 * Adds _rowIndex (1-based data row index) for write-back convenience.
 */
function readTable(sheet) {
  const range = sheet.getDataRange();
  const values = range.getValues();
  if (values.length < 2) return [];
  const headers = normalizeHeaders(values[0]);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[i][j];
    }
    row._rowIndex = i;
    rows.push(row);
  }
  return rows;
}

/**
 * Normalize header names: trim + lowercase strings.
 */
function normalizeHeaders(arr) {
  return arr.map((h) => String(h || '').trim().toLowerCase());
}

/**
 * Parse an integer from arbitrary input (non-digits stripped).
 */
function toInt(v) {
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Find pending waiters for the given SKU or product name.
 */
function findPendingWaiters(waitlistRows, sku, productName) {
  const skuLc = sku.toLowerCase();
  const nameLc = productName.toLowerCase();
  return waitlistRows.filter((r) => {
    const status = String(r.status || '').toLowerCase();
    if (status && status !== 'pending') return false;
    const rSku = String(r.sku || '').trim().toLowerCase();
    const rName = String(r.product_name || '').trim().toLowerCase();
    if (rSku) return rSku === skuLc;
    if (rName && nameLc) return rName === nameLc;
    return false;
  });
}

/**
 * Read prior stock cache into a map keyed by sku.
 */
function readCache(cacheSheet) {
  const rows = readTable(cacheSheet);
  const map = {};
  for (const r of rows) {
    const sku = String(r.sku || '').trim();
    if (!sku) continue;
    map[sku] = { last_stock: toInt(r.last_stock), last_seen_at: String(r.last_seen_at || '') };
  }
  return map;
}

/**
 * Write the stock cache map back to the cache sheet (overwrite).
 */
function writeCache(cacheSheet, cacheMap) {
  cacheSheet.clearContents();
  cacheSheet.getRange(1, 1, 1, 4).setValues([['sku', 'last_stock', 'last_seen_at', 'note']]);
  const rows = Object.keys(cacheMap)
    .sort()
    .map((sku) => {
      const { last_stock, last_seen_at } = cacheMap[sku];
      return [sku, last_stock, last_seen_at, ''];
    });
  if (rows.length > 0) {
    cacheSheet.getRange(2, 1, rows.length, 4).setValues(rows);
  }
}

/**
 * Update waitlist statuses to "notified" for successful sends.
 */
function updateWaitlistStatuses(waitlistSheet, results) {
  const nowStr = new Date().toISOString();
  const range = waitlistSheet.getDataRange();
  const values = range.getValues();
  const headers = normalizeHeaders(values[0]);
  const idx = { status: headers.indexOf('status'), notified_at: headers.indexOf('notified_at') };
  if (idx.status < 0 || idx.notified_at < 0) {
    console.warn(CONFIG.LOG_PREFIX, 'waitlist headers missing for status/notified_at');
    return;
  }
  const successRows = new Set(results.filter((r) => r.ok).map((r) => r.rowIndex));
  for (let i = 1; i < values.length; i++) {
    if (successRows.has(i)) {
      values[i][idx.status] = 'notified';
      values[i][idx.notified_at] = nowStr;
    }
  }
  range.setValues(values);
}

/**
 * Send a LINE push message using Messaging API.
 */
function _sendLinePush(to, text) {
  if (!CONFIG.LINE || !CONFIG.LINE.ENABLED) {
    return { ok: false, detail: 'LINE not enabled' };
  }
  var token = CONFIG.LINE.CHANNEL_ACCESS_TOKEN;
  if (!token) {
    return { ok: false, detail: 'Missing LINE_MESSAGING_CHANNEL_ACCESS_TOKEN' };
  }

  var payload = {
    to: to,
    messages: [{ type: 'text', text: text }]
  };

  var res = UrlFetchApp.fetch(CONFIG.LINE.PUSH_URL, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  if (code >= 200 && code < 300) {
    return { ok: true, detail: 'LINE push OK' };
  }
  return { ok: false, detail: 'LINE push failed: ' + code + ' ' + res.getContentText() };
}

/**
 * Resolve subject/body templates for an intent (or use explicit opts.subject/body).
 */
function _resolveTemplatesByIntent(intent, inv, opts) {
  if (opts && (opts.subject || opts.body)) {
    return { subject: String(opts.subject || ''), body: String(opts.body || '') };
  }

  if (!intent) throw new Error('intent required');
  const cfg = CONFIG.NOTIFICATIONS[intent];
  if (!cfg) throw new Error('Unknown intent: ' + intent);

  // For low_stock, the template receives cfg as the second argument by design.
  const subject = cfg.SUBJECT_TEMPLATE(inv);
  const body    = cfg.MESSAGE_TEMPLATE(inv, cfg);

  if (typeof subject !== 'string' || typeof body !== 'string') {
    throw new Error('Template must return string. Check NOTIFICATIONS.' + intent + ' templates.');
  }
  return { subject, body };
}

/**
 * Unified spreadsheet accessor for both appending and monitoring.
 */
function getHomeSpreadsheet() {
  return CONFIG.INVENTORY_SHEET_ID
    ? SpreadsheetApp.openById(CONFIG.INVENTORY_SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}
