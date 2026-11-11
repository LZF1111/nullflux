#!/usr/bin/env bash
# NullFlux one-line installer (Linux / macOS / WSL)
#   curl -fsSL https://raw.githubusercontent.com/LZF1111/nullflux/main/install.sh | bash
set -e
DIR="${NULLFLUX_DIR:-$HOME/nullflux}"
REPO="https://github.com/LZF1111/nullflux.git"
if ! command -v node >/dev/null 2>&1; then
	echo "需要 Node.js 18 或更高版本：https://nodejs.org/ （或 nvm install 20）"; exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then echo "Node.js 版本过低（$(node -v)），需要 >= 18"; exit 1; fi
command -v git >/dev/null 2>&1 || { echo "需要 git"; exit 1; }
if [ -d "$DIR/.git" ]; then
	echo "更新 $DIR"; git -C "$DIR" pull --ff-only
else
	echo "安装到 $DIR"; git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"
npm install --omit=dev --no-audit --no-fund
[ -f .env ] || cp .env.example .env
chmod +x start.sh
echo ""
echo "安装完成。启动：  cd $DIR && ./start.sh"
echo "然后浏览器打开 http://127.0.0.1:5174 ，在「设置」里填写模型接口（任意 OpenAI 兼容接口）。"
