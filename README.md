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

```bash
cp .env.example .env
```

编辑 `.env`（三种凭证方式任选其一，推荐 Base64 避免换行转义问题）：

```ini
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=<密钥JSON的base64>
# 生成方法：certutil -encode service-account.json out.txt  取中间段
# 或 PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))
DRIVE_FOLDER_ID=<文件夹ID>
# 可选：设置页访问口令（只锁设置，不影响听歌）
ACCESS_CODE=你的口令
```

重启 `npm start`，看到 `运行模式：Google Drive` 即成功。

### 在网页里配置（推荐，支持多组账号）

打开网页右上角 ⚙ 设置：每一行是一组配置（服务账号 / JSON 密钥 / 文件夹 ID），可新增、删除多组，可分别测试连通性；保存后立即生效，无需重启。旧版的 `data/config.json` + `keys/sa.json` 会自动迁移成第一组。

> 💡 Windows 下把密钥转 Base64：
> ```powershell
> [Convert]::ToBase64String([IO.File]::ReadAllBytes("D:\path\service-account.json")) | Set-Clipboard
> ```

## 手机上用

手机和电脑连同一个 Wi-Fi，浏览器打开启动时打印的局域网地址（如 `http://192.168.1.5:9527`）。Safari / Chrome 里「添加到主屏幕」后就是一个全屏 App。注意手机浏览器要求 `localhost` 之外必须 HTTPS 才允许自动播放 —— 首次点一下播放按钮即可。

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

## 部署

任何能跑 Node 18+ 的平台都行（VPS / 树莓派 / 云函数容器）。把三个环境变量带上去即可，密钥不要提交进 git（`.env` 已在 `.gitignore`）。

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
└── scripts/        # 工具脚本
```
