# D-Chat native integration: implementation checkpoint

Status: **WIP, not a usable Cindy D-Chat connection**. The local teammate settings
now expose an explicitly inactive binding draft. No production native inlet or
startup hook registers the transport for incoming messages. The transport modules
are not evidence that real partner memory, skills, tools or permissions have run.

## Implemented boundaries

- `packages/lizi-im/src/dchat/` adds configuration validation, a content-free
  durable receipt ledger, admission and output lifecycle, and a `TextChannelIM`
  facade for Cindy's existing orchestrator. It contains no agent engine.
- The optional Desktop adapter uses the existing companion route dependency:
  owner private messages go to canonical; groups/topics/guests go to their lanes.
  `companionRequired` rejects missing/inactive partners and ignores unrelated
  takeover bindings. Other channels retain their existing routing behavior.
- The account, connection, partner, chat, topic and execution generation are bound
  to each receipt. Interrupted dispatches and unknown sends are never replayed.
  Duplicate receipt metadata is retained indefinitely; compaction is not implemented.
- Self-originated messages do not dispatch. Group context collection does not
  authorize execution. Execution chat IDs default to empty; replies default to
  drafts. Draft storage/UI is a required injected dependency, not implemented here.
- Arbitrary side-channel sends are rejected; final output needs an accepted input.
  Guest tool policy uses the existing shared policy and desktop confirmation.
  No D-Chat message can approve a permission. Non-permission interactions require
  further integration with Cindy's existing interaction UI.
- The macOS IPC adapter requires `dchat_im_clean_send_v2` on every send and checks
  the native account. It never patches D-Chat, falls back to another sender or
  automatically retries. A resource acknowledgement is labeled separately from a
  server message key. No real send has been performed.
- An optional installed native CLI reader provides fresh identity and bounded
  history reads. It does not download or run a wrapper/updater. History permission
  or schema failure is explicit. This reader is **not** the local SQLCipher reader.

## Remaining before an end-user build

1. Promote the inactive owner-scoped binding draft into a verified native connection
   lifecycle. The teammate settings entry saves draft identifiers only; it cannot
   enable execution, accept messages, prove sender identity or select real chats.
2. Finish the macOS local database reader with read-only SQLCipher access and
   in-memory key handling. The CLI reader does not establish equivalent access.
3. Verify native chat membership, exact group invocation metadata and continuous
   history pagination before connecting real incoming messages to `receive`.
   No renderer-provided body may serve as native identity evidence.
4. Persist and restore accepted execution-to-session/destination bindings for long
   task notifications. The current facade retains active lanes only in memory and
   rejects a second active input in the same lane; it is not a durable input queue.
5. Complete cancellation, pending-input interaction and busy-lane handoff through
   the existing coordinator. Preserve shared approvals and plugin-output boundaries.
6. Complete isolated mock startup and product acceptance using the repository
   wrapper. Typechecks, targeted tests, lint and a Linux package build have passed
   at recorded checkpoints; they do not establish a running Cindy application.
7. Build and verify the macOS artifact on a Mac. Linux output cannot serve as a
   macOS package. Verify the actual D-Chat clean-send capability independently.

## Source provenance

Implementation targets the public Cindy commit
`6ef269cd62682236e7e4128c5802572023502285` (Apache-2.0). It is not the same commit
as the installed application referenced during investigation.

Protocol facts were reviewed against QChat 0.4.6, reference commit
`ecc20858bcac488ec030f30f4722139f69b8ec61`, including WorkspaceServer framing and
clean-send capability checks. No QChat source, executable, credentials, database,
account data or dependencies were copied into this change. No explicit QChat
license was established; do not vendor its source without resolving that first.

The shared text output contract now optionally carries the triggering input ID.
D-Chat requires that ID to match its immutable receipt before a terminal commit;
a late terminal cannot consume the next input occupying the same lane. Native
message IDs reused by two chats have distinct internal receipt identities.
The facade snapshots validated configuration at construction.

Tests use synthetic messages, injected native calls and private in-memory stores.
They cover module behavior, not real D-Chat delivery or the original partner's
real memory/tool execution.

## Verified development checkpoint (2026-11-09)

- Node 22.20.0, isolated pnpm 10.33.2 and Git LFS 3.4.1; Desktop dependency
  installation completed without replacing machine-wide tools.
- IM package typecheck, Desktop typecheck and maker-core typecheck passed.
  The new channel literals in source/configuration/permission types are additive;
  companion execution still stores `source=bot`. No SQL migration was added.
- D-Chat module tests: 23 passed across three files, 1.11 seconds combined.
- Shared companion routing and output tests: 47 passed, 30.21 seconds combined
  (25.19 seconds transform; test bodies 100 ms). The existing routing file now
  exercises real D-Chat facade/channel policy -> shared runner -> synthetic
  canonical Session.send -> bound native-send substitute. Existing legacy
  fallback behavior remains tested separately from companion-only refusal.
- Added/changed IM and Desktop files passed targeted ESLint. Test-hygiene passed.
- Migration validation passed all six stages, including unchanged historical
  migration hashes and Drizzle schema validation.
- A Linux amd64 `.deb` development build completed. This validates packaging,
  not an enabled D-Chat connection; the adapter is not registered at startup.
- The isolated Global mock startup wrapper returned `DESKTOP_DEV_VERDICT=failed`:
  the pinned Claude runtime and its CDN fallback could not download. No ready
  product signal, GUI acceptance or real partner memory/tool execution is claimed.
- Developer-doc links check did not pass because upstream linked image assets
  remain absent in this partially hydrated checkout. No assertions were removed.

The installed reference client's commit remains unavailable publicly. This public
checkout and Linux artifact are not that installed version and are not a Mac build.
No real messages, account login, D-Chat patches, production partner configuration,
production profile migrations or replacement of an existing Cindy instance occurred.

## 恢复后补充实施记录

伙伴设置的“消息平台”增加默认收起的 D-Chat 草稿入口，明确标注开发中。
三个 ID 仅作为待核实的配置保存，不证明原生身份，不授予任何执行权限。
存储复用 owner-scoped override、跨进程锁与原子替换，拒绝切号中的读写、
不可用伙伴的新绑定和额外执行字段；已停用伙伴的旧草稿仍可删除。
接口只对可信本机 Renderer 开放，没有接入设备互联白名单或手机；远程伙伴不显示本机草稿。
没有新增数据库 migration，也没有把聊天正文写入配置。

补充验证：

- 草稿 handler 的 6 项单测通过，单文件实测 2.04 秒、测试体 9 毫秒。
- 原有 IM 启动和伙伴消息平台的 29 项相关测试通过，40.11 秒；转换占 30 秒。
- Desktop 类型检查、相关 ESLint、test-hygiene 通过。
- 12 种语言的 key 对齐与术语门禁通过；全仓既有 i18n 警告 4,990 项，
  待裁决术语告警 18 项，未通过弱化断言消除。
- 新 UI 使用语义 token 和共享 FormField/Input/Button/Collapse。
  布局与交互验证通过仓库 UI 检查工具单独记录；模拟宿主不能证明真实 IPC 落盘。
- Linux 上将 Electron 当 Chromium 使用的尝试不能创建浏览器上下文，
  返回 Target.createBrowserContext 错误；该尝试不计作 GUI 验收通过。

原生读取、真实成员与召唤证据、连续分页、持久长任务跟进、完整待输入交互、
Mac 包及实际伙伴记忆/技能/工具执行仍未完成。没有独立 reviewer 验收。
最终构建、启动与截图结果以交付目录内的验收记录及原始日志为准，
不得把可编译的传输模块或可保存的草稿当作已启用的 D-Chat 功能。


## 2026-11-10 恢复验收

运行资产已补齐：sqlite-vec 不再是 LFS 指针；固定版本 Claude、Codex、
ripgrep 与 Pi 均通过运行资产预检。未替换整机 Node/pnpm，未修改现有 Cindy。

页面专项验收先复现两个问题：异步翻译结果未等待，导致定位器收到 Promise；
模拟宿主每次提供新 namespace 视图，导致依赖该对象的 effect 反复读取草稿，
阻塞保存交互。现改为等待翻译并依赖稳定的读取方法。
真实组件在合成宿主中的 48 个组合通过（12 语言、Light/Dark、360/720 宽度），
耗时 60.1 秒；相关 ESLint 通过。它验证页面交互，不证明真实 IPC 或原生接入。
已目检中文窄屏深色与英文宽屏保存回执；首张 overview 中日文、韩文缺字，
属于本环境字体限制，不能据自动化通过宣称这两种语言视觉验收通过。
全量 changed 页面扫描在 600 秒超时，保留为未通过记录。

补齐运行资产后的 Linux amd64 构建成功；后续界面修复后的最终产物、源码 SHA
和校验值以交付目录 SOURCE.json / SHA256SUMS 为准。历史构建不冒充最终版本。
完整隔离 mock 启动先遇到 root Electron sandbox 错误；仅对无账号测试子进程
使用仓库 packaged smoke 同样采用的 ELECTRON_DISABLE_SANDBOX 环境开关后，
应用进程创建了窗口，但安全包装仍返回 STARTUP_TIMEOUT，不能宣称 ready。
后续独立 D-Bus 验证及清理结果记在交付报告中，不据“窗口已创建”判成功。

本轮未新增独立 Agent / 子任务，未真实发信、登录、应用 D-Chat 补丁、
修改正式伙伴或共享 profile。原生消息入口、SQLCipher reader、成员与召唤
真实性验证、持久长任务跟进、完整待输入交互依然未完成，不能交付为可用接入。
原伙伴真实记忆、技能、工具及审批执行没有验收证据。

独立 D-Bus 的第三次启动同样返回 STARTUP_TIMEOUT。只读 CDP 捕获到本次
测试窗口（localhost:5174，title=Cindy），截图为空白、body 为空，未到主界面。
Desktop 修复后的类型检查通过；没有把这张空白截图认作通过证据。
本轮没有可用 lh CLI，未生成或发布其结构化验收页面；原始 UI summary、
截图、退出状态和中文报告随交付保留，不宣称独立 reviewer 或完整产品验收通过。
