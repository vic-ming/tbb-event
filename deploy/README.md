# 部署說明

活動網站與 API 都跑在客戶提供的 AWS 測試主機上。

| 項目 | 內容 |
|---|---|
| 網址 | https://ccu-healthyage.com/ |
| 主機 | 18.180.235.133（AWS Tokyo，Amazon Linux 2023，**aarch64/Graviton**） |
| 連線 | `ssh -i ~/.ssh/ccuhealthyage.pem ec2-user@18.180.235.133` |
| 規格 | RAM 1.8G、磁碟 20G |

主機上**沒有**安裝 nginx / node / php，一切都在 Docker 裡。
也沒有 `docker compose` plugin（套件庫查無此套件），所以用純 `docker` 指令。

---

## 架構

```
瀏覽器
  │  https://ccu-healthyage.com
  ▼
nginx 容器 (nginx:alpine)          ← 既有容器，本專案「不重建」它
  ├── /            靜態網站        → ~/nginx/html/
  ├── /scan/N      302 轉址        → /event-N.html
  └── /api/        反向代理        → tbb-api:3000
                                        │
                                   tbb-api 容器 (Node 24)
                                        └── SQLite → ~/tbb-event/data/stats.db
```

兩個容器透過 user-defined 網路 `tbb-net` 互通。
nginx 是用 `docker network connect` **即時**加入該網路的，過程中沒有重啟，
現有服務不中斷。

### 為什麼不用 docker-compose 管 nginx

nginx 容器是主機上的既有服務。若把它納入 compose，`compose up` 會依 compose
的定義把它**重建**，造成站台中斷、且原本的掛載與參數可能對不上。
因此 compose 檔（`docker-compose.yml`）只描述 API 一個服務，
實際部署則用 `run-api.sh`。

---

## 主機目錄

```
~/tbb-event/
├── server/              後端程式（server.js / Dockerfile / package.json）
├── data/stats.db        SQLite 資料庫 ← 唯一需要備份的東西
├── .env                 密碼（權限 600，不進版控）
├── docker-compose.yml   參考用；主機無 compose plugin
└── run-api.sh           實際部署腳本

~/nginx/
├── html/                        網站根目錄（掛進 nginx 容器）
├── html-backup-20260722/        部署前的原始佔位頁備份
├── conf.d/ccu-healthyage.conf   nginx 設定
└── conf.d.bak-ccu-healthyage-20260722   舊設定備份

~/certbot/               Let's Encrypt 憑證
```

---

## 更新流程

以下指令都在**本機專案目錄**執行。

### 更新靜態網站

```sh
# 只上傳網頁與資源，不要把 server/、deploy/、*.pem 傳進網站目錄
rsync -az --delete \
  -e "ssh -i ./ccuhealthyage.pem" \
  ./assets ./*.html \
  ec2-user@18.180.235.133:~/nginx/html/
```

靜態檔改完即時生效，不必重啟任何容器。

### 更新後端

```sh
rsync -az -e "ssh -i ./ccuhealthyage.pem" \
  ./server/ ec2-user@18.180.235.133:~/tbb-event/server/

ssh -i ./ccuhealthyage.pem ec2-user@18.180.235.133 '~/tbb-event/run-api.sh'
```

`run-api.sh` 會重新 build 並換掉 `tbb-api` 容器，**不會動到 nginx**。
SQLite 在主機的 volume 上，容器重建不會遺失資料。

### 更新 nginx 設定

一定要先驗證再 reload，否則設定寫錯會讓整個站台掛掉：

```sh
scp -i ./ccuhealthyage.pem ./deploy/nginx/ccu-healthyage.conf \
  ec2-user@18.180.235.133:~/nginx/conf.d/ccu-healthyage.conf

ssh -i ./ccuhealthyage.pem ec2-user@18.180.235.133 '
  docker exec nginx nginx -t && docker exec nginx nginx -s reload'
```

### 改密碼

```sh
ssh -i ./ccuhealthyage.pem ec2-user@18.180.235.133
vi ~/tbb-event/.env      # 改 REDEEM_PASSWORD 或 STATS_PASSWORD
docker restart tbb-api
```

---

## 資料備份與還原

活動期間建議每天備份一次：

```sh
# 備份（SQLite 為 WAL 模式，用 .backup 才能取得一致快照）
ssh -i ./ccuhealthyage.pem ec2-user@18.180.235.133 \
  'docker exec tbb-api node -e "
     const {DatabaseSync}=require(\"node:sqlite\");
     const db=new DatabaseSync(\"/data/stats.db\");
     db.exec(\"VACUUM INTO \x27/data/backup.db\x27\"); db.close();"'

scp -i ./ccuhealthyage.pem \
  ec2-user@18.180.235.133:~/tbb-event/data/backup.db ./backup-$(date +%Y%m%d).db
```

還原就是把備份檔覆蓋回 `~/tbb-event/data/stats.db` 後 `docker restart tbb-api`。

---

## 回復（rollback）

| 要回復什麼 | 做法 |
|---|---|
| nginx 設定 | `cp ~/nginx/conf.d.bak-ccu-healthyage-20260722 ~/nginx/conf.d/ccu-healthyage.conf` 後驗證並 reload |
| 網站內容 | 原佔位頁在 `~/nginx/html-backup-20260722/` |
| 整個 API | `docker rm -f tbb-api`；網站仍可運作，但統計與兌獎會失效 |

---

## 現場運作風險（請先讓客戶知道）

### 1. 密碼限流以 IP 計算，可能整場一起被鎖

兌獎密碼只有 4 位數（10000 種組合），沒有限流就能在幾秒內被暴力破解，
因此後端設了「**同一 IP 連續錯 10 次 → 鎖 15 分鐘**」。

風險是：**如果現場所有人都連同一個 Wi-Fi，對外就是同一個 IP。**
只要累計輸錯 10 次，整個場地 15 分鐘內都無法兌獎（連正確密碼也會被擋）。

目前設定在 `server/server.js`：

```js
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
```

三個可行方向，看現場狀況擇一：

- **參觀者用自己的行動網路**（各自不同 IP）→ 現行設定沒問題，維持即可
- **現場統一 Wi-Fi** → 把 `MAX_FAILURES` 調高到 50 左右，仍可擋暴力破解
  （50 次/15 分 ≈ 200 次/小時，試完 10000 組要 50 小時），但不會誤鎖現場
- **改長密碼**（例如 8 碼英數）→ 組合數大幅提高，限流就不必那麼嚴格

### 2. 憑證沒有自動續期

主機上**沒有** certbot 的 cron 或 systemd timer，Let's Encrypt 憑證 90 天到期後
不會自動更新，屆時整站會出現憑證錯誤。這是接手前就存在的問題，與本次部署無關，
但建議在活動前補上自動續期，或至少確認活動期間憑證不會過期。

### 3. 兌獎數字的意義

`/api/redeem` 驗證成功的當下就記錄，所以「兌獎人次」代表
**現場人員確實輸入過正確密碼**，比先前純前端的數字可信得多。
但仍不等於實際發出的獎品數（輸入密碼後才發生的事，系統看不到）。
