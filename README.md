# Sonos QQ 音乐控制台

在 macOS 上运行的本地网页控制台。它通过 Sonos 的局域网接口读取播放状态、控制播放，并读取 QQ 音乐“我喜欢”歌单。

![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)

## 功能

- 播放、暂停、上一首、下一首、随机播放、单曲循环、整队循环、淡入淡出、静音和音量控制；循环模式可与随机播放组合
- 播放进度每秒更新，并定期向 Sonos 校准；可拖动进度，拖动音量时即时同步到 Sonos
- 播放、暂停、切歌、歌单点播和队列点播采用统一状态同步：界面先即时反馈，再等待 Sonos 连续稳定回报，避免过渡状态显示为暂停或 0:00
- 查看 Sonos 当前播放队列，按正在播放的位置定位、翻页、点播，以及逐首上移、下移或移除
- 歌单及搜索结果可将歌曲设为下一首，或加入队列末尾
- 选择 Sonos 房间、组合或拆分房间，调节单个房间及分组音量
- 睡眠定时：设置多少分钟后停止，或在指定时间停止；定时保存在 Sonos 中，关闭网页后仍然有效
- QQ 音乐“我喜欢”歌单：搜索、整行点播、向下滚动自动加载更多；搜索面板点播后保持打开
- 专辑封面、逐行歌词和歌词面板；Sonos 队列缺少歌曲信息时，用 QQ 歌单补全标题、歌手、时长与封面
- 主播放器离开视野后，顶部显示常驻控制工具栏
- QQ 音乐扫码登录；登录过期时可重新登录或导入本机浏览器 Cookie
- macOS `launchd` 开机后自动运行的配置模板

## 最近更新

- 播放器改为从封面提取主色并应用到全页渐变；补全封面与逐行歌词展示
- 重新设计桌面与移动端播放控制，使用一致的图标、按压反馈和焦点处理；修复 iOS Safari 的残留高亮
- 将播放队列、睡眠定时、整队循环、淡入淡出和房间分组加入界面；不常用控制收进“更多控制”菜单
- 搜索、歌词、队列和操作菜单均支持点击遮罩关闭，并适配 iPhone Safari 的可视区域和底部安全区域
- 歌单支持自动加载更多、悬浮搜索和回到顶部；队列支持分页、点播和逐首调整
- 服务端增加队列、睡眠定时、房间拓扑和播放模式接口，并在 Sonos 缺少元数据时补全 QQ 音乐的歌曲信息
- 统一播放状态同步，覆盖播放、暂停、切歌、歌单点播、队列点播和进度拖动，避免 Sonos 过渡状态造成图标或进度滞后

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

## 播放队列与更多控制

在播放器中点击“播放队列”可查看 Sonos 当前队列；默认定位到正在播放歌曲所在页。点击队列中的歌曲即可播放，前后翻页可浏览长队列。

每首歌右侧的“···”可将歌单歌曲加入下一首或队列末尾，也可调整队列中曲目的顺序或移除曲目。随机播放由 Sonos 管理，开启时队列的显示次序可能随设备重新排序；如果队列在操作间发生变化，页面会要求刷新，避免按过期位置操作其他歌曲。

“整队循环”与“淡入淡出”由 Sonos 保存。点击“房间”可切换当前控制的房间，并将其他独立房间加入当前分组或移出分组；分组音量仅在发现多个房间且处于同组时出现。房间发现依赖同一 Sonos 家庭的拓扑信息。当前开发环境只发现一个房间，因此多房间分组操作尚需在有多台 Sonos 的环境验证。

主播放器只保留“播放队列”和“更多控制”。睡眠定时、整队循环、淡入淡出和房间控制收在“更多控制”菜单里。所有弹窗均可点击遮罩关闭；搜索弹窗会跟随 iPhone Safari 键盘打开后的可视区域定位，避免被键盘遮挡。

点击“睡眠定时”可输入分钟数，或选择本机浏览器时间中的停止时刻。若所选时刻今天已过，则使用明天的同一时刻。页面可显示 Sonos 当前定时和剩余时间，也可取消定时。

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
