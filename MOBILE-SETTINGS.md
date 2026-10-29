# 手机端看不到语音设置：根因与修复

## 结论

两个原因叠在一起，现在都处理了：

1. **外壳（DSH 核心）**：手机宽度下整个左侧栏滑到屏幕外，连"打开侧边栏"按钮一起滑出去，所以"插件"入口根本点不到。
2. **我们自己的客户端整块没挂上**（致命）：`src/client.tsx` 里本地 helper 和导入的 Remote 贡献重名，`apply()` 里 `$mount()` 拿到的是 helper，运行时抛 `contribution.descriptors is not iterable`，麦克风行和设置入口都不存在。

修复后手机不再依赖插件页：麦克风旁边多一个齿轮（"语音设置"），点开就是完整设置表单。

## 症状（用户原话）

> 我手机端怎么插件页的设置不显示。

## 复现环境

- 地址：`http://127.0.0.1:3080`（本机 web 外壳）
- 视口：390×844（手机竖屏），Playwright + Edge（`channel: 'msedge'`）
- 探针：`test/mobile-probe4.cjs`（布局溢出）、`test/mobile-probe5.cjs`（可见控件清点）、`test/mobile-probe8.cjs`（客户端报错）、`test/mobile-probe6.cjs` / `test/mobile-probe9.cjs`（修复后验收）

## 根因 A：手机宽度下"插件"入口在屏幕外

390×844 实测控件位置（`test/mobile-probe5.cjs`）：

| 控件 | x | 可见 |
| --- | --- | --- |
| 打开侧边栏 | -140 | 否 |
| 新建会话 | -140 | 否 |
| 插件 | -140 | 否 |
| 搜索会话 | -140 | 否 |
| 开始语音对话 | 294 | 是 |
| 打开右侧边栏 | 366 | 是 |

侧栏折叠时按钮本该浮到左上角，但那条规则只对桌面壳生效：

- `packages/client/ui-sidebar/src/client/SidebarRoot.module.css:45-51`

```css
:global([data-windows-titlebar]) .toggle { position: fixed; top: ...; left: 12px; z-index: 30; }
```

Web 外壳没有 `[data-windows-titlebar]`，所以 `.toggle` 留在折叠栏里，跟着栏一起被移到 `x = -140`。结果：手机上无法打开"插件"页，也就到不了 `plugins.bundle.config` 里的语音设置。

这一条属于 DSH 核心行为，不在本插件包里改；我们的对策是给插件自己的入口（见"修复"第 2 项）。

## 根因 B：客户端整块没挂上（我们自己的 bug）

控制台（`test/mobile-probe8.cjs`）：

```
[dsh-voice-dialog] client mount failed TypeError: contribution.descriptors is not iterable
    at Proxy.validateContribution (...)
```

链条：

1. `src/client.tsx:8` 把生成的 Remote 贡献导入为 `speechRemote`：
   `import speechRemote from './speech-remote.js'`
2. 同一个文件 871 行又声明了一个同名 helper（原为 `function speechRemote(ctx)`，用于 `ctx.remote.speech` 不可用时给出中文提示）。
3. 打包后 `apply()` 里 `src/client.tsx:901` 的 `ctx.remote.$mount(speechRemote)` 绑定到的是那个 helper 函数；helper 没有 `descriptors`，运行时立刻抛错，`apply()` 从 `$mount` 处中断 → `conversation.input.activity` 的麦克风行不再注册，齿轮入口也不存在。

附带影响：`lib/client.js` 因为这次重名，导入的贡献被 tree-shake 掉，包体从约 962 KB 缩到 185 KB——正是"没人用到它"的证据。

## 修复

### 1. 名字冲突（必修）

- `src/client.tsx:865`：helper 改名 `requireSpeech(ctx)`，5 处调用同步（catalog / configure / prepare / cancelPreparation / 轮询）。
- `src/client.tsx:895`：`$mount(speechRemote)` 现在拿到真正的贡献。
- 顺带：模型未就绪时不再跳“插件”页（手机打不开），直接弹出这个设置面板；原来的 `openSettings` helper 已删除。

### 2. 手机入口：麦克风旁的齿轮

- `src/client.tsx:1677`（录音中）、`src/client.tsx:1697`（待机）：新增 `aria-label="语音设置"` 的齿轮按钮，两种状态都能点。
- `src/client.tsx:1744` `VoiceSettingsSheet`：用 primitives 的 `Modal`（body 直挂 portal、Esc / 点蒙层关闭、焦点回收），所以弹窗不会被输入框区域裁掉；内容就是插件页同一份 `VoiceSettings` 表单。
- 只在这一个入口上多花成本：插件页原样保留，桌面用户照旧从"插件"进。

### 3. 窄屏样式（≤420px）

`src/client.tsx:1732`（弹窗）与 `src/client.tsx:2328`（表单）：

- 单列：`.dsh-vd-settings section` 全部同宽，没有横向溢出。
- 全宽控件：`select`、暂停毫秒输入框、试听按钮都撑满一列。
- 触控目标 ≥40px：麦克风/齿轮/结束按钮 40×40，`select` 40，`button` 40，复选框行 40，滑杆行 40。
- 可滚动：`.dsh-vd-modalBody` `overflow: auto` + `overscroll-behavior: contain`（6 个分区总高 3591px，内部滚动）。
- 无 hover 依赖：所有控件常显，hover 只改变背景色。

## 验收数据

### 390×844（手机竖屏，`test/mobile-probe6.cjs` / `test/mobile-probe9.cjs`）

| 项目 | 实测 |
| --- | --- |
| 齿轮存在并可点 | 1 个，40×40（x=282, y=481） |
| 麦克风 | 40×40（x=236），与齿轮同排 |
| 弹窗 | 358×796，位于 (16, 24) |
| 弹窗内容区 | 739 高，`scrollHeight > clientHeight` = 可滚动 |
| 分区数 / 宽度 | 6 个，全部 330（单列） |
| select 最小高 | 40（7 个） |
| 数字输入（暂停毫秒） | 46 |
| 按钮最小高 | 40（4 个） |
| 复选框行高 | 40（6 行） |
| 横向溢出 | 无（`scrollWidth = 390 = innerWidth`） |
| 弹窗标题 | 语音设置 |
| 关键项存在 | `停顿多久算说完` 下拉 + `毫秒（400–4000）` 自定义输入 |

### 1280×900（桌面，`test/desktop-probe.cjs`）

| 项目 | 实测 |
| --- | --- |
| 麦克风 / 齿轮 | 1 / 1 |
| 插件页 → dsh-voice-dialog 卡片 → 设置表单 | 均能打开 |
| `.dsh-vd-settings` / `.dsh-vd-pauseRow` | 1 / 1 |
| 控制台 voice-dialog 报错 | 0 |

### 测试

`node --test test/*.test.mjs` → **168 pass / 0 fail**（含新增 `test/mobile-entry.test.mjs` 4 项契约：Remote 贡献不被遮蔽、齿轮入口存在、≤420px 单列 40px、弹窗内部滚动）。

## 截图

| 文件 | 内容 |
| --- | --- |
| `test/.mobile/07-composer-gear.png` | 390 宽输入框行：麦克风旁的齿轮 |
| `test/.mobile/04-settings-sheet.png` | 390 宽：齿轮打开的设置弹窗（朗读分区） |
| `test/.mobile/05-settings-sheet-scrolled.png` | 390 宽：滚到"停顿多久算说完"与自定义毫秒 |
| `test/.mobile/06-desktop-plugin-page.png` | 桌面：插件页里的语音设置（同一表单） |

## 部署

只改了客户端：

```
node build.mjs
copy lib\client.js  %DSH_HOME%\profiles\web\local-packages\dsh-voice-dialog-0.8.1\lib\client.js
```

然后刷新页面即可，**不需要重启服务**。当前产物 sha256 前 12 位：`7336c2bfe47f`（`lib\client.js` 与 profile 里的副本一致）。

## 回滚

1. **只想撤手机入口**：删掉 `src/client.tsx` 里两处齿轮按钮（1682、1702）、`VoiceSettingsSheet`（1749）、根节点的 `{sheetOpen && ...}`、`.dsh-vd-modal*` 与两段 `@media (max-width: 420px)` CSS，以及 `Modal` / `IconSettingsOutlineRegular` 两个导入；重新 `node build.mjs` 并覆盖 profile 的 `lib/client.js`，刷新页面。
2. **不要回滚的**：`requireSpeech` 改名。回滚它会回到"客户端整块挂不上"的状态（连麦克风行都没有）。
3. **整个客户端回退**：`git checkout -- lib/client.js` 后覆盖 profile 副本、刷新页面。注意这会丢掉其他未提交的客户端改动。
