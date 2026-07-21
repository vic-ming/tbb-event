/* ============================================================
   關卡內頁（event-1 ~ event-4）共用邏輯
   各頁只需在 </body> 前呼叫 initEventDetail(關卡編號)
   ============================================================ */

var currentEventId = null;

function initEventDetail(eventId) {
  currentEventId = eventId;

  var event = EVENTS[eventId];
  if (!event) return;

  // 關卡名稱與印章色系都由 app.js 的 EVENTS 設定帶入
  var title = document.getElementById('eventTitle');
  if (title) title.textContent = event.title;

  var subtitle = document.getElementById('stampSubtitle');
  if (subtitle) subtitle.classList.add(event.color);

  // 已集章時內頁圖片換成 -collected，未集章維持 -collect
  if (Stamps.has(eventId)) {
    showCollectedImage();
  }

  checkReturnFromScan();
}

// 從掃描頁導回時（event-N.html?stamp=new|repeat），跳出對應的印章彈窗
function checkReturnFromScan() {
  var params = new URLSearchParams(window.location.search);
  var stamp = params.get('stamp');
  if (stamp !== 'new' && stamp !== 'repeat') return;

  // 清掉 query，避免重新整理又跳出彈窗
  window.history.replaceState({}, '', window.location.pathname);

  showStampPopup(stamp === 'repeat');
}

function showCollectedImage() {
  var img = document.getElementById('eventImage');
  if (img) img.src = './assets/images/event-' + currentEventId + '-collected.png';
}

// 前往掃描頁；實際集章由掃描到的 QR code 決定（見 scan.js）
function startScan() {
  window.location.href = 'scan.html?event=' + currentEventId;
}

// 顯示獲得印章彈窗
function showStampPopup(alreadyCollected) {
  var title = document.getElementById('stampPopupTitle');
  if (title) title.textContent = alreadyCollected ? '本印章已蒐集' : '獲得新印章';

  var stampImage = document.getElementById('collectedStampImage');
  if (stampImage) stampImage.src = './assets/images/event-' + currentEventId + '-collected.png';

  var subtitle = document.getElementById('stampSubtitle');
  if (subtitle) subtitle.textContent = EVENTS[currentEventId].title;

  Popup.show('stampCollectedPopup');
}

function backToEventList() {
  window.location.href = 'event-list.html';
}
