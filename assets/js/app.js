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

// ---------- 後端 API ----------
// 網站與 API 同網域，所以用相對路徑即可，沒有 CORS 問題。
// 兌獎密碼與後台密碼都只存在伺服器環境變數，前端看不到也改不了。
var API_BASE = '/api';

// 問卷回傳端點（與網站同網域）
var SURVEY_ENDPOINT = API_BASE + '/survey';

// ---------- 本機儲存 ----------
// 注意：狀態存在 localStorage，使用者清除瀏覽資料或改用無痕視窗即可重來，
// 「每支裝置限一次」需要後端以裝置／帳號綁定才能真正落實。
var STORAGE_KEYS = {
  stamps: 'collectedStamps',
  survey: 'surveyCompleted',
  surveyAnswers: 'surveyAnswers',
  redeemed: 'redeemed',
  cookie: 'cookieConsent',
  device: 'deviceId'
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

// ---------- 兌獎 ----------
// 密碼驗證與「一支裝置只能兌換一次」都在後端完成，
// 後端驗證通過的同時就記下兌獎紀錄，所以前端不需要另外送統計。
var Redeem = {
  // 回傳 Promise<{ ok, error }>
  //   ok: true                    兌換成功
  //   error: 'invalid_password'   密碼錯誤
  //   error: 'already_redeemed'   這支裝置已經兌換過
  //   error: 'too_many_attempts'  密碼錯太多次，暫時鎖定
  //   error: 'network'            連不到伺服器
  submit: function (password) {
    return fetch(API_BASE + '/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device: Analytics.deviceId(),
        password: password
      })
    })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        return { ok: !!data.ok, error: data.error || null };
      })
      .catch(function () {
        // 連線失敗一律不放行
        return { ok: false, error: 'network' };
      });
  }
};

// ---------- 活動數據 ----------
// 記錄「瀏覽」人次；兌獎人次由後端在驗證密碼成功時自己記，前端不經手。
// 以裝置為單位統計：deviceId 是隨機字串，不含任何個人資料。
var ANALYTICS_ENDPOINT = API_BASE + '/log';

var Analytics = {
  // 取得（或建立）本裝置的代碼
  deviceId: function () {
    try {
      var id = localStorage.getItem(STORAGE_KEYS.device);
      if (!id) {
        id = Analytics.createId();
        localStorage.setItem(STORAGE_KEYS.device, id);
      }
      return id;
    } catch (e) {
      // 無痕模式等無法寫入的情況，退回單次性的代碼
      return Analytics.createId();
    }
  },

  createId: function () {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }

    if (window.crypto && window.crypto.getRandomValues) {
      var bytes = window.crypto.getRandomValues(new Uint8Array(16));
      return Array.prototype.map.call(bytes, function (byte) {
        return byte.toString(16).padStart(2, '0');
      }).join('');
    }

    return 'x' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
  },

  // 送出紀錄；統計失敗絕不影響活動流程，所以錯誤一律吞掉
  send: function (type) {
    try {
      fetch(ANALYTICS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: type,
          device: Analytics.deviceId()
        }),
        keepalive: true
      }).catch(function () {});
    } catch (e) {
      // 舊瀏覽器沒有 fetch 就放棄記錄，不影響使用者
    }
  },

  // 瀏覽：同一個瀏覽器工作階段只送一次（跨頁不重複計）
  trackVisit: function () {
    try {
      if (sessionStorage.getItem('visitTracked') === 'true') return;
      sessionStorage.setItem('visitTracked', 'true');
    } catch (e) {
      // sessionStorage 不可用時就照常記錄
    }

    Analytics.send('visit');
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

  // 是否正在輸入文字
  // iOS 鍵盤彈出會改變視窗高度並觸發 resize，若此時判斷方向會誤判成橫向，
  // 導致使用者一點輸入框就跳出「請直向使用」。輸入期間一律不重新判斷。
  isTyping: function () {
    var el = document.activeElement;
    if (!el) return false;

    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
  },

  // 判斷是否為橫向
  // 刻意不用 innerWidth / innerHeight：這兩個值會被鍵盤、網址列收合、
  // 頁面縮放影響，在 iOS 上尤其不可靠。優先採用裝置方向 API。
  isLandscape: function () {
    if (!Orientation.isMobile()) return false;

    // 標準 API（iOS 16.4+ 與各版 Android 皆支援）
    var orientation = window.screen && window.screen.orientation;
    if (orientation && typeof orientation.type === 'string') {
      return orientation.type.indexOf('landscape') === 0;
    }

    // 舊版 iOS：0 / 180 為直向，±90 為橫向
    if (typeof window.orientation === 'number') {
      return Math.abs(window.orientation) === 90;
    }

    // 媒體查詢依版面視窗計算，仍比 innerHeight 穩定
    if (window.matchMedia) {
      return window.matchMedia('(orientation: landscape)').matches;
    }

    return window.innerWidth > window.innerHeight;
  },

  // 行動裝置橫向時鎖定畫面（顯示／隱藏交給 CSS 的 .landscape-locked）
  check: function () {
    if (Orientation.isTyping()) return;

    document.body.classList.toggle('landscape-locked', Orientation.isLandscape());
  },

  init: function () {
    Orientation.ensurePopup();
    Orientation.check();

    window.addEventListener('resize', Orientation.check);
    window.addEventListener('orientationchange', function () {
      // 方向變更後尺寸稍晚才更新，延遲再判斷一次
      setTimeout(Orientation.check, 100);
    });

    // 結束輸入後補判一次：避免使用者在打字期間轉了方向而沒被鎖定
    document.addEventListener('focusout', function () {
      setTimeout(Orientation.check, 100);
    });
  }
};

// ---------- 初始化 ----------
document.addEventListener('DOMContentLoaded', function () {
  Popup.init();
  Orientation.init();
  CookieConsent.show();
  Analytics.trackVisit();
});
