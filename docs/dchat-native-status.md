# D-Chat 原生接入实施状态

状态：开发分支，尚未达到最终可用验收。生产 Main 生命周期与本地入站 reader 已接线；真实 Mac D-Chat、原伙伴能力和长任务跨重启跟进未验收。合成测试不能证明这些能力可用。

## 生产入口与默认行为

Desktop 在既有本地数据库及账号边界就绪后调用 startDchatNativeConnections，在连接停用/账号退出时先 stopDchatNativeConnections。入口为 apps/desktop/src/main/im/dchat/nativeRuntime.ts。Linux 保持原生连接离线；不会猜测 Mac 数据库路径。

伙伴设置中的 D-Chat 向导使用 dchatSetup IPC：Main 文件选择器选择本机 CLI、SQLCipher、组件与数据库目录，Renderer 仅提供聊天 ID 与执行开关。Main 重新读取本机账号并验证目标聊天，拒绝 Renderer 附加的 ownerId/accountId；保存强制 enabled=false、replyMode=draft。启用是单独操作，重新验证账号、聊天类型/父群、原伙伴可用状态后热重载。界面分别显示未配置、已保存未启用、已连接、已启用但不可用及核验失败；Linux 不展示启用操作。返回文件选择器后保留尚未保存的目标编辑。

Main 按账号保存 native-bindings.json。默认 bindings 为空，未启用的旧草稿不会晋升为执行连接。高级配置包含 enabled、config、identityExecutable、sqlcipherExecutable、component、databaseRoot、socketPath。五个路径必须为本机绝对路径，不含密钥、消息或登录材料。运行中修改/停用配置使旧连接租约失效；Main 每次配置写入生成并持久保存新 revision，回执绑定完整配置指纹。重新启用或更改回复模式不会让旧输入获得新授权；缺少该证明的旧回执不补通知或恢复排队。向导从本机账号确立 ownerId，不从表单或群主身份推断；当前 reader 会忽略自发消息，因此不会把同账号手工输入与 Cindy 发送混为可执行主人命令。跨账号主人映射尚需经过明确配对方案才能开放，不能把任意访客升级为主人。

config 包含 accountId、ownerId、botId、connectionId、chats。每个 chat 明确指定 owner-dm / guest-dm / group / topic；私聊填写 peerId，话题填写 parentId。executeChatIds 默认空，replyMode 默认 draft，sendMode 默认 attributed。没有群执行允许范围就不执行；群/话题还需原生结构化提及。绑定不可用一律拒绝，不创建同名伙伴或普通任务。

## 读取、身份与分页

packages/lizi-im/src/dchat/sqlcipher.ts 是独立实现的 SQLCipher 只读 reader。仅 Mac 生产入口开启；Linux 集成测试显式注入平台并创建临时加密合成库。SQLCipher 是主人指定的本机可执行文件，不自动安装。identityExecutable 是已安装的 D-Chat CLI，使用 user info --self 读取当前账号，不运行 QChat。

reader 按新鲜账号定位 1_<accountId>_db/chat39，验证路径类型/归属、schema 字段和 WAL sidecar；以 -readonly 和 query_only 打开，不复制数据库、不 checkpoint、不 migration。候选仅取 Mach-O 的 __cstring；最多 32 个、10 秒预算，密钥仅在内存及子进程 stdin，stderr 不记录。停止时释放缓存。真实 Mac 二进制、SQLCipher 分发与实际 schema 仍需平台验收。

从 vchannels 核对本机账号退群/解散/移出标记、私聊 peer 与话题父群；消息 uid 必须存在于本地 users，排除 robot_id 与冲突的 content.author。群召唤只认结构化 mentions，不认正文里的 @ 字样。此处证明的是本地缓存成员状态与发送者字段，不是实时服务端群成员证明；尚未接入完整成员目录。

首次页面只建立基线，不执行历史。之后逐页（每页最多 50）从持久 anchor 继续，严格核对序号、prev_msg_key、时间单调与缓存覆盖；缺 anchor/断页即停止，不降级成“最近消息”。整数 TEXT 包括 123.0 以 BigInt 无损归一化。收集上下文与执行允许范围分开；首次页及未召唤背景消息进入现有 owner DB 的 channelGroupWindow；执行触发使用 connection/parent chat/topic 分区、持久增量游标与精确 triggerMessageId 拼装，群窗口负责围栏中和与容量限制。上下文只进入当次模型输入，同时以 captureImContext 保存同源展示快照；D-Chat 渠道说明与界面来源共享名称。它不替换落库原话，也不改变触发者权限。上下文不可用或账号/DB 在拼装期间改变时拒绝执行。群窗口本身的预算与缓存语义不等于完整服务端历史。

## 执行、恢复与输出

DchatIM -> createDchatChannelAdapter -> 既有 shared runner。主人私聊使用原伙伴 canonical，群/话题/访客使用原伙伴专线，companionRequired 禁止 fallback。没有独立 Agent 引擎。既有伙伴身份、工作目录、技能、工具与权限装配仍由原执行入口提供；没有真实账号验收证据。

私有原子回执文件持久保存 messageId/requestKey、账号/连接/伙伴/聊天/话题、generation、Session/clientId 与发送状态，不存消息正文。单 lane 忙碌输入先持久记为 queued；正常终态后才移交下一条。重启只重新读取从未进入 runner 的 queued 原消息，重新核对账号/聊天后派发。曾受理/可能执行的输入恢复成 unknown，不重投。结果未知的发送不重试。回执目前不压缩，8 MB 上限会显式拒绝继续，不能删除去重历史来恢复。

受理回执额外绑定原生 Session instanceId、turnGeneration 与 clientId；出站事件必须匹配原输入的实例和代次，拒绝私有伙伴回复、子 Agent 与后台事件。D-Chat 逐轮工具租约沿用原生 LaneTurnScope，正文不改变 requesterIsOwner。旁路 sendText/sendFile 不可用，终稿仍须匹配原输入锚点，迟到终稿不能消费下一条消息的位置。

executionObserver 在受理时与恢复时挂到原生事件；只在同一实例/代次观察到产品终态时持久记录，不把 silent-stop/continuation 边界当完成。重启读取已持久确认的成功/失败/取消状态，原聊天仍在执行允许范围且账号/伙伴/连接有效、从未尝试输出时，才可发送一次不含正文的状态通知；draft 模式只保留 Cindy 结果。未知发送不重发，旧输入不重投，原生实例/代次被替换且缺少接管证明时保留 unknown。

scripts/verify-dchat-recovery.mjs 用真实 0600 回执文件与 6 个独立 Node 子进程验证该通知恢复、未知发送不重试和账号替换阻断；传输仍为合成。

这提供了“终态已确认后重启补通知”的最小恢复闭环，不代表活跃模型执行可跨整个应用进程重启继续。尚缺自动续跑跨代次的可信 clientId 接管回执，以及 provider 重连/跨进程恢复运行中的长任务证明；不能用同一个 Session ID 或历史正文补成完成。合成跨模块回归已实际调用 pluginCompanionSlot 的 history/reply、bot 排除规则与 assistantReplyHook，再验证旁路出站拒绝且仅当前 native 按次结果发送。该覆盖不等于真实已装插件/真实伙伴的产品验收。

主人 /stop 可越过忙碌队列进入已有共享停止入口，清理本 lane 排队回执，不替换原输出锚点。所有交互指定 Cindy desktop 原生路由，包括主人提问与访客审批；D-Chat 正文不能批准工具请求。取消/失败沿用绑定终态。真实待输入、取消、长任务与伙伴记忆工具仍需实际产品验收。

## 普通文字发送与严格能力

普通自动回复使用现有 send_text_message + content 能力，保留 stock 客户端 source=smartwork-cli / platform=pc 元数据，并在普通文字附加可见 Cindy 署名。不会要求 clean-send 实验补丁。此元数据是已调研 stock 协议值，不把它当作权限证据；来源标识不授予执行权限。

无标识 clean-v2 仍严格要求 dchat_im_clean_send_v2；引用与正式提及不在文字 API 范围，未提供也未降级模拟。每次发送重新核对账号与能力；配置/账号租约在异步预检后及 socket 提交前复核。资源回执以 resource: 标记，不冒充服务端消息 key。不应用 D-Chat 补丁，不进行真实发送。

## 验证与平台边界

定向单元测试覆盖原伙伴不 fallback、专线隔离、两个伙伴并发、排队/重启、未知发送、账号变化、自发消息拒绝与绑定输出。共享 runner 集成使用合成 Session.send；并非原伙伴真实能力验收。

真实加密合成库验证脚本为 scripts/verify-dchat-sqlcipher.mjs。使用本机 SQLCipher 4：设置 DCHAT_TEST_SQLCIPHER 为绝对可执行文件路径，以 pnpm exec tsx scripts/verify-dchat-sqlcipher.mjs 运行。它创建并清理一次性临时库，核验解密、schema、连续分页、exact queued lookup、拒绝 CREATE、只读前后 digest 不变、缺序号及账号切换拒绝。该 integration 不是 Mac 实库测试。

完整 --mock 窗口已在隔离 Linux 开发环境实际进入主界面，启动包装返回 DESKTOP_DEV_VERDICT=ready，whoami 源码归属匹配，LocalDbGate ready，写入 23 条演示任务，截图可见完整主界面。此证据只覆盖免登录模拟界面，不代表 D-Chat、真实模型或原伙伴能力验收。

保留修复前的失败：renderer 曾因本任务子进程 nofile=1024 报 net::ERR_INSUFFICIENT_RESOURCES；仅提高测试子进程到 65536 后消除。随后上游基线和开发分支都未进入主界面。定位并修复两项共享启动问题：whoami 未识别 pnpm app-local Electron 实际路径；auth-service 收到切换中推送后丢弃 Main 返回的更高代次稳定状态。修复仍拒绝旧/同代次响应，并要求 renderer app-path 证明 checkout 归属。原始失败、先红后绿用例、真实窗口与源码 dirty 状态在阶段证据包中保留。类型检查和 Linux 产物对应源码以本轮交付报告为准。

## 来源与未完成项

公开基线 6ef269cd62682236e7e4128c5802572023502285，Apache-2.0，与调查时安装版提交不同。QChat 0.4.6 ecc20858bcac488ec030f30f4722139f69b8ec61 仅用于协议事实参考；未复制许可未明源代码、Agent 引擎、依赖、运行数据或凭证。

仍需完成：跨账号主人的可信配对、完整实时成员目录、活跃长任务跨进程与自动续跑跨代次的可信接管、真实已装插件防外传及原伙伴能力验收、Mac 构建与实际本地只读/收发验收。向导仅能保存为 draft，普通自动文字发送需高级配置显式选择 automatic，仍按精确聊天允许范围生效。Linux 包不能冒充 Mac 包。没有 PR、部署或覆盖安装授权；现有正式实例及 profile 不动。


## Mac 最小接手要求

使用同一 Fork 功能分支及其完整源码，不用 Linux deb 替代 Mac 包。工具链要求 Node >=22.12、pnpm 10.33.2、Git LFS、Xcode Command Line Tools 与本架构可用的 SQLCipher 4 CLI。沿仓库 environment-setup 和 desktop-development 准备依赖；不全局替换已有工具，不复制 Linux node_modules。打包走仓库 pnpm build / desktop forge 包装，签名、公证与真实本地接口必须在 Mac 独立记录。

先运行定向单测和 scripts/verify-dchat-sqlcipher.mjs 的加密合成库验证，再用安全启动包装进入独立 --mock / --isolated-auth 沙箱。真实只读验收另需本机主人明确选择 D-Chat CLI、D-Chat 4.27.x 组件、chat39 所在数据库根与目标聊天。密钥自动有预算地探测，不填写到 UI、命令参数、报告或 Git。保持正式 profile、账号、伙伴配置与 D-Chat 进程不变；本任务仍未授权真实发送或补丁。只读验收与真实伙伴执行须分别记录，不能用合成库通过代替。
