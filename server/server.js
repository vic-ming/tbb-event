/* ============================================================
   活動後端 API

   以 Node 內建模組實作，沒有任何 npm 相依：
     - node:http    HTTP 伺服器
     - node:sqlite  資料庫（Node 22.5+ 內建，ARM 上不需編譯原生模組）

   端點（皆為 POST、JSON body）：
     /api/log     記錄瀏覽        { type: 'visit', device }
     /api/redeem  驗密碼並兌獎    { device, password }
     /api/stats   查詢統計        { password }
     /api/health  健康檢查（GET）

   密碼一律由環境變數提供，不寫在程式碼裡。
   ============================================================ */

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

// ---------- 設定 ----------

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || '/data/stats.db';

// 兌獎密碼（現場人員輸入）與後台查詢密碼，缺一不可啟動
const REDEEM_PASSWORD = process.env.REDEEM_PASSWORD || '';
const STATS_PASSWORD = process.env.STATS_PASSWORD || '';

if (!REDEEM_PASSWORD || !STATS_PASSWORD) {
  console.error('[fatal] 必須設定 REDEEM_PASSWORD 與 STATS_PASSWORD 環境變數');
  process.exit(1);
}

// 統計以台灣時間分日
const TIMEZONE = 'Asia/Taipei';

// 裝置代碼格式：前端產生的 UUID 或 hex 字串
const DEVICE_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

// 密碼嘗試限制：兌獎密碼只有 4 位數（10,000 組），完全不限制可在數十秒內被試完。
//
// 現場可能整場共用同一個 Wi-Fi 出口，也就是所有人共用一個 IP，
// 因此門檻刻意放寬到「連錯 30 次才鎖、且只鎖 60 秒」：
//   - 服務人員手滑幾次完全不受影響
//   - 攻擊者平均每分鐘僅能試 30 組，試完 10,000 組需要約 5.5 小時
// 對數天的活動而言足夠，且不會誤傷現場作業。
const MAX_FAILURES = 30;
const FAILURE_WINDOW_MS = 60 * 1000;

// 請求 body 上限，避免有人灌大量資料
const MAX_BODY_BYTES = 4 * 1024;

// ---------- 資料庫 ----------

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL CHECK (type IN ('visit', 'redeem')),
    device     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    date       TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
  CREATE INDEX IF NOT EXISTS idx_events_type_device ON events(type, device);

  -- 一支裝置只能兌獎一次，由資料庫層強制（前端 localStorage 清掉也繞不過）
  CREATE UNIQUE INDEX IF NOT EXISTS idx_redeem_once
    ON events(device) WHERE type = 'redeem';

  -- 問卷作答：answers 存 JSON（{ q1: '同意', q4: ['展示內容', ...], ... }）
  -- 不設唯一索引，同一裝置重複填寫都會留存，由匯出報表自行判讀
  CREATE TABLE IF NOT EXISTS surveys (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    device     TEXT NOT NULL,
    answers    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    date       TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_surveys_date ON surveys(date);
`);

const insertEvent = db.prepare(
  'INSERT INTO events (type, device, created_at, date) VALUES (?, ?, ?, ?)'
);

const countRedeem = db.prepare(
  "SELECT COUNT(*) AS n FROM events WHERE type = 'redeem' AND device = ?"
);

// 每日明細：瀏覽人次以裝置去重，總瀏覽次數為原始筆數
const selectDays = db.prepare(`
  SELECT date,
         COUNT(DISTINCT CASE WHEN type = 'visit'  THEN device END) AS visitors,
         COUNT(CASE WHEN type = 'visit' THEN 1 END)                AS pageviews,
         COUNT(DISTINCT CASE WHEN type = 'redeem' THEN device END) AS redeems
  FROM events
  GROUP BY date
  ORDER BY date
`);

const insertSurvey = db.prepare(
  'INSERT INTO surveys (device, answers, created_at, date) VALUES (?, ?, ?, ?)'
);

// 匯出用：依填答時間排序的完整作答
const selectSurveys = db.prepare(
  'SELECT device, answers, created_at, date FROM surveys ORDER BY id'
);

const countSurveys = db.prepare('SELECT COUNT(*) AS n FROM surveys');

// 總計的人次以「全期間不重複裝置」計算，不是每日相加
// （同一支手機跨兩天來訪，每日各算 1，總計仍算 1）
const selectTotal = db.prepare(`
  SELECT COUNT(DISTINCT CASE WHEN type = 'visit'  THEN device END) AS visitors,
         COUNT(CASE WHEN type = 'visit' THEN 1 END)                AS pageviews,
         COUNT(DISTINCT CASE WHEN type = 'redeem' THEN device END) AS redeems,
         MAX(created_at)                                           AS updatedAt
  FROM events
`);

// ---------- 工具 ----------

// yyyy-mm-dd（台灣時間）；sv-SE 的日期格式恰好就是 ISO
function taipeiDate(date) {
  return date.toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
}

// 2026-07-22T15:04:05+08:00
function taipeiTimestamp(date) {
  return date.toLocaleString('sv-SE', { timeZone: TIMEZONE }).replace(' ', 'T') + '+08:00';
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

// 讀取並解析 JSON body，超過上限直接中斷連線
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(new Error('invalid json'));
      }
    });

    req.on('error', reject);
  });
}

// 取得真實來源 IP；本服務只由 nginx 轉發，X-Forwarded-For 可信
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// ---------- 密碼嘗試限流 ----------

const failures = new Map(); // ip -> { count, resetAt }

function isLockedOut(ip) {
  const record = failures.get(ip);
  if (!record) return false;

  if (Date.now() > record.resetAt) {
    failures.delete(ip);
    return false;
  }

  return record.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const now = Date.now();
  const record = failures.get(ip);

  if (!record || now > record.resetAt) {
    failures.set(ip, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
    return;
  }

  record.count++;
}

function clearFailures(ip) {
  failures.delete(ip);
}

// 定期清掉過期紀錄，避免 Map 無限成長
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of failures) {
    if (now > record.resetAt) failures.delete(ip);
  }
}, FAILURE_WINDOW_MS).unref();

// ---------- 端點 ----------

// 記錄瀏覽
function handleLog(body) {
  if (body.type !== 'visit') {
    return { status: 400, data: { ok: false, error: 'invalid_type' } };
  }

  if (typeof body.device !== 'string' || !DEVICE_PATTERN.test(body.device)) {
    return { status: 400, data: { ok: false, error: 'invalid_device' } };
  }

  const now = new Date();
  insertEvent.run('visit', body.device, taipeiTimestamp(now), taipeiDate(now));

  return { status: 200, data: { ok: true } };
}

// 驗證兌獎密碼並記錄兌獎
function handleRedeem(body, ip) {
  if (typeof body.device !== 'string' || !DEVICE_PATTERN.test(body.device)) {
    return { status: 400, data: { ok: false, error: 'invalid_device' } };
  }

  if (isLockedOut(ip)) {
    return { status: 429, data: { ok: false, error: 'too_many_attempts' } };
  }

  if (body.password !== REDEEM_PASSWORD) {
    recordFailure(ip);
    return { status: 200, data: { ok: false, error: 'invalid_password' } };
  }

  clearFailures(ip);

  // 已兌換過就不再重複記錄，並明確告知前端
  if (countRedeem.get(body.device).n > 0) {
    return { status: 200, data: { ok: false, error: 'already_redeemed' } };
  }

  const now = new Date();
  try {
    insertEvent.run('redeem', body.device, taipeiTimestamp(now), taipeiDate(now));
  } catch (e) {
    // 同一裝置同時送出兩次時，唯一索引會擋下第二筆
    return { status: 200, data: { ok: false, error: 'already_redeemed' } };
  }

  return { status: 200, data: { ok: true } };
}

// 問卷作答
// 作答內容只做基本結構檢查，不驗證題號 —— 題目未來若增修，舊資料仍能保留
function handleSurvey(body) {
  if (typeof body.device !== 'string' || !DEVICE_PATTERN.test(body.device)) {
    return { status: 400, data: { ok: false, error: 'invalid_device' } };
  }

  const answers = body.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return { status: 400, data: { ok: false, error: 'invalid_answers' } };
  }

  const json = JSON.stringify(answers);

  // 作答內容含開放填答，限制長度避免有人灌大量文字
  if (json.length > 8000) {
    return { status: 400, data: { ok: false, error: 'answers_too_large' } };
  }

  const now = new Date();
  insertSurvey.run(body.device, json, taipeiTimestamp(now), taipeiDate(now));

  return { status: 200, data: { ok: true } };
}

// 後台統計
function handleStats(body, ip) {
  if (isLockedOut(ip)) {
    return { status: 429, data: { ok: false, error: 'too_many_attempts' } };
  }

  if (body.password !== STATS_PASSWORD) {
    recordFailure(ip);
    return { status: 200, data: { ok: false, error: 'unauthorized' } };
  }

  clearFailures(ip);

  const total = selectTotal.get();

  const data = {
    ok: true,
    updatedAt: total.updatedAt || null,
    days: selectDays.all(),
    total: {
      visitors: total.visitors || 0,
      redeems: total.redeems || 0,
      pageviews: total.pageviews || 0,
      surveys: countSurveys.get().n
    }
  };

  // 完整作答內容只在匯出時才回傳，平常查詢不必背這包資料
  if (body.surveys === true) {
    data.surveys = selectSurveys.all().map(function (row) {
      let answers = {};
      try {
        answers = JSON.parse(row.answers);
      } catch (e) {
        // 萬一有損毀的資料，保留空物件讓匯出仍可進行
      }
      return { device: row.device, date: row.date, createdAt: row.created_at, answers: answers };
    });
  }

  return { status: 200, data: data };
}

// ---------- 路由 ----------

const server = createServer(async (req, res) => {
  const path = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && path === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: 'invalid_body' });
  }

  const ip = clientIp(req);

  try {
    let result;

    switch (path) {
      case '/api/log':
        result = handleLog(body);
        break;
      case '/api/redeem':
        result = handleRedeem(body, ip);
        break;
      case '/api/survey':
        result = handleSurvey(body);
        break;
      case '/api/stats':
        result = handleStats(body, ip);
        break;
      default:
        result = { status: 404, data: { ok: false, error: 'not_found' } };
    }

    sendJson(res, result.status, result.data);
  } catch (error) {
    // 細節只留在伺服器日誌，不回給前端
    console.error('[error]', path, error);
    sendJson(res, 500, { ok: false, error: 'server_error' });
  }
});

server.listen(PORT, () => {
  console.log(`[ready] API listening on ${PORT}, db=${DB_PATH}`);
});

// 容器停止時正常關閉，確保 SQLite 寫入落地
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
