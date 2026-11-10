# D-Chat 原生接入实施状态

状态：开发分支，尚未达到最终可用验收。生产 Main 生命周期与本地入站 reader 已接线；真实 Mac D-Chat、原伙伴能力和长任务跨重启跟进未验收。合成测试不能证明这些能力可用。

## 生产入口与默认行为

Desktop 在既有本地数据库及账号边界就绪后调用 startDchatNativeConnections，在连接停用/账号退出时先 stopDchatNativeConnections。入口为 apps/desktop/src/main/im/dchat/nativeRuntime.ts。Linux 保持原生连接离线；不会猜测 Mac 数据库路径。

伙伴设置中的 D-Chat 向导使用 dchatSetup IPC：Main 文件选择器选择本机 CLI、SQLCipher、组件与数据库目录，Renderer 仅提供聊天 ID 与执行开关。Main 重新读取本机账号并验证目标聊天，拒绝 Renderer 附加的 ownerId/accountId；保存强制 enabled=false、replyMode=draft。启用是单独操作，重新验证账号、聊天类型/父群、原伙伴可用状态后热重载。界面分别显示未配置、已保存未启用、已连接、已启用但不可用及核验失败；Linux 不展示启用操作。返回文件选择器后保留尚未保存的目标编辑。

Main 按账号保存 native-bindings.json。默认 bindings 为空，未启用的旧草稿不会晋升为执行连接。高级配置包含 enabled、config、identityExecutable、sqlcipherExecutable、component、databaseRoot、socketPath。五个路径必须为本机绝对路径，不含密钥、消息或登录材料。运行中修改/停用配置使旧连接租约失效；Main 每次配置写入生成并持久保存新 revision，回执绑定完整配置指纹。重新启用或更改回复模式不会让旧输入获得新授权；缺少该证明的旧回执不补通知或恢复排队。向导从本机账号确立 ownerId，不从表单或群主身份推断；本机账号控制必须另行选择 controlChatId，并在该聊天使用精确的 /cindy <botId> <指令> 前缀。只有 senderId 与 Main 新鲜核验账号相同且无自动来源/可见 Cindy 署名时，才赋予主人身份；普通本人消息、自动发送回执和外部成员都不能借此触发。控制选择与执行开关独立，保存仍停用且为 draft；未允许执行时控制消息也仅作上下文。跨账号主人映射尚需经过明确配对方案才能开放，不能把任意访客升级为主人。

config 包含 accountId、ownerId、botId、connectionId、chats。每个 chat 明确指定 owner-dm / guest-dm / group / topic；私聊填写 peerId，话题填写 parentId。executeChatIds 默认空，replyMode 默认 draft，sendMode 默认 attributed。没有群执行允许范围就不执行；群/话题还需原生结构化提及。绑定不可用一律拒绝，不创建同名伙伴或普通任务。

## 读取、身份与分页

packages/lizi-im/src/dchat/sqlcipher.ts 是独立实现的 SQLCipher 只读 reader。仅 Mac 生产入口开启；Linux 集成测试显式注入平台并创建临时加密合成库。SQLCipher 是主人指定的本机可执行文件，不自动安装。identityExecutable 是已安装的 D-Chat CLI，使用 user info --self 读取当前账号，不运行 QChat。

reader 按新鲜账号定位 1_<accountId>_db/chat39，验证路径类型/归属、schema 字段和 WAL sidecar；以 -readonly 和 query_only 打开，不复制数据库、不 checkpoint、不 migration。候选仅取 Mach-O 的 __cstring；最多 32 个、10 秒预算，密钥仅在内存及子进程 stdin，stderr 不记录。停止时释放缓存。Mac D-Chat 4.27.0 arm64 已用此新 reader 和本架构 SQLCipher 4.20.0 实库只读验证；不代表其它版本、架构或 SQLCipher 分发已验证。静态候选池最多 4096 个，在内存按字符分布排序后只探测前 32 个，仍保持 10 秒总预算；成功依据仍是账号绑定 schema 解密核验，排序不构成密钥信任。

从 vchannels 核对本机账号退群/解散/移出标记、私聊 peer 与话题父群；消息 uid 必须存在于本地 users，排除 robot_id 与冲突的 content.author。群召唤只认结构化 mentions，不认正文里的 @ 字样。生产群/话题执行还通过本机 CLI 的 chat members --vid 查询实时成员，查询前后核验本机账号，并在排队输入真正派发前再次检查本机账号及发信人仍在群中。终稿及恢复通知出站前也重新确认本机账号仍在该群；退群不外传结果。话题校验父群。静态 CLI schema 已确认此命令只读、使用后端 API、不支持 --current，且只支持 channel/extchannel；但 schema 未声明 JSON 字段或完整列表/分页合同。已通过授权 Mac stock CLI 只读核验真实响应：data.vchannel_id、data.channel_id 与 detail.channel.id、detail.vchannel.vchannel_id 必须一致，detail.vchannel.type 仅接受 channel/extchannel；detail.channel.member_count 必须与成员数组长度及唯一数字字符串 ID 数量一致。真实响应没有 has_more，不再虚构此字段；若未来响应声明 has_more，只接受 false。未知/部分/重复/跨聊天响应仍报 DCHAT_MEMBER_SCHEMA_UNVERIFIED。该证据仅覆盖已核验版本与目标，不等同其它版本或大群分页均已验收。

首次页面只建立基线，不执行历史。实库缓存中存在重复序号但前后链接相接；基线窗口仅要求序号不倒退、链接与时间有序，不宣称连续历史。带锚点分页继续严格要求序号 +1，不允许基线例外进入自动执行路径。之后逐页（每页最多 50）从持久 anchor 继续，严格核对序号、prev_msg_key、时间单调与缓存覆盖；缺 anchor/断页即停止，不降级成“最近消息”。整数 TEXT 包括 123.0 以 BigInt 无损归一化。收集上下文与执行允许范围分开；首次页及未召唤背景消息进入现有 owner DB 的 channelGroupWindow；执行触发使用 connection/parent chat/topic 分区、持久增量游标与精确 triggerMessageId 拼装，群窗口负责围栏中和与容量限制。上下文只进入当次模型输入，同时以 captureImContext 保存同源展示快照；D-Chat 渠道说明与界面来源共享名称。它不替换落库原话，也不改变触发者权限。上下文不可用或账号/DB 在拼装期间改变时拒绝执行。群窗口本身的预算与缓存语义不等于完整服务端历史。

## 执行、恢复与输出

DchatIM -> createDchatChannelAdapter -> 既有 shared runner。主人私聊使用原伙伴 canonical，群/话题/访客使用原伙伴专线，companionRequired 禁止 fallback。没有独立 Agent 引擎。既有伙伴身份、工作目录、技能、工具与权限装配仍由原执行入口提供；没有真实账号验收证据。

私有原子回执文件持久保存 messageId/requestKey、账号/连接/伙伴/聊天/话题、generation、Session/clientId 与发送状态，不存消息正文。单 lane 忙碌输入先持久记为 queued；正常终态后才移交下一条。重启只重新读取从未进入 runner 的 queued 原消息，重新核对账号/聊天后派发。曾受理/可能执行的输入恢复成 unknown，不重投。结果未知的发送不重试。回执目前不压缩，8 MB 上限会显式拒绝继续，不能删除去重历史来恢复。

受理回执额外绑定原生 Session instanceId、turnGeneration 与 clientId；出站事件必须匹配原输入的实例和代次，拒绝私有伙伴回复、子 Agent 与后台事件。D-Chat 逐轮工具租约沿用原生 LaneTurnScope，正文不改变 requesterIsOwner。旁路 sendText/sendFile 不可用，终稿仍须匹配原输入锚点，迟到终稿不能消费下一条消息的位置。

executionObserver 在受理时与恢复时挂到原生事件；只在同一实例/代次观察到产品终态时持久记录，不把 silent-stop/continuation 边界当完成。重启读取已持久确认的成功/失败/取消状态，原聊天仍在执行允许范围且账号/伙伴/连接有效、从未尝试输出时，才可发送一次不含正文的状态通知；draft 模式只保留 Cindy 结果。未知发送不重发，旧输入不重投，原生实例/代次被替换且缺少接管证明时保留 unknown。

scripts/verify-dchat-recovery.mjs 用真实 0600 回执文件与 10 个独立 Node 子进程验证通知恢复、精确接管的预留/确认、确认前崩溃、未知发送不重试和账号替换阻断；传输仍为合成。跨进程脚本显式提供接管身份，不能证明宿主自动生成了跨重启恢复凭据。

Main-only inputRecoverySignal 接收真实宿主恢复意图、预约和派发确认。silent-stop 自动续跑由宿主提供旧 instanceId/turnGeneration 与新 clientId，预约阶段迁移精确观察器，派发确认后才允许不含正文的原目的地通知；同步终态在确认前只持久记录，取消、后续输入、换账号或撤销阻断。旧代次事件不能结算新输入，续跑终态以原 requestKey 和当前实例/代次清理共享 runner 的旧轮次及交互租约，再释放原忙碌 lane；不 finalize 旧文本，也不清理后续输入。真实 Session.sendHostTurnContinuation 回归覆盖预约到派发和后续排队输入。协调器 active-turn retry 仅在它本身持有原 clientId 时产生精确接管意图；渠道未知输入强制 continuation-only，避免零可见输出时重发可能产生副作用的正文。

普通 shared IM 的完整应用重启现已接入本机显式「继续任务」入口。INPUT_ENQUEUE 在 CONTINUE_AFTER_APP_EXIT_PROMPT 上扫描当前 owner 私有持久回执，仅有一个未被后续输入取代的来源才可 claim；不按历史正文、时间或最近 Session 猜测。回执必须具备原 requestKey/clientId、Session/bot、配置 revision 指纹、账号、原实例/代次与 Main 记录的触发者权限。新建 manual-claims 的 wx 文件永久消费原输入，客户端索引在 enqueue 前持久化；损坏、半写或已消费的 claim 不按时间/PID 回收。配置被替换的连接目录仍参与恢复凭据发现，不能因当前设置中已无该连接而绕过旧队列 fence。

本机显式 Continue 只派发通用续跑指令，不重放原消息或副作用输入。Main 重新核对伙伴 Session 关联、账号、配置与群成员；拒绝同任务多候选、终态已结算、有任何输出尝试、忙碌/queue-head 恢复、账号切换、撤销及远控恢复。只有新的宿主实际预留原生 instance/generation 时，才在 provider 派发前接管观察与原权限范围；接受派发后确认 claim。来宾仍经原桌面确认，不晋升主人。恢复仅沿原目的地通知一次不含正文的成功/失败/取消状态；不导出原伙伴历史或私有回复，后续输入的代次不能结算旧输入。预约后取消/崩溃保留 interrupted，重启后的已 claim 队列在 provider 前明确拒绝，不能自动重放或重新 claim。界面保留等待、核验中及本地化拒绝原因。

scripts/verify-dchat-manual-recovery.mjs 使用真实私有文件和独立 Node 进程验证 claim 竞争、enqueue/预约/派发/确认崩溃窗、取消、撤销、失败与未知发送。独立进程还执行生产 INPUT_ENQUEUE handler 和真实 AgentInputCoordinator，合成 provider 经实际预约回调产生新原生代次，验证原输入恢复及后续输入不串结果；数据库与 Electron 服务、provider、D-Chat 传输仍为测试适配。它不证明真实模型、Mac 接口或完整 Electron 应用跨进程恢复已实测。应用不自动恢复活跃模型；不确定状态需人工处理，不回收 claim 重试。合成跨模块 history/reply、hook 排除与按次输出既有证据继续保留，不能等同真实已装插件/原伙伴验收。

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

仍需完成：跨账号主人的可信配对（默认拒绝）、其它版本/大型群的实时成员完整性核验、活跃模型跨整个应用进程重启的自动恢复（本次只提供显式手动接管）、真实已装插件防外传及原伙伴能力验收、Mac 完整客户端打包与实际收发验收。新 reader 的 Mac 实库只读已验收，不能扩大为真实伙伴或发送通过。向导仅能保存为 draft，普通自动文字发送需高级配置显式选择 automatic，仍按精确聊天允许范围生效。Linux 包不能冒充 Mac 包。没有 PR、部署或覆盖安装授权；现有正式实例及 profile 不动。


## Mac 最小接手要求

使用同一 Fork 功能分支及其完整源码，不用 Linux deb 替代 Mac 包。工具链要求 Node >=22.12、pnpm 10.33.2、Git LFS、Xcode Command Line Tools 与本架构可用的 SQLCipher 4 CLI。沿仓库 environment-setup 和 desktop-development 准备依赖；不全局替换已有工具，不复制 Linux node_modules。打包走仓库 pnpm build / desktop forge 包装，签名、公证与真实本地接口必须在 Mac 独立记录。

先运行定向单测和 scripts/verify-dchat-sqlcipher.mjs 的加密合成库验证，再用安全启动包装进入独立 --mock / --isolated-auth 沙箱。已有 Mac 本地库只读授权继续有效；本机接手需确认要使用的 D-Chat CLI、D-Chat 4.27.x 组件和 chat39 数据库根，成员目录只读验收还需主人选定一个明确目标聊天。本次远端 Linux 不读取任意真实联系人。密钥自动有预算地探测，不填写到 UI、命令参数、报告或 Git。保持正式 profile、账号、伙伴配置与 D-Chat 进程不变；本任务仍未授权真实发送或补丁。只读验收与真实伙伴执行须分别记录，不能用合成库通过代替。

## 独立 Mac reader 验证

scripts/verify-dchat-mac-readonly.mjs 可由 Desktop 已有 esbuild 打成独立 Node ESM，不新增第三方依赖或加载 Agent/发送模块。显式传入本机只读 CLI、SQLCipher、组件、数据库根和目标 ID；先通过官方 message latest --count 1 门禁，再核验新鲜账号与实时成员，随后运行 Cindy 新 SQLCipher reader 的基线、最新锚点及精确锚点读取。CLI 的 count 可能附带上下文行，门禁检查不把结果当成 reader 连续分页，不放宽 page 的输出上限。

验证只输出数量、布尔值与脱敏错误码，个人 ID、资料、消息 key/正文和数据库密钥均不输出。数据库与 WAL 仅流式哈希比较，不复制；真实客户端持续运行时可能更新文件，观察不稳定不能声称字节不变，更不能停止现有客户端来制造稳定。只读由 -readonly、query_only 和既有私有路径检查约束；合成 SQLCipher 拒写测试继续保留。

本轮 arm64 Mac 返回 50 条基线缓存消息、最新锚点 0 条、精确锚点 1 条，缓存异常处严格分页拒绝 DCHAT_HISTORY_GAP。已有账号在两人成员目录内。未发送消息、未启用连接或自动执行、未改正式 profile。完整 Mac 客户端依赖安装与打包尚未执行：当时可用约 8.1 GiB，已有 Linux 依赖树实测约 8.1 GiB，跨架构安装与打包需额外空间，不能将远端依赖搬到 Mac。
