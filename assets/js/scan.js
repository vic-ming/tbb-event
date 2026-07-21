/* ============================================================
   掃描集章頁
   由 event-N.html 以 scan.html?event=N 開啟
   掃到 SCAN_URL_PREFIX + 編號 才算集章成功
   ============================================================ */

var scanVideo = null;
var scanCanvas = null;
var scanContext = null;
var scanStream = null;
var scanDetector = null;   // 原生 BarcodeDetector（若瀏覽器支援）
var scanning = false;

// 從網址取得使用者是從哪一關進來的（掃到別關的 QR 一樣算數，只影響返回頁）
function currentEventId() {
  var id = parseInt(new URLSearchParams(window.location.search).get('event'), 10);
  return EVENTS[id] ? id : 1;
}

function startCamera() {
  scanVideo = document.getElementById('scanVideo');
  scanCanvas = document.getElementById('scanCanvas');
  scanContext = scanCanvas.getContext('2d', { willReadFrequently: true });

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showScanError('此瀏覽器不支援相機，請改用 Chrome 或 Safari 開啟。');
    return;
  }

  navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false
  })
    .then(function (stream) {
      scanStream = stream;
      scanVideo.srcObject = stream;
      scanVideo.setAttribute('playsinline', 'true'); // iOS 不要自動全螢幕播放
      return scanVideo.play();
    })
    .then(function () {
      hideScanMessage();
      scanning = true;
      prepareDetector();
      requestAnimationFrame(scanFrame);
    })
    .catch(function (error) {
      // 使用者拒絕授權，或裝置沒有可用的相機
      if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
        showScanError('請允許使用相機權限，才能掃描集章 QR code。');
      } else if (error && error.name === 'NotFoundError') {
        showScanError('找不到可用的相機。');
      } else {
        showScanError('無法開啟相機，請確認以 HTTPS 開啟本頁後再試一次。');
      }
    });
}

// 有原生 BarcodeDetector 就優先使用（效能較好），否則退回 jsQR
function prepareDetector() {
  if (typeof BarcodeDetector === 'undefined') return;

  try {
    scanDetector = new BarcodeDetector({ formats: ['qr_code'] });
  } catch (e) {
    scanDetector = null;
  }
}

// 逐格擷取畫面並嘗試解碼
function scanFrame() {
  if (!scanning) return;

  if (scanVideo.readyState !== scanVideo.HAVE_ENOUGH_DATA) {
    requestAnimationFrame(scanFrame);
    return;
  }

  if (scanDetector) {
    scanDetector.detect(scanVideo)
      .then(function (codes) {
        if (codes && codes.length) {
          handleScanResult(codes[0].rawValue);
        } else if (scanning) {
          requestAnimationFrame(scanFrame);
        }
      })
      .catch(function () {
        // 原生解碼失敗就改用 jsQR，不再重試 BarcodeDetector
        scanDetector = null;
        if (scanning) requestAnimationFrame(scanFrame);
      });
    return;
  }

  scanCanvas.width = scanVideo.videoWidth;
  scanCanvas.height = scanVideo.videoHeight;
  scanContext.drawImage(scanVideo, 0, 0, scanCanvas.width, scanCanvas.height);

  var image = scanContext.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
  var code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });

  if (code) {
    handleScanResult(code.data);
    return;
  }

  requestAnimationFrame(scanFrame);
}

// 決定掃到這段內容後要做什麼（與畫面無關，方便單獨驗證）
// 回傳 null 表示不是活動 QR code；否則回傳要前往的關卡頁網址
function resolveScanTarget(text) {
  var eventId = parseScanResult(text);
  if (!eventId) return null;

  // 已兌換過就不再累積集章，只帶回關卡頁
  if (Progress.redeemed()) {
    return 'event-' + eventId + '.html';
  }

  // QR code 貼在攤位上，掃到哪一關就集哪一關的章
  var isNew = Stamps.collect(eventId);
  return 'event-' + eventId + '.html?stamp=' + (isNew ? 'new' : 'repeat');
}

// 解碼成功後的處理
function handleScanResult(text) {
  var target = resolveScanTarget(text);

  // 不是活動 QR code：提示後繼續掃描
  if (!target) {
    pauseScan();
    Popup.show('nonActivityPopup');
    return;
  }

  stopCamera();
  window.location.href = target;
}

// 暫停解碼（提示彈窗期間不繼續讀取畫面）
function pauseScan() {
  scanning = false;
}

// 關閉提示後繼續掃描
function resumeScan() {
  Popup.close();

  if (scanning || !scanStream) return;
  scanning = true;
  requestAnimationFrame(scanFrame);
}

function stopCamera() {
  scanning = false;

  if (scanStream) {
    scanStream.getTracks().forEach(function (track) { track.stop(); });
    scanStream = null;
  }
}

function showScanError(message) {
  var box = document.getElementById('scanMessage');
  if (box) {
    box.textContent = message;
    box.style.display = 'block';
  }

  var frame = document.getElementById('scanFrame');
  if (frame) frame.style.display = 'none';
}

function hideScanMessage() {
  var box = document.getElementById('scanMessage');
  if (box) box.style.display = 'none';
}

// 返回原本的關卡頁
function backToEvent() {
  stopCamera();
  window.location.href = 'event-' + currentEventId() + '.html';
}

// 離開頁面時務必關掉相機
window.addEventListener('pagehide', stopCamera);

document.addEventListener('DOMContentLoaded', startCamera);
