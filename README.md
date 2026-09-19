# Sonos QQ 音乐控制台

在 macOS 上运行的本地网页控制台。它通过 Sonos 的局域网接口读取播放状态、控制播放，并读取 QQ 音乐“我喜欢”歌单。

![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)

## 功能

- 播放、暂停、上一首、下一首、随机播放、静音和音量控制
- 可拖动播放进度，拖动音量时即时同步到 Sonos
- QQ 音乐“我喜欢”歌单：搜索、整行点播、向下滚动自动加载更多；搜索面板点播后保持打开
- Sonos 提供的专辑封面、逐行歌词和歌词面板
- 主播放器离开视野后，顶部显示常驻控制工具栏
- QQ 音乐扫码登录；登录过期时可重新登录或导入本机浏览器 Cookie
- macOS `launchd` 开机后自动运行的配置模板

## 要求

- macOS
- Node.js 20 或更高版本
- Mac 与 Sonos 位于同一局域网
- Sonos 中已收藏 QQ 音乐“我喜欢”歌单

## 本地运行

克隆项目后，在终端执行：

```sh
cd SonosWebControl/web
SONOS_IP=你的_Sonos_IP npm start
```

默认端口是 `38473`。浏览器打开：

```text
http://localhost:38473
```

需要换端口时，在启动命令中设置 `PORT`：

```sh
SONOS_IP=你的_Sonos_IP PORT=38473 npm start
```

同一局域网的设备可使用 Mac 的局域网地址访问该端口。请只在可信局域网中使用，不要将此服务暴露到公网。

## QQ 音乐登录

在运行服务的 Mac 上打开网页，点击“登录 QQ 音乐”并扫码。登录会话只保存在本机的 `web/.qq-session.json`，该文件已被 Git 忽略，不能提交或分享。

如扫码登录暂时不可用，可在网页登录 QQ 音乐后，从浏览器请求中复制 Cookie，再通过页面中的备用入口导入。Cookie 属于登录凭据，只应保存在自己的设备上。

## 配置为开机自动运行

模板位于 [deploy/com.sonos-web.plist.example](deploy/com.sonos-web.plist.example)。复制它到 `~/Library/LaunchAgents/com.sonos-web.plist`，并替换以下占位符：

| 占位符 | 示例值 | 说明 |
| --- | --- | --- |
| `{{NODE_BIN}}` | `/opt/homebrew/bin/node` | `command -v node` 的输出 |
| `{{PROJECT_DIR}}` | `/Users/your-name/SonosWebControl` | 本项目的绝对路径 |
| `{{SONOS_IP}}` | `192.168.x.x` | Sonos 在局域网中的 IP |

加载并启动服务：

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sonos-web.plist
launchctl kickstart -k gui/$(id -u)/com.sonos-web
```

查看状态：

```sh
launchctl print gui/$(id -u)/com.sonos-web
```

停用服务：

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.sonos-web.plist
```

如果这台 Mac 之前用其他文件名或 `Label` 安装过服务，请先用旧配置的实际路径停用旧服务，再加载新模板，以免两个进程同时占用端口。修改已有部署时，也应先查看 `~/Library/LaunchAgents/` 中实际使用的 `plist`；上述命令中的名称只对应本仓库模板。删除服务时，先执行 `bootout`，再删除对应的 `plist`。升级代码时保留 `web/.qq-session.json`，否则需要重新登录 QQ 音乐。

## 项目结构

```text
web/
  public/             网页界面
  server.mjs          Sonos 与 QQ 音乐接口
  qq-session.mjs      本机 QQ 登录会话处理
  package.json        Node.js 启动脚本
deploy/
  com.sonos-web.plist.example  launchd 配置模板
```

## 上传到 GitHub 前的检查

项目根目录的 `.gitignore` 已排除登录会话、日志、环境变量文件、实际 `plist` 配置、依赖目录和 Finder 元数据。上传前可执行：

```sh
git add .
git status
```

确认暂存列表中没有 `web/.qq-session.json`、日志文件、`.env` 或包含个人路径和设备地址的实际配置文件，再提交并推送到你的 GitHub 仓库。

## 注意事项

- QQ 音乐网页接口并非公开 API，可能随服务变动而失效。
- 本项目不保存 QQ 密码或音频文件；Cookie 登录会话只保存在本机。
- 任何可访问此网页服务的人都能控制对应的 Sonos，因此不要对公网开放端口。
