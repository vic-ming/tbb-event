#!/bin/sh
# 在主機上建置並啟動 API 容器
#   使用方式：ssh 進主機後執行 ~/tbb-event/run-api.sh
#
# 主機沒有 docker compose plugin（套件庫也沒有），所以用純 docker 指令，
# 與現有 nginx 容器的啟動方式一致，不需要在客戶主機安裝任何額外套件。
#
# 這支腳本只動 tbb-api 容器與 tbb-net 網路，不會碰到既有的 nginx 容器。

set -eu

APP_DIR="$HOME/tbb-event"
IMAGE="tbb-event-api:latest"
CONTAINER="tbb-api"
NETWORK="tbb-net"

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "找不到 $APP_DIR/.env（需含 REDEEM_PASSWORD 與 STATS_PASSWORD）" >&2
  exit 1
fi

echo "==> 建置映像"
docker build -t "$IMAGE" ./server

echo "==> 確認網路 $NETWORK"
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK"

echo "==> 重建容器"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

mkdir -p "$APP_DIR/data"

docker run -d \
  --name "$CONTAINER" \
  --restart always \
  --network "$NETWORK" \
  --env-file "$APP_DIR/.env" \
  -e DB_PATH=/data/stats.db \
  -e TZ=Asia/Taipei \
  -v "$APP_DIR/data:/data" \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  "$IMAGE"

echo "==> 把既有 nginx 容器接上同一個網路（已接上則略過，不會重啟 nginx）"
docker network connect "$NETWORK" nginx 2>/dev/null && echo "   已連接" || echo "   先前已連接"

echo "==> 狀態"
docker ps --filter "name=$CONTAINER" --format "table {{.Names}}\t{{.Status}}"
