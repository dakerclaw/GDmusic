#!/bin/bash
# GDmusic — 一键安装（零交互）
#
# 安装完成后即为演示模式，打开网页右上角「设置」即可连接 Google Drive：
#   - 粘贴 Service Account JSON 与音乐文件夹 ID，保存后立即生效（无需重启）
#
# 可选环境变量：
#   MC_PORT=8080            监听端口
#   MC_INSTALL_DIR=/opt/gdmusic
set -euo pipefail

REPO_URL="https://github.com/dakerclaw/GDmusic.git"
INSTALL_DIR="${MC_INSTALL_DIR:-/opt/gdmusic}"
SERVICE_NAME="gdmusic"
PORT="${MC_PORT:-8080}"
NODE_MIN=18

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${GREEN}[✔]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✘]${NC} $*" >&2; exit 1; }
section() { echo -e "\n${CYAN}${BOLD}── $* ──${NC}"; }

[ "$(id -u)" -eq 0 ] || error "请用 root 权限运行：bash install.sh"

echo ""
echo -e "${CYAN}${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}│  GDmusic · 安装（网页设置连接网盘）  │${NC}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════╝${NC}"

# ── 1. 系统依赖 ──────────────────────────────────────────────────────────
section "步骤 1/4  安装系统依赖"
if command -v apt-get &>/dev/null; then PKG=apt-get
elif command -v dnf &>/dev/null; then PKG=dnf
elif command -v yum &>/dev/null; then PKG=yum
else error "不支持此系统（需要 apt / dnf / yum）"; fi

for dep in git curl; do
  if ! command -v "$dep" &>/dev/null; then
    info "安装 $dep…"
    $PKG install -y "$dep"
  else
    info "$dep 已安装"
  fi
done

install_node() {
  info "安装 Node.js 22.x…"
  if [ "$PKG" = "apt-get" ]; then
    curl -fsSL "https://deb.nodesource.com/setup_22.x" | bash -
    apt-get install -y nodejs
  else
    curl -fsSL "https://rpm.nodesource.com/setup_22.x" | bash -
    $PKG install -y nodejs
  fi
}
if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
  if [ "$NODE_VER" -lt "$NODE_MIN" ]; then install_node; else info "Node.js $(node -v) 可用"; fi
else
  install_node
fi

# ── 2. 获取代码 ───────────────────────────────────────────────────────────
section "步骤 2/4  获取代码"
if [ -d "$INSTALL_DIR/.git" ]; then
  info "检测到已有安装，更新代码（保留 data/）"
  cd "$INSTALL_DIR"
  git fetch origin --prune
  git reset --hard origin/main
else
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
chown -R root:root "$INSTALL_DIR" 2>/dev/null || true

# ── 3. 安装依赖 ───────────────────────────────────────────────────────────
section "步骤 3/4  安装依赖"
npm ci --omit=dev
info "依赖安装完成"

# ── 4. systemd 服务 ──────────────────────────────────────────────────────
section "步骤 4/4  配置 systemd 服务"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=GDmusic - Google Drive cloud music player
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(command -v node) ${INSTALL_DIR}/server/index.js
Environment=PORT=${PORT}
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=3

# 安全加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${INSTALL_DIR}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1
systemctl restart "${SERVICE_NAME}"
sleep 1
if systemctl is-active --quiet "${SERVICE_NAME}"; then
  info "服务已启动：systemctl status ${SERVICE_NAME}"
else
  warn "服务未正常运行，查看日志：journalctl -u ${SERVICE_NAME} -n 50"
fi

IP=$(curl -fss --max-time 4 https://api.ipify.org 2>/dev/null || echo "<服务器IP>")
echo ""
echo -e "${GREEN}${BOLD}──────────────────────────────────────────${NC}"
echo -e "${GREEN} ✔ 安装完成！${NC}"
echo ""
echo -e "  访问地址： ${BOLD}http://${IP}:${PORT}${NC}"
echo ""
echo -e "  下一步（网页里完成，无需登录服务器）："
echo -e "   1. 打开网页，点右上角 ⚙ 设置"
echo -e "   2. 粘贴服务账号 JSON 与音乐文件夹 ID"
echo -e "   3. 点「测试文件夹」确认，再「保存并连接」"
echo -e "  常用命令："
echo -e "   systemctl restart ${SERVICE_NAME}   # 重启"
echo -e "   journalctl -u ${SERVICE_NAME} -f    # 日志"
echo -e "${GREEN}${BOLD}──────────────────────────────────────────${NC}"
