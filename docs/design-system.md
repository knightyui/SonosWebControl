# 样式规范

界面采用随歌曲封面变化的深色主题。内容、控件和临时面板分别维护，组件默认规则先加载，响应式和无障碍规则随后应用。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `web/public/styles/tokens.css` | 主题颜色、材质、字号、间距、圆角、触摸尺寸和动效时长 |
| `web/public/styles/base.css` | 页面基础、全局布局、字体继承和关键帧 |
| `web/public/styles/controls.css` | 按钮、图标、表单、滑轨，以及共享关闭／返回控件 |
| `web/public/styles/library.css` | 歌单、歌曲列表、筛选与最近播放 |
| `web/public/styles/player.css` | 封面、歌曲信息和完整播放区域 |
| `web/public/styles/navigation.css` | 迷你播放条、底部导航及浮动操作 |
| `web/public/styles/sheets.css` | 弹框结构及队列、歌词、定时、房间和账号面板 |
| `web/public/styles/responsive.css` | 手机布局、小宽度／小高度适配和面板拖动状态 |
| `web/public/styles/accessibility.css` | 键盘与指针状态、降低透明度、增强对比度和减少动态效果 |

`web/style-assets.mjs` 定义加载顺序。网页服务将组件源文件合并为一次 CSS 响应，无需构建工具或额外运行依赖。`web/public/style.css` 保留相同顺序的导入清单，供普通静态服务器使用。

## 设计变量

- 主题：`--page-bg`、`--page-glow`、`--surface`、`--surface-deep`、`--surface-raised` 和 `--accent`。封面配色只更新这些主题角色，不直接修改组件规则。
- 文字：`--text-primary`、`--text-secondary`、`--text-tertiary`；常用字号采用 `--type-body`、`--type-label` 和 `--type-caption`。
- 间距：`--space-1`、`--space-2`、`--space-3`、`--space-4`、`--space-5`、`--space-6` 和 `--space-8`，分别为 4、8、12、16、20、24、32px。
- 形状：`--radius-field`、`--radius-card`、`--radius-sheet` 和 `--radius-pill`；圆形控件使用 `50%`。
- 控件：`--control-hit` 为 44px，`--control-primary` 为 56px。封面采用独立的 `--artwork-mini`，避免调整触摸尺寸时意外改变图片大小。
- 动效：`--motion-fast` 用于短反馈，`--motion-sheet` 用于面板进场。减少动态效果模式统一关闭动画与过渡。

装饰图标不单独承担触摸目标；例如开关图形可以较小，其所在操作行仍提供完整点击区域。滑轨的视觉厚度与可操作区域分别设置。

## 手机导航层级

手机顶部将音乐标题、房间状态、账号和刷新操作集中为一行；账号与刷新使用图标按钮，并保留可访问名称和 44px 触摸区域。完整播放页使用独立面板，音乐列表保留迷你播放条与底部导航。搜索输入时隐藏导航，避免占用键盘上方的结果空间。

## 材质

歌曲、专辑图和列表属于内容层，保持清晰。玻璃材质用于浮动导航、播放控制和临时面板，不在每个列表行叠加模糊。

`--material-dock` 用于底部控制区，`--material-sheet` 用于文字较多的面板，`--material-reading` 表示较厚的阅读底色。边缘、阴影和背景模糊使用 `--glass-*`。提高透明度前，应同时检查明亮封面、长文字和 WebKit 下的背景重影。

降低透明度、增强对比度和不支持背景模糊时，统一使用实色材质。

## 按钮与弹框

关闭和返回按钮共用 `sheet-control` 基础类；`close`、`utility-close` 和 `panel-back` 仅区分图标形式。尺寸、圆角、颜色与焦点反馈在基础类中维护，弹框只定义控件的摆放位置。

```html
<button class="sheet-control close" type="button" aria-label="关闭">×</button>
```

键盘操作保留 `:focus-visible` 提示。弹框由触摸或鼠标打开时，使用既有的 `suppress-initial-focus` 状态控制初始焦点外观；不要给所有输入方式统一设置 `outline: none`。

手机面板共用 `sheet-dragging`、`sheet-settling`、`sheet-dismissing` 三种手势状态。尺寸适配集中在 `responsive.css`，输入框、原生选择器和音量滑轨的手势保护仍由交互代码负责。

## 修改与验证

已出现过的交互问题、根因和回归要求见 [交互回归防护](interaction-regressions.md)。样式整理应同时复核手势的即时位移和动画中间帧，不能只检查最终状态。

在所属组件或既有响应式区块中修改规则，不在样式文件末尾追加同名覆盖。同一条件下，一个选择器只保留一处定义；不同状态使用明确的类或伪类区分。WebKit 与 Firefox 的滑轨等专用伪元素必须保留为独立选择器列表，不能因声明相同而合并，否则某些浏览器会丢弃整条规则。

执行 `npm --prefix web test` 检查样式资源清单和合并响应。执行 `npm --prefix web run test:ui` 检查实际交互、共享触摸尺寸、键盘焦点、条件选择器重复及响应式布局。WebKit 引擎通过 `UI_TEST_BROWSER=webkit` 选择。

浏览器验证可设置 `UI_TEST_STYLE_SNAPSHOT=1` 导出计算样式，用于重构前后对比。截图和样式数据只使用测试夹具，输出到测试配置的临时目录。手机尺寸与 WebKit 模拟不能替代真实 iPhone Safari 的键盘、原生选择器和浏览器工具栏验证。
