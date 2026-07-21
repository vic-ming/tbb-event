/* ============================================================
   共用邏輯：活動設定、集章狀態、彈窗、Cookie、橫向偵測
   所有頁面於 </body> 前引用：<script src="./assets/js/app.js"></script>
   ============================================================ */

// ---------- 活動設定 ----------
// 關卡總數
var EVENT_TOTAL = 4;

// 關卡編號 → 名稱與印章主題色（對應 style.css 的 .stamp-subtitle 色系）
// 新增／修改關卡時只需要改這裡，各頁面文字會一併更新
var EVENTS = {
  1: { title: '高等教育司', color: 'orange' },
  2: { title: '資訊及科技教育司', color: 'blue' },
  3: { title: '技術及職業教育司', color: 'pink' },
  4: { title: '終身教育司', color: 'green' }
};

// ---------- 集章 QR code ----------
// 各攤位 QR code 的內容，掃到對應網址才算集章成功
//   高教司 https://ccu-healthyage.com/scan/1
//   資科司 https://ccu-healthyage.com/scan/2
//   技職司 https://ccu-healthyage.com/scan/3
//   終身司 https://ccu-healthyage.com/scan/4
var SCAN_URL_PREFIX = 'https://ccu-healthyage.com/scan/';

// 解析掃描結果，回傳關卡編號；不是活動 QR code 則回傳 null
function parseScanResult(text) {
  if (typeof text !== 'string') return null;

  // 容許結尾多出斜線、query 或空白
  var trimmed = text.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (trimmed.indexOf(SCAN_URL_PREFIX) !== 0) return null;

  // 前綴後面必須「只有」關卡編號，避免 .../scan/1x 之類的網址被誤判
  var rest = trimmed.slice(SCAN_URL_PREFIX.length);
  if (!/^\d+$/.test(rest)) return null;

  var eventId = parseInt(rest, 10);
  return EVENTS[eventId] ? eventId : null;
}

// ---------- 兌獎密碼 ----------
// 密碼以「salt:密碼」的 SHA-256 保存，避免明碼直接出現在原始碼中。
// 注意：前端驗證只能擋住隨手查看原始碼的人，無法真正防弊，
// todo: 正式上線請改由後端驗證並回傳兌換結果。
// 更換密碼：於瀏覽器 Console 執行以下指令取得新的雜湊值後貼上
//   crypto.subtle.digest('SHA-256', new TextEncoder().encode('tbb-dream-factory:新密碼'))
//     .then(b => console.log([...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')))
var REDEEM_SALT = 'tbb-dream-factory';
var REDEEM_PASSWORD_HASH = '79c3cf90760f22021f2556d146addf2d8c78530486f408e2dcef53cc1a73ee6f';

// 問卷回傳端點；留空表示尚未串接後端，作答內容僅保存在本機
// todo: 後端完成後填入 API 位址
var SURVEY_ENDPOINT = '';

// ---------- 本機儲存 ----------
// 注意：狀態存在 localStorage，使用者清除瀏覽資料或改用無痕視窗即可重來，
// 「每支裝置限一次」需要後端以裝置／帳號綁定才能真正落實。
var STORAGE_KEYS = {
  stamps: 'collectedStamps',
  survey: 'surveyCompleted',
  surveyAnswers: 'surveyAnswers',
  redeemed: 'redeemed',
  cookie: 'cookieConsent'
};

// ---------- 集章狀態 ----------
var Stamps = {
  // 讀取已集章清單（過濾掉不存在的關卡編號）
  load: function () {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.stamps));
      if (!Array.isArray(saved)) return [];
      return saved.filter(function (id) { return !!EVENTS[id]; });
    } catch (e) {
      return [];
    }
  },

  has: function (eventId) {
    return Stamps.load().indexOf(eventId) !== -1;
  },

  // 集章；回傳 true 表示本次為「新集章」，false 表示先前已集過
  collect: function (eventId) {
    var collected = Stamps.load();
    if (collected.indexOf(eventId) !== -1) return false;

    collected.push(eventId);
    localStorage.setItem(STORAGE_KEYS.stamps, JSON.stringify(collected));
    return true;
  },

  isComplete: function () {
    return Stamps.load().length >= EVENT_TOTAL;
  }
};

// ---------- 問卷與兌獎狀態 ----------
var Progress = {
  surveyDone: function () {
    return localStorage.getItem(STORAGE_KEYS.survey) === 'true';
  },

  setSurveyDone: function (answers) {
    localStorage.setItem(STORAGE_KEYS.survey, 'true');
    localStorage.setItem(STORAGE_KEYS.surveyAnswers, JSON.stringify(answers));
  },

  redeemed: function () {
    return localStorage.getItem(STORAGE_KEYS.redeemed) === 'true';
  },

  setRedeemed: function () {
    localStorage.setItem(STORAGE_KEYS.redeemed, 'true');
  }
};

// ---------- 兌獎密碼驗證 ----------
var Redeem = {
  // 回傳 Promise<boolean>；瀏覽器不支援 Web Crypto 時 reject（驗證失敗優先，不放行）
  verify: function (password) {
    if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) {
      return Promise.reject(new Error('crypto unavailable'));
    }

    var data = new TextEncoder().encode(REDEEM_SALT + ':' + password);
    return window.crypto.subtle.digest('SHA-256', data).then(function (buffer) {
      var hex = Array.prototype.map.call(new Uint8Array(buffer), function (byte) {
        return byte.toString(16).padStart(2, '0');
      }).join('');
      return hex === REDEEM_PASSWORD_HASH;
    });
  }
};

// ---------- 彈窗管理 ----------
var Popup = {
  active: null,

  show: function (popupId) {
    if (Popup.active) Popup.close();

    var popup = document.getElementById(popupId);
    if (!popup) return;

    popup.style.display = 'flex';
    Popup.active = popupId;
    document.body.style.overflow = 'hidden';
  },

  close: function () {
    if (!Popup.active) return;

    var popup = document.getElementById(Popup.active);
    if (popup) popup.style.display = 'none';

    Popup.active = null;
    document.body.style.overflow = 'auto';
  },

  closeAll: function () {
    var popups = document.querySelectorAll('.popup-overlay');
    Array.prototype.forEach.call(popups, function (popup) {
      popup.style.display = 'none';
    });
    Popup.active = null;
    document.body.style.overflow = 'auto';
  },

  // 橫向鎖定中不接受任何關閉操作，必須先轉回直向
  isLocked: function () {
    return document.body.classList.contains('landscape-locked');
  },

  init: function () {
    // 點擊背景關閉
    document.addEventListener('click', function (e) {
      if (!e.target.classList.contains('popup-overlay')) return;
      if (Popup.isLocked()) return;
      Popup.close();
    });

    // ESC 關閉
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !Popup.active) return;
      if (Popup.isLocked()) return;
      Popup.close();
    });
  }
};

// 舊有頁面 onclick 沿用的簡寫
function showPopup(popupId) { Popup.show(popupId); }
function closePopup() { Popup.close(); }

// ---------- Cookie 同意 ----------
var CookieConsent = {
  accepted: function () {
    return localStorage.getItem(STORAGE_KEYS.cookie) === 'accepted';
  },

  // 未同意過才顯示同意列
  show: function () {
    if (CookieConsent.accepted()) return;

    var bar = document.getElementById('cookieConsent');
    if (!bar) return;

    bar.style.display = 'block';
    document.body.classList.add('has-cookie-consent');

    // 等一個影格讓初始狀態先渲染，動畫才會生效
    requestAnimationFrame(function () {
      setTimeout(function () { bar.classList.add('showing'); }, 10);
    });
  },

  hide: function () {
    var bar = document.getElementById('cookieConsent');
    if (!bar) return;

    bar.classList.remove('showing');
    bar.classList.add('hiding');

    // 等待動畫播完再隱藏（時間與 style.css 的 transition 一致）
    setTimeout(function () {
      bar.style.display = 'none';
      bar.classList.remove('hiding');
      document.body.classList.remove('has-cookie-consent');
    }, 400);
  }
};

function handleCookieAccept() {
  localStorage.setItem(STORAGE_KEYS.cookie, 'accepted');
  CookieConsent.hide();
}

// 不記錄狀態，下次進站仍會再次詢問
function handleCookieDisagree() {
  CookieConsent.hide();
}

function closeCookieWarningPopup() {
  Popup.close();
}

// 「開始蒐集」：未同意 Cookie 就先提示
function startCollect() {
  if (!CookieConsent.accepted()) {
    Popup.show('cookieWarningPopup');
    return;
  }
  window.location.href = 'event-list.html';
}

// ---------- 橫向偵測 ----------
var Orientation = {
  isMobile: function () {
    // 螢幕寬度在平板以下，或 UA 是常見行動裝置
    if (window.innerWidth <= 768) return true;

    var ua = navigator.userAgent || navigator.vendor || window.opera;
    return /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(ua);
  },

  // 橫向提示是共用的，直接由 JS 補上，各頁面不必重複貼一份 markup
  ensurePopup: function () {
    if (document.getElementById('upright')) return;

    var popup = document.createElement('div');
    popup.className = 'popup-overlay';
    popup.id = 'upright';
    popup.innerHTML = '<img src="./assets/images/upright.svg" alt="請直向使用">';
    document.body.appendChild(popup);
  },

  // 行動裝置橫向時鎖定畫面（顯示／隱藏交給 CSS 的 .landscape-locked）
  check: function () {
    var isLandscape = Orientation.isMobile() && window.innerWidth > window.innerHeight;
    document.body.classList.toggle('landscape-locked', isLandscape);
  },

  init: function () {
    Orientation.ensurePopup();
    Orientation.check();

    window.addEventListener('resize', Orientation.check);
    window.addEventListener('orientationchange', function () {
      // 方向變更後尺寸稍晚才更新，延遲再判斷一次
      setTimeout(Orientation.check, 100);
    });
  }
};

// ---------- 初始化 ----------
document.addEventListener('DOMContentLoaded', function () {
  Popup.init();
  Orientation.init();
  CookieConsent.show();
});
