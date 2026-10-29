# dsh-computer-use

给 DSH 提供 Codex 风格的 **computer use**：让 agent 看见 Windows 桌面、并用鼠标键盘操作图形界面。

注册一个 `computer` 工具（截图 + 鼠标 + 键盘）、一段系统提示词，并占用宿主的 computer-use provider 槽位。
适用场景是**没有命令行或文件路径可走的图形目标**——操作 GUI 应用、点界面上的按钮、填写非脚本化的表单。

## 当前形态（v2：两件套）

> 下面「工具：`computer`」一节是 v1 的单工具形态，保留是因为其中的**实测结论**
> （PrintWindow 边界、Chromium 渲染子窗口、焦点等待、坐标换算链）仍然全部适用。
> 插件当前注册的是两个工具。

**`computer_observe`** —— 只读，永不动光标：

| 参数 | 说明 |
| --- | --- |
| `target: "windows"` | 列出可操作的顶层窗口（handle/title/kind/rect/minimized） |
| `target: "<handle>"` | 用 PrintWindow 抓该窗口；可加 `tree:true` 附带可访问性树 |
| 省略 `target` | 抓屏幕，可用 `region` 限定矩形 |
| `tree` | 带回 UIA 控制树（缩进文本、`[eN]` 节点 id、节点/深度上限），并建立 `snapshot` |

**`computer_act`** —— 会改变机器，受当前输入模式约束：

| 动作 | 说明 |
| --- | --- |
| `click / double_click / right_click / middle_click` | 坐标点击；带 `element` 时改走 Invoke |
| `type / press / hold` | 文本与组合键；带 `element` 时改走 Value.SetValue |
| `toggle / select` | 仅元素级（Toggle / SelectionItem pattern） |
| `move / drag / scroll / wait` | 光标、拖拽、滚轮、等待 |

输入模式三态：`window`（默认，必须带 `target`）、`foreground`（真实鼠标键盘）、
`both`。模式由**用户在界面上**决定，模型不能自己切换：

- 设置页：Settings → Computer Use（模式、是否允许模拟输入、当前状态）
- 输入框左侧的紧凑切换按钮：不翻设置页也能换
- HTTP 面：`GET/POST /dsh-computer-use/state`（同源校验）

**元素级动作与快照失效**：`tree:true` 观察后返回 `snapshot: "s1"` 与 `[e12]` 形式的节点 id。
动作前会比对控件类型、名字与包围盒；任一变化即报 `stale` 并要求重新观察——
不会照着旧快照再点一次。快照最多保留 3 份、5 分钟过期，淘汰与卸载都会释放 COM 引用。

## 安装

本插件是标准的 DSH bundle 插件，`package.json` 声明了 `dsh.bundle.patch`。

```bash
# 从 npm 安装：tarball 里已经带好 lib/（发布时 prepare 构建过）
# 从 GitHub 安装：包管理器会先装 devDependencies，再由 prepare 构建出 lib/
dsh plugin --profile <profile> add dsh-computer-use
```

从本地源码目录安装时用仓内的安装脚本，**不要用 `link:`**：

```bash
node scripts/install-local.mjs     # 只复制 package.json files 声明的可发布文件
```

`link:` 会把源码目录整体交给生产解析，而本仓库 node_modules 下有测试替身（见
「开发 / 测试」）：假 `koffi` 会让动作打在一个虚构的桌面上，假 `defineTool` 会让插件
的 fiberPhase 停在 `failed` 而宿主不报错。这条弯路已经踩过一次。
`install-local.mjs` 因此既只复制可发布文件，还要在安装后自检目标位置没有 node_modules。

安装后 profile 的 `cordis.patch.yml` 会多出一行插入项；逐会话配置写在同一文件里覆盖它：

```yaml
- id: computer-use
  config:
    allowInput: false      # 只允许看，不允许动
    maxDimension: 1280
```

### 运行前提

- **Windows**。当前只实现了 Win32 后端；其它平台会得到明确的运行时诊断而不是崩溃。
- **原生依赖 `koffi`**（声明在 `dependencies`，安装时自动获取）。
  它只在第一次真正执行动作时加载，因此原生模块缺失不会拖垮宿主启动，只会让工具调用返回一条可读错误。
- **宿主包由 DSH 运行时提供**：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-attachment`、
  `@deepseek-ai/dsh-tools` 声明在 `peerDependencies` 里，并标为 **optional peer**
  （`peerDependenciesMeta`）。标 optional 有两个原因：这些包不该由包管理器从 registry
  抓进项目（运行时由宿主解析；profile 里也不该出现第二份宿主包），而且 npm 11 在自动
  安装这几个 peer 时会崩在自己的 arborist 里（`Cannot read properties of null`）。
  这与其它 DSH 插件的做法一致。
- **模型需支持图像输入**，否则 `screenshot` 会被拒绝——截图的意义就是给模型看。
  插件会解析当前会话实际路由到的 provider/model，并要求它显式声明 `image` 输入能力。

**不需要**宿主的 computer-use 服务。`computerUse` 只是"可选的 provider 槽位"，
很多组合（包括本机安装）根本没有挂载它——它只以服务契约的形式出现在 Inspect
目录里，没有任何实现。插件因此把它当作可选：**有则占用，无则照常注册工具**。
这一点曾经写错过：把 `computerUse` 放进 `inject` 会让插件的 fiber 永远停在
`pending`，宿主不报错，而模型侧完全看不到 `computer` 工具。

## 工具：`computer`

单一工具 + `action` 判别式，形状对齐现行 Codex / Anthropic 的 computer use。

| action | 说明 |
| --- | --- |
| `screenshot` | 截取桌面（可用 `region` 限定范围），以图像返回给模型 |
| `cursor_position` | 读取光标坐标 |
| `mouse_move` | 移动光标到 `x, y` |
| `left_click` / `right_click` / `middle_click` | 点击；省略坐标则在原地点击 |
| `double_click` / `triple_click` | 连击 |
| `left_click_drag` | 从 `start_x, start_y` 拖到 `x, y`（或 `end_x, end_y`） |
| `scroll` | `scroll_direction`（up/down/left/right）+ `scroll_amount`（格数） |
| `type` | 注入文本，走 Unicode 通道，中文/emoji/重音字母都能如实送达 |
| `key` | 按一次组合键，如 `Return`、`ctrl+c`、`alt+Tab`、`F5` |
| `hold_key` | 按住组合键 `duration_ms` 毫秒后松开 |
| `wait` | 等待 `duration_ms` 毫秒 |

### 坐标空间

**只有一种坐标空间：物理屏幕像素。** 截图上的像素就是鼠标动作接受的像素，模型不需要换算。
截图被缩小时，返回的文本外壳会给出确定的换算公式（`screen_x = <region.x> + image_x / <scale>`），
而不是让模型自己估。

### 结果里为什么带 `target`

每个动作都会返回**它实际作用到了哪个窗口**（窗口标题、类名、进程 id、矩形）。这不是装饰：
焦点错位是 GUI 自动化最常见的失败，把接收者如实报出来，模型才有依据判断
"我以为点在记事本上，其实点到了别处"，而不是盲目重试。

键盘动作报告的是**持有焦点的控件**（`GetGUIThreadInfo.hwndFocus`），它才是按键真正的投递目标。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后不注册工具与提示词 |
| `allowInput` | `true` | 设为 `false` 时插件退化为"只能看"（仅 `screenshot` / `cursor_position` / `wait`） |
| `allowForegroundInput` | `false` | 设为 `true` 才允许前台模式的输入：不带 `target` 的输入动作用 `SendInput` 注入真实事件，会移动用户的光标、抢走焦点。默认关闭，因为后台模式已能覆盖大部分场景 |
| `typingChunkSize` | `8` | 每个 `SendInput` 承载的 UTF-16 单元数（至少 2） |
| `typingChunkDelayMs` | `12` | 批次之间的让出毫秒数；**低于 12 会显著提高丢字概率** |
| `settleMs` | `400` | 键盘注入前等待焦点控件就绪的上限 |
| `doubleClickIntervalMs` | `60` | 连击间隔，需落在系统双击判定窗口内 |
| `warmupInjection` | `true` | 是否在键盘注入前先送一对无害的"牺牲"按键（见下文） |
| `dragSteps` | `12` | 拖拽时插入的中间移动步数 |
| `maxWaitMs` | `10000` | `wait` / `hold_key` 的上限 |
| `maxTextLength` | `8000` | 单次 `type` 的字符上限 |
| `maxDimension` | `1568` | 截图长边上限；`0` 表示按原生分辨率抓取 |
| `pngLevel` | `6` | PNG 压缩级别 0–9；调低换取更快的捕获 |
| `deniedKeys` | `[]` | 拒绝注入的组合键，如 `["ctrl+alt+Delete"]` |
| `requireApproval` | `false` | 每个输入动作是否先走宿主审批 |

### 关于 `requireApproval`

默认关闭。宿主的权限预设已经按会话约束了工具可用性，而审批策略为 `never` 的会话会把
"需要审批"直接判为拒绝，使工具彻底不可用。需要更强约束的部署在 `ask` 策略下打开它，
即可逐次询问。

### 关于 `deniedKeys`

比对按**虚拟键码**归一，因此别名与标点写法都能拦住：
`ctrl+alt+Delete` / `Ctrl+Alt+del` / `alt+ctrl+delete` 是同一个条目，
`ctrl+plus` 与 `ctrl+=` 也是同一个（它们是同一个物理键）。按名字比对会留下
"写了却拦不住"的漏洞，那正是安全配置最不能有的失效方式。

## 可靠性设计

GUI 自动化的失败大多是静默的——按键发出去了但没落到目标上，而且不报错。
本插件把几处实测结论固化成了机制：

**1. 键盘注入前等待焦点控件就绪，而不是固定 sleep。**
点击之后焦点分两步落定：顶层窗口先成为前台，Windows 再把焦点派发到具体子控件。
只看 `GetForegroundWindow` 会在两步之间误判为"已就绪"，此时注入的按键被系统丢弃，
表现为**首个字符凭空消失**。实测固定 sleep 无法消除（250 / 600 / 1000ms 都复现，
丢失 1–3 个字符且随负载抖动）。因此改为等待 `hwndFocus` 稳定。

**2. 每次键盘注入先送一对无害的"牺牲"按键。**
焦点切换后的首批合成输入仍会被系统间歇性丢弃——这不是"还没准备好"，
而是系统对焦点切换期间合成输入的抑制，无法靠等待规避。
于是让它去承受：用 Shift 的按下/抬起对（单独按下不产生字符、也不留下残留状态），
放在**首批事件的最前面**，与真实内容同批投递——抑制按事件生效，排在前面才会被吃掉。

**3. 逐字符节流，且断言系统真的接纳了。**
`SendInput` 的返回值是系统实际接纳的事件数；任何缺口都作为错误抛出，
绝不让"看起来成功了但按键没发出去"静默通过。

**4. 超限自动降采样重抓。**
部署的图像上限无法预先得知，因此若附件服务以"太大"为由拒绝，
插件会换更小的尺寸重抓（配置值逐级减半），而不是把失败直接抛给模型。
屏幕重抓的代价只有几十毫秒。

## 后台模式：让窗口不在前台、也不碰用户的鼠标键盘

当前实现是**前台模式**：截图抓屏幕、点击靠 `SendInput`（会把光标移过去、并且要求目标在前台）。
下面这张表是实测出来的**后台模式**可行性边界，用于指导后续实现——全部数据来自
本仓库 `scripts/probe-*.mjs`，每条都在真实窗口上量过，不是推断。

### 截图：`PrintWindow` 不要求窗口在前台

| 方式 | 被完全遮挡 | 不在前台但可见 | 最小化 |
| --- | --- | --- | --- |
| 屏幕位图 `BitBlt`（**当前实现**） | ✗ 只抓到遮挡物 | ✓ | — |
| `PrintWindow` + `PW_RENDERFULLCONTENT` | GDI 窗口 ✓ / Chromium 见下 | ✓ | ✗ 渲染被挂起 |
| `PrintWindow` 不带该标志 | ✗ **返回成功但给黑图** | ✗ 同样黑图 | ✗ |

- 经典 GDI 窗口：被完全遮挡也能抓到自己的内容（实测品红占比 **86.2%**）。
- Electron/Chromium：对一个**已经上过屏**的窗口有效——用 DSH 自己的窗口实测，
  它当时不在前台，抓到的就是它真实的 UI（已逐帧目视核对）。
- 但**从未被呈现过**的 Chromium 窗口拿不到帧：实测新建后一直处于遮挡下的窗口，
  各表面均返回 0% 内容。Chromium 对完全被遮挡的窗口会停止产出帧。
- 最小化一律不行（实测 99.9% 白）——渲染被系统挂起，必须先还原窗口。

### 输入：不碰光标、不抢前台

| 方式 | 经典 Win32 控件 | Chromium / Electron |
| --- | --- | --- |
| `WM_LBUTTONDOWN/UP` 模拟鼠标 | ✗ 窗口不在前台时无效（落点是按钮类控件时插件改发 `BM_CLICK`，见下行） | ✗ 打到顶层窗口无反应 |
| `BM_CLICK`（按钮语义点击） | ✓ | 不适用 |
| `WM_CHAR` / `WM_SETTEXT` | ✓ 但必须投给**控件本身**（如 Edit 子控件），投顶层窗口会被丢弃 | 见下 |
| `PostMessage` 到渲染子窗口 | 不适用 | **✓ 鼠标与键盘都生效** |
| UI Automation `InvokePattern`/`ValuePattern` | ✓ | ✓（视元素是否暴露） |
| `SendInput`（**当前实现**） | ✓ | ✓ |

两条关键结论（后补的第三条同样来自实测）：

1. **UI Automation 会抢走前台。** 逐步追踪发现，`InvokePattern` 与 `ValuePattern`
   执行后前台窗口变成了目标窗口。它是"不碰光标"的好方案，但不是"不抢前台"的方案。
   而 `BM_CLICK` / `WM_CHAR` / `WM_SETTEXT` 全程未改变前台。

2. **Chromium 必须打到 `Chrome_RenderWidgetHostHWND` 这个子窗口**，打顶层
   `Chrome_WidgetWin_1` 或 `Intermediate D3D Window` 都没有反应。
   实测坐标是精确的：投递客户区 (308,241)，页面记录到的就是 `MD-308x241`。
   键盘同理，`WM_KEYDOWN` 能触发页面的 `keydown`。

3. **经典 Win32 的键盘消息必须投给具体控件。** 键盘消息不会从父窗口转发给
   子控件——`WM_CHAR` 投给顶层窗口会被直接丢掉（实测目标文本框一个字也没
   进去），投给文本框子控件自己的句柄才生效。插件因此在 GDI 目标上自动
   在窗口后代里寻找文本输入控件（找不到时回落到顶层并如实标注不可靠）。

这两条已经接进插件：`resolveTargetWindow` 负责认出渲染子窗口，
`imagePointToClient` 负责把图像坐标换算到它的客户区坐标。

### 已实现：怎么用

传 `target` 就是**后台模式**，光标不动、前台不改，这也是默认配置下**唯一可用**的输入方式。
不传 `target` 的输入动作属于**前台模式**（会移动真实光标、并把焦点从用户手上拿走），
默认是**关闭的**：未开启时它会失败并说明原因，只有部署方在配置里把
`allowForegroundInput` 设为 `true` 才可用。只读的 `screenshot` / `cursor_position` /
`window` / `wait` 不受此限：前台截图只是读屏幕，不产生任何输入。

```jsonc
// 1. 先列出可操作的窗口（不动光标、不改焦点）
{ "action": "window" }
// → value.windows: [{ handle: "131234", title: "记事本", kind: "gdi", width: 800, height: 600, minimized: false }, …]

// 2. 后台截图：窗口不必在前台
{ "action": "screenshot", "target": "131234" }

// 3. 后台点击/打字：坐标用上一步截图上读到的像素
{ "action": "left_click", "target": "131234", "x": 120, "y": 88 }
{ "action": "type", "target": "131234", "text": "你好" }
```

只有 `screenshot`、`left_click`、`right_click`、`middle_click`、`type` 接受 `target`；
其余动作给了 `target` 会**报错**，而不是悄悄退回前台模式——静默降级会让模型以为
自己没碰用户的光标，实际碰了。

坐标的解释是有**状态**的：带 `target` 的截图会记下该窗口当次截图的缩放映射，
随后的点击按同一份映射把图像坐标换回客户区坐标；从未截过图（或截图后客户区尺寸变了）
则把 `x`/`y` 当作**已是客户区坐标**。用的是哪种解释会写在结果的
`background.coordinateSource` 与 summary 里——模型不需要自己换算，也不要自己再除一遍缩放比。

### 每个结果都带可信度，而不是"成功/失败"两态

后台输入的结果里有 `background.reliable` 与 `background.note`：

- **Chromium/Electron**（投到渲染子窗口）：`reliable: true`，实测消息确实被页面处理，
  坐标精确（投递 (570,383)，页面回报 (570,383)）。
- **普通 Win32 窗口**：`reliable: false` —— 实测"不在前台时模拟鼠标消息无效"，
  消息可能入队但窗口不会按点击语义响应。结果里会明确建议改用前台模式。
- 普通 Win32 窗口的**打字**会先在窗口后代里自动寻找文本输入控件（`Edit`、
  `RichEdit` 系列、WinForms 的 `WindowsForms10.EDIT.*` 等，优先可见且面积大的），
  并把 `WM_CHAR` 投给那个控件——实测投给顶层窗口会被直接丢弃（键盘消息不会
  从父窗口转发给子控件）。找到了控件时 `reliable: true`；找不到时回落到顶层
  句柄并在 `note` 里明说"回落了、大概率不生效"。
- 按键语义是保住的：`right_click` / `middle_click` 发各自的消息号，不会退化成左键。

后台截图同样不是"拿到就算成功"：`PrintWindow` 经常返回成功却给出一张空白图，
因此结果先过一遍空白帧检测（近黑、近白、颜色种类过少三种成因分别判定），
判为空白时**返回错误**而不是把空图交给模型。

**已知误报**：内容本身就是纯色的窗口（例如整屏纯白的页面）会被判成空白。
这不是可修的缺陷——空白帧与纯色内容在像素上不可区分。判为空白时的错误信息会提示这一点。

### 是否要求窗口"在前台"与"被遮挡"是两件事

| 方式 | 被完全遮挡 | 不在前台但已上过屏 | 最小化 |
| --- | --- | --- | --- |
| 屏幕位图 `BitBlt`（前台模式截图） | ✗ 只抓到遮挡物 | ✓ | — |
| `PrintWindow` + `PW_RENDERFULLCONTENT`（后台模式截图） | GDI 窗口 ✓ / Chromium ✗ | ✓ | ✗ 渲染被挂起 |

Chromium 对**完全被遮挡**的窗口会停止产出帧，所以后台截图要求它至少可见过一次；
GDI 窗口没有这个问题（自己按需重绘）。

### 坐标换算链

模型从截图上读到的是**图像坐标**，投递要的是**客户区坐标**，中间隔三段：

```
图像坐标 --÷scale--> 截取区域内偏移 --+origin--> 屏幕坐标 --−客户区原点--> 客户区坐标
```

`scale` 是截图被降采样后的比例（外壳里会写明），`origin` 与客户区原点都取自
**渲染表面**而不是顶层窗口——Chromium 的内容画在 `Chrome_RenderWidgetHostHWND`
子窗口里，两者原点相差一个标题栏与边框。往顶层窗口投递的实测结果是**毫无反应**。

关于 DPI：本实现全程在**物理像素**里工作（截图是物理像素、渲染子窗口的客户区也是
物理像素），因此不需要额外的 DPI 缩放换算；Chromium 自己负责把客户区坐标映射到 CSS 像素。

这一条**已实测**（`scripts/probe-chromium-dpi.mjs`）。它用 `--force-device-scale-factor`
启动自己的 Chrome 实例，因此**不需要改动系统显示设置**就能把同一个问题问清楚。三点对照：

| 缩放因子 | 渲染子窗口客户区 | `devicePixelRatio` | 投递的客户区坐标 | 页面收到的 CSS 坐标 |
| --- | --- | --- | --- | --- |
| 1 | 884x661 | 1 | (354, 231) | (354, 231) |
| 1.5 | 879x645 | 1.5 | (352, 226) | (234, 150) |
| 2 | 874x630 | 2 | (350, 221) | (175, 110) |

三种缩放下都精确满足 `页面坐标 = 投递坐标 ÷ devicePixelRatio`，且 `视口尺寸 x dpr = 客户区尺寸`。
结论：**投递客户区坐标即可，插件侧不需要按 dpr 换算。**

### 结论

后台模式已实现并接入工具层，两条路都验证过：**截图用 `PrintWindow`，
输入用消息投递**。它的代价是可靠性依赖目标窗口的种类——所以模式由 `target`
参数**显式**选择，每个结果都带 `reliable`/`note`，而不是把前台模式悄悄换掉。

## 安全边界

- 这是**用户的活机器**，屏幕上的一切用户都看得见。
- 提示词里明确要求模型：不得在用户未明确要求的情况下点击或输入会删除数据、
  发送消息、完成购买、改变账户或系统安全设置的内容；也不得绕道用等价动作规避被拒绝的操作。
- 建议在 profile 里用 `allowInput: false` 先只开放"看"，确认无误再逐项放开。
- 宿主的权限预设与工具审批体系照常生效，本插件不另造一套。

## 开发 / 测试

### 克隆后跑起来

```bash
pnpm install                    # 或 npm install：装 devDependencies，并触发 prepare 构建 lib/
node scripts/link-doubles.mjs   # 把 test/doubles/ 的测试替身联接到 node_modules（幂等）
node scripts/build.mjs          # 构建 src/*.ts → lib/*.js
node --test test/*.test.mjs     # 单元测试
```

日常不需要逐条敲：`npm test` 与 `npm run verify` 会自动先联接替身、再构建、再跑测试。

| 命令 | 作用 |
| --- | --- |
| `npm run build` | `src/*.ts → lib/*.js`（esbuild，不打包；见 `scripts/build.mjs` 顶部注释） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | 联接替身 + 构建 + `node --test test/*.test.mjs` |
| `npm run verify` | 联接替身 + 类型检查 + 构建 + 单元测试 |
| `npm run doubles:link` / `doubles:unlink` | 建立 / 拆除替身联接 |

`prepare` 就是 `node scripts/build.mjs`，所以 `npm install` 与从 git 安装都会自动构建出
`lib/`（`main` 指向它）。它在**缺少 esbuild 时**会跳过构建并打印提示（本地 `--omit=dev`、
离线安装不该被一个可选产物拖垮），但依赖在场而构建失败一律硬失败——git 安装会先装好
devDependencies，绝不能静默交付一个没有 `lib/` 的包。细节写在 `scripts/build.mjs` 里。

### 测试替身：它们是什么、为什么用联接

`test/doubles/` 下有三个**替身**（进版本库，是仓库的一部分，**不是真的第三方包**）：

| 替身 | 它顶替什么 |
| --- | --- |
| `test/doubles/koffi/` | 原生 FFI 模块 `koffi`：一个"假 Windows"（1600×900 桌面、光标、窗口树、SendInput 调用记录） |
| `test/doubles/dsh-tools/` | 宿主包 `@deepseek-ai/dsh-tools` 的 `defineTool` |
| `test/doubles/schemastery/` | 宿主包 `@deepseek-ai/schemastery`（可调用 schema 的语义子集） |

看到 `test/doubles/koffi/index.js` 时不要以为那是 koffi 的源码：它里面没有一行 FFI 调用，
只有按签名分派的假实现。三个替身都支持**委派**：设置 `DSH_COMPUTER_USE_REAL_KOFFI` /
`DSH_COMPUTER_USE_REAL_HOST_TOOLS` / `DSH_COMPUTER_USE_REAL_HOST_SCHEMASTERY` 指向真实包入口，
它们就把调用转给真实实现，于是原生冒烟测试与宿主契约校验跑的是**同一份 `lib/*.js`**。

替身之所以是替身：真实 `koffi` 会移动用户的光标、真实宿主决定了插件的激活方式，两者都
不该出现在单元测试里。替身让「动作分派 → 参数校验 → 原生调用序列 → 输出组装」这条完整
路径可以在几毫秒内重复跑，且**不产生任何副作用**。

**为什么要联接而不是直接放在 node_modules。** 替身必须进版本库（否则克隆下来跑不了
测试），而 `node_modules/` 被 .gitignore 排除；但 Node 的裸说明符解析（`import koffi from
'koffi'`）只认 `node_modules/`。`scripts/link-doubles.mjs` 于是在 `node_modules/` 下建一层
junction 指向 `test/doubles/*`（Windows 上不需要管理员权限）。它幂等，重复执行只会补齐
缺失的联接。

被顶替的真实包（`npm install` 装出来的 `koffi`、`pnpm` 指到存储里的联接）**不会被删除**：
脚本把它们挪到 `node_modules/.dsh-computer-use-parked/`，`npm run doubles:unlink` 会把联接
拆掉并把它们放回原位。这是刻意的——本脚本是 `npm test` 的前置步骤，不该有破坏性。

**生产解析路径上不能有替身。** 这是硬约束，因为只要源码目录被 `link:` 装进 profile，
Node 就会从项目真实路径向上解析依赖，先撞上 `node_modules/` 里的替身。因此：

- 本地安装一律用 `node scripts/install-local.mjs`（复制 `files` 声明的文件 + 自检没有 node_modules）；
- 分发走 git 依赖或 `npm pack`：`files` 只包含 `lib`、`cordis.patch.yml`、`README.md`；
- 确实要用 `link:` 时，先 `npm run doubles:unlink`；
- `link-doubles.mjs` 检测到本目录**已被 profile link: 安装**时会拒绝建立联接并说明原因
  （宁可测试报"找不到模块"，也不让生产撞上替身）。

代价说清楚：联接一旦建立，它就在 `node_modules/` 里。上述守卫覆盖的是"先 link: 安装、
再跑测试"这一方向；"先跑测试、再 link: 安装"这一方向在仓库内无法从结构上阻止，只能靠
`doubles:unlink` 与 `install-local.mjs` 的复制安装。

### 测试策略

替身使测试能在不触碰真实桌面的前提下驱动完整的工具执行路径：

- `koffi` 替身提供一个"假 Windows"（1600×900 桌面、光标、窗口、SendInput 记录），
  并可用 `globalThis.__koffiStub` 改写行为、读取每一次原生调用。
  因此**注入的事件序列本身**是可断言的：分批方式、扫描码、扩展键标志、修饰键顺序。
- `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 替身默认透传，
  但可通过环境变量委派给**宿主真实包**。
- `test/output-schema.test.mjs` 专门盯住输出契约：把替身委派给宿主真实的
  `defineTool` 取到**编译后**的 output schema，再用宿主真实的
  `validateJsonSchemaValue` 逐个动作校验返回值，并顺带跑一遍 `render()`。

最后一条不是可选项。**schema 与 TS 类型之间没有任何关联**——schema 只是普通对象
字面量，所以"代码返回 `{left,top,right,bottom}`、schema 写的是 `{x,y,width,height}`"
这类错配 `tsc` 一个字都不会说，只会在宿主真正执行时以
`invalid output: missing required property …` 的形式爆出来。同理，给一个可选字段
误加 `required: true` 会让除截图外的所有动作全部失败。

### 用真实宿主契约校验

```bash
node scripts/verify-host-contracts.mjs <宿主 node_modules 根目录>
# 例如： node scripts/verify-host-contracts.mjs C:\Users\<you>\.dsh\profiles\node_modules
```

它用宿主真实的 `defineTool` 与 schemastery 跑同一份 `lib/*.js`，
回答两个替身回答不了的问题：宿主是否接受本插件的参数 DSL 与输出 schema、
Config 的默认值是否与文档一致。

### 用真实宿主服务做进程内集成校验

```bash
node scripts/verify-integration.mjs <宿主 node_modules 根目录>
```

只 new 一个干净的 Cordis Context，挂上宿主真实的 `SystemPrompt` 与
`ToolRuntime`，再按加载器的方式装配本插件，然后断言 `computer` 工具真的
出现在 `tools.schemas()` 里、全部动作都投影到了模型侧 schema、提示词段落
进入了 `systemPrompt.assemble()`。

这一层是必须的：它回答"重启之后插件到底会不会激活"。没有它，一个
"硬依赖了未挂载服务"的错误会一路走到部署——宿主不报错，插件的 fiber
静静停在 `pending`，模型侧完全看不到工具，而插件列表里它看起来是启用的。
判断这类静默失效只有一个可靠信号：`plugin_manager list_plugins` 里那条
`fiberPhase` 是否等于 `active`。

### 真实原生层冒烟测试

```bash
# 先指向宿主安装里的真实 koffi
export DSH_COMPUTER_USE_REAL_KOFFI=".../node_modules/koffi/index.js"
node --test test/live.test.mjs

# 额外验证输入注入（会短暂抢焦点，但只打向自建的置顶靶窗口）
DSH_COMPUTER_USE_LIVE_INPUT=1 node --test test/live.test.mjs
```

`test/helpers/input-target.ps1` 会创建一个置顶的 WinForms 窗口作为靶子，
把收到的文本与鼠标/键盘事件写入 JSON 供比对；测试结束即终止该进程。
之所以要自建窗口：合成键盘事件只投递给持有焦点的控件，直接往用户桌面上打字会污染他们正在用的程序。

### 会打扰用户的脚本必须显式放行

下面这些脚本会创建窗口、抢占前台、移动光标，或启动并结束浏览器进程，因此**默认拒绝运行**，
必须显式设置 `DSH_COMPUTER_USE_ALLOW_DISRUPTIVE=1`：

- `scripts/probe-printwindow.mjs`、`scripts/probe-printwindow-chromium.mjs`
- `scripts/probe-click-methods.mjs`、`scripts/probe-click-chromium.mjs`
- `scripts/probe-chromium-background-input.mjs`、`scripts/probe-title-tracking.mjs`
- `scripts/probe-chromium-dpi.mjs`（会启动自己的 Chrome 实例）
- `scripts/probe-foreground-timeline.mjs`、`scripts/start-e2e-target.mjs`
- `scripts/verify-background-mode.mjs`、`scripts/verify-no-activate.mjs`、`scripts/verify-gdi-text-fix.mjs`
- `scripts/verify-cursor.mjs`（它会移动光标来验证 `SetCursorPos`）

```powershell
$env:DSH_COMPUTER_USE_ALLOW_DISRUPTIVE="1"; node scripts/probe-printwindow.mjs
```

这条规则来自一次真实事故：在用户正在工作时执行探针，用"按可执行文件路径杀 chrome.exe"
的方式清理，把用户自己开着的浏览器一起关掉了。这类脚本必须**默认安全**，
而不是默认危险；清理也必须按自己启动的 PID 精确终止（`taskkill /PID <自己> /T /F`）。

环境变量在脚本解析任何依赖之前就已判断，因此拒绝时不会创建任何窗口、不会启动任何进程。

## 结构

```
src/
  index.ts       插件装配：占用槽位、注册工具与提示词
  config.ts      schemastery 配置 + 跨字段校验
  tool.ts        computer 工具：动作分派、参数校验、输出组装
  prompt.ts      系统提示词段落
  capability.ts  路由图像能力门（复刻宿主 read_image 的严格门）
  win32.ts       koffi 绑定：一处声明全部签名，一处做 FFI 转换
  screen.ts      桌面度量与捕获流水线
  input.ts       鼠标/键盘注入：焦点等待、节流、牺牲按键
  keys.ts        按键名与组合键解析（别名归一、扩展键标志）
  png.ts         最小 PNG 编码器 + 面积平均缩放（只用 node:zlib）
  image.ts       截图输出契约：值 schema、持久化、坐标换算外壳
  contracts.ts   本插件消费的宿主服务窄契约
  koffi-types.ts koffi 的最小结构类型
```

`lib/` 是构建产物，不入版本库；`src/` 是唯一的人工维护入口。

```
test/
  *.test.mjs     单元测试（node --test；不碰真实桌面）
  doubles/       宿主包与 koffi 的测试替身（进版本库，由 scripts/link-doubles.mjs 联接到 node_modules）
  helpers/       真实窗口靶子的 PowerShell 脚本（只有 live 测试与探针会用）
scripts/
  build.mjs         构建（src → lib）；同时是 package.json 的 prepare
  typecheck.mjs     tsc --noEmit（用 node_modules 里的 typescript，缺则退回 PATH）
  link-doubles.mjs  建立 / 拆除测试替身联接（幂等，带生产路径守卫）
  install-local.mjs 复制安装到 profile（只复制 files 声明的可发布文件）
  probe-*.mjs / verify-*.mjs  真实桌面上跑过的一次性探针与验证（默认拒绝运行，见上）
```

## 许可

MIT
