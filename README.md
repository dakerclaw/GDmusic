# 云音乐 — Google Drive 个人听歌站

一个手机优先的音乐网页：歌曲存在你自己的 Google Drive 里，后端用 **Google 服务账号（Service Account）** 认证读取并流式转发，手机浏览器打开即听，支持锁屏控制、进度条拖动、随机/循环播放。

## 功能

- 📱 移动端优先的沉浸式 UI（深色、毛玻璃、动态封面背景），桌面端自动双栏
- 🎵 音频流式播放，透传 `Range` 请求 —— 进度条随意拖动
- 🏷️ 自动解析 ID3 / FLAC / MP4 标签：歌名、歌手、时长、内嵌封面
- 📻 锁屏 / 通知栏控制（MediaSession API）、屏幕常亮
- 🔀 随机播放、列表循环、单曲循环
- 🔍 搜索、上次播放位置记忆、PWA 可添加到主屏幕
- 🔐 可选访问口令，仅保护设置页（听歌不需要口令）
- 🧪 未配置凭证时自动进入演示模式（本地示例曲目，先把界面跑起来）

## 快速开始

```bash
npm install
npm start          # 打开 http://localhost:9527
```

没有配置任何凭证时会进入**演示模式**，播放 `demo-music/` 里的示例曲目（可用 `scripts/make-demo-audio.py` 重新生成）。


## 服务器部署

### Linux 一键部署（推荐）

支持 Debian / Ubuntu / CentOS / Rocky / Alma 等（有 `apt` / `dnf` / `yum` 即可），需要 **root**。

```bash
# 方式一：直接跑（最短）
curl -fsSL https://raw.githubusercontent.com/dakerclaw/GDmusic/main/install.sh | bash

# 方式二：先下载再执行（更稳妥，可修改端口等参数）
curl -fsSL -o install.sh https://raw.githubusercontent.com/dakerclaw/GDmusic/main/install.sh
sudo bash install.sh
```

脚本会自动完成：

1. 安装 `git` / `curl` 和 Node.js 22（若已有 18+ 则跳过）
2. 拉取代码到 `/opt/gdmusic`（已存在则更新，**保留 `data/` 配置**）
3. 安装生产依赖（`npm ci --omit=dev`）
4. 写入并启动 systemd 服务 `gdmusic`（开机自启、异常自动重启）

完成后会打印访问地址，形如 `http://服务器IP:9527`。

**自定义参数**（可选，作为环境变量传入）：

```bash
sudo MC_PORT=9100 MC_INSTALL_DIR=/srv/gdmusic bash install.sh
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MC_PORT` | `9527` | 监听端口 |
| `MC_INSTALL_DIR` | `/opt/gdmusic` | 安装目录（`data/` 密钥与配置也在这里） |

**部署后**：浏览器打开 `http://服务器IP:9527`，点右上角 ⚙ 设置，粘贴服务账号 JSON 和音乐文件夹 ID 即可接入，无需再登录服务器。

**常用运维命令**：

```bash
systemctl status gdmusic      # 查看状态
systemctl restart gdmusic     # 重启
journalctl -u gdmusic -f      # 实时日志
curl -s localhost:9527/healthz   # 健康检查
```

**更新到最新版本**：

```bash
cd /opt/gdmusic && git pull --ff-only && systemctl restart gdmusic
```

> 配置与密钥保存在 `data/`（`config.json` 与 `keys/*.json`，权限 600），更新代码不会覆盖。
> 从旧版升级：旧版单账号配置会自动迁移为多组配置的第一组，无需手动处理。

### 其他平台

任何能跑 Node 18+ 的平台都行（VPS / 树莓派 / 云函数容器 / Docker）：

```bash
npm ci --omit=dev
PORT=9527 node server/index.js
```

数据目录可用 `DATA_DIR` 指定，默认在项目下的 `data/`。


## 接入 Google Drive（正式使用）

### 1. 创建服务账号

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，新建（或选择）一个项目
2. 启用 **Google Drive API**：API 和服务 → 库 → 搜索 "Google Drive API" → 启用
3. API 和服务 → 凭据 → 创建凭据 → **服务账号**
4. 进入该服务账号 → 密钥 → 添加密钥 → **JSON**，下载得到密钥文件

### 2. 共享音乐文件夹（关键一步）

服务账号**没有你的个人网盘权限**，必须把存音乐的文件夹共享给它：

1. 在 Google Drive 网页版找到音乐文件夹 → 右键 → 共享
2. 把服务账号的邮箱（形如 `xxx@yyy.iam.gserviceaccount.com`，在密钥 JSON 的 `client_email` 字段里）添加为 **查看者**
3. 复制文件夹链接里的 ID：`https://drive.google.com/drive/folders/`**`这一段就是ID`**

### 3. 配置并启动

在网页里配置（支持多组账号）

打开网页右上角 ⚙ 设置：每一行是一组配置（服务账号 / JSON 密钥 / 文件夹 ID），可新增、删除多组，可分别测试连通性；保存后立即生效，无需重启。


## API 一览

| 端点 | 说明 |
|---|---|
| `GET /api/tracks?refresh=1` | 曲库列表（自动解析标签，60s 缓存） |
| `GET /api/tracks/:id/meta` | 单曲详细标签 |
| `GET /api/tracks/:id/cover` | 内嵌封面图 |
| `GET /api/stream/:id?acc=<accountId>` | 音频流（支持 Range / 206） |
| `GET /api/setup/status` | 读取配置（设置口令保护） |
| `POST /api/setup` | 保存多组配置（设置口令保护） |
| `POST /api/setup/test` | 测试某组文件夹连通性（设置口令保护） |
| `POST /api/unlock` | 设置页口令验证 |
| `GET /healthz` | 健康检查 |


## 目录结构

```
├── server/
│   ├── index.js    # Express 路由、Range 流转发
│   ├── drive.js    # Google Drive API（服务账号 JWT）
│   ├── local.js    # 演示模式数据源
│   ├── meta.js     # 标签/封面解析与缓存
│   └── config.js   # 环境变量装配
├── public/         # 前端（原生 JS，无框架）
├── demo-music/     # 演示曲目
├── scripts/        # 工具脚本
└── install.sh      # Linux 一键部署脚本
```
