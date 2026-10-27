#!/usr/bin/env bash
# Debian / Ubuntu 系のLinuxサーバー用インストーラ（root で実行）
#   sudo ./linux/install-linux.sh
# fnf-playground フォルダの中身を /opt/haxe-fnf に配置して、systemdで常駐させる。
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "root で実行してください (sudo)"; exit 1; fi

HAXE_VERSION="${HAXE_VERSION:-4.3.6}"
APP_DIR=/opt/haxe-fnf
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "== 1/5 パッケージ =="
apt-get update
apt-get install -y --no-install-recommends \
  git curl ca-certificates unzip tar nodejs npm neko build-essential

echo "== 2/5 Haxe ${HAXE_VERSION} =="
if ! /opt/haxe/haxe -version 2>/dev/null | grep -q "^${HAXE_VERSION}"; then
  rm -rf /opt/haxe && mkdir -p /opt/haxe
  curl -fL "https://github.com/HaxeFoundation/haxe/releases/download/${HAXE_VERSION}/haxe-${HAXE_VERSION}-linux64.tar.gz" \
    | tar xz --strip-components=1 -C /opt/haxe
fi
ln -sf /opt/haxe/haxe /usr/local/bin/haxe
ln -sf /opt/haxe/haxelib /usr/local/bin/haxelib
echo 'export HAXE_STD_PATH=/opt/haxe/std' > /etc/profile.d/haxe.sh
export HAXE_STD_PATH=/opt/haxe/std
haxe -version

echo "== 3/5 ユーザーと配置 =="
id fnf >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin fnf
mkdir -p "$APP_DIR"
cp "$SRC_DIR/server.js" "$SRC_DIR/package.json" "$SRC_DIR/setup-fnf.sh" "$APP_DIR/"
chown -R fnf:fnf "$APP_DIR"
sudo -u fnf -H bash -c "cd $APP_DIR && npm install --omit=dev"

echo "== 4/5 Psych Engine のセットアップ（時間がかかります） =="
sudo -u fnf -H env HAXE_STD_PATH=/opt/haxe/std bash "$APP_DIR/setup-fnf.sh"

echo "== 5/5 systemd =="
ENV_FILE=/etc/haxe-fnf.env
if [ ! -f "$ENV_FILE" ]; then
  TOKEN="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  cat > "$ENV_FILE" <<ENV
PORT=8080
API_TOKEN=${TOKEN}
FNF_DIR=${APP_DIR}/fnf
BUILD_CMD=haxelib run lime build html5 -release
HAXE_STD_PATH=/opt/haxe/std
ENV
  chmod 600 "$ENV_FILE"
  echo "API_TOKEN を生成しました: ${TOKEN}  （Swiftアプリに入力します。${ENV_FILE} にも保存済み）"
fi
cp "$SRC_DIR/linux/haxe-fnf.service" /etc/systemd/system/haxe-fnf.service
systemctl daemon-reload
systemctl enable --now haxe-fnf
systemctl --no-pager status haxe-fnf | head -5
echo "完了: curl http://localhost:8080/ で確認できます"
