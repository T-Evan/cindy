# D-Chat 原生接入实施状态

状态：开发分支，尚未达到最终可用验收。生产 Main 生命周期与本地入站 reader 已接线；真实 Mac D-Chat、原伙伴能力和长任务跨重启跟进未验收。合成测试不能证明这些能力可用。

## 生产入口与默认行为

Desktop 在既有本地数据库及账号边界就绪后调用 startDchatNativeConnections，在连接停用/账号退出时先 stopDchatNativeConnections。入口为 apps/desktop/src/main/im/dchat/nativeRuntime.ts。Linux 保持原生连接离线；不会猜测 Mac 数据库路径。

Main 从 ownerScopedImUserDataPath('dchat', 'native-bindings.json') 读取高级本机配置。默认 bindings 为空；现有设置页仍仅保存未启用草稿，不会自动晋升为执行连接。配置须由本机主人明确提供，包含 enabled、config、identityExecutable、sqlcipherExecutable、component、databaseRoot、socketPath。五个路径均为本机绝对路径；不可放入密钥、消息或登录材料。修改/停用配置使运行中的连接租约失效，重新加载连接仍需正常 IM 生命周期；目前没有启用向导或热重连按钮。

config 包含 accountId、ownerId、botId、connectionId、chats。每个 chat 明确指定 owner-dm / guest-dm / group / topic；私聊填写 peerId，话题填写 parentId。executeChatIds 默认空，replyMode 默认 draft，sendMode 默认 attributed。没有群执行允许范围就不执行；群/话题还需原生结构化提及。绑定不可用一律拒绝，不创建同名伙伴或普通任务。

## 读取、身份与分页

packages/lizi-im/src/dchat/sqlcipher.ts 是独立实现的 SQLCipher 只读 reader。仅 Mac 生产入口开启；Linux 集成测试显式注入平台并创建临时加密合成库。SQLCipher 是主人指定的本机可执行文件，不自动安装。identityExecutable 是已安装的 D-Chat CLI，使用 user info --self 读取当前账号，不运行 QChat。

reader 按新鲜账号定位 1_<accountId>_db/chat39，验证路径类型/归属、schema 字段和 WAL sidecar；以 -readonly 和 query_only 打开，不复制数据库、不 checkpoint、不 migration。候选仅取 Mach-O 的 __cstring；最多 32 个、10 秒预算，密钥仅在内存及子进程 stdin，stderr 不记录。停止时释放缓存。真实 Mac 二进制、SQLCipher 分发与实际 schema 仍需平台验收。

从 vchannels 核对本机账号退群/解散/移出标记、私聊 peer 与话题父群；消息 uid 必须存在于本地 users，排除 robot_id 与冲突的 content.author。群召唤只认结构化 mentions，不认正文里的 @ 字样。此处证明的是本地缓存成员状态与发送者字段，不是实时服务端群成员证明；尚未接入完整成员目录。

首次页面只建立基线，不执行历史。之后逐页（每页最多 50）从持久 anchor 继续，严格核对序号、prev_msg_key、时间单调与缓存覆盖；缺 anchor/断页即停止，不降级成“最近消息”。整数 TEXT 包括 123.0 以 BigInt 无损归一化。收集上下文与执行允许范围分开；共享群上下文窗口的完整拼装尚未接入。

## 执行、恢复与输出

DchatIM -> createDchatChannelAdapter -> 既有 shared runner。主人私聊使用原伙伴 canonical，群/话题/访客使用原伙伴专线，companionRequired 禁止 fallback。没有独立 Agent 引擎。既有伙伴身份、工作目录、技能、工具与权限装配仍由原执行入口提供；没有真实账号验收证据。

私有原子回执文件持久保存 messageId/requestKey、账号/连接/伙伴/聊天/话题、generation、Session/clientId 与发送状态，不存消息正文。单 lane 忙碌输入先持久记为 queued；正常终态后才移交下一条。重启只重新读取从未进入 runner 的 queued 原消息，重新核对账号/聊天后派发。曾受理/可能执行的输入恢复成 unknown，不重投。结果未知的发送不重试。回执目前不压缩，8 MB 上限会显式拒绝继续，不能删除去重历史来恢复。

长任务执行到 Session/目的地的记录已经落盘，但跨重启重新挂观察器、后台通知的持久目的地恢复尚未实现。不得把保存 Session ID 称为长任务闭环。旁路 sendText/sendFile 被拒绝；终稿必须匹配原输入锚点，迟到终稿不能消费下一条消息的位置。companions.history/reply 与插件 hook 的跨模块端到端防外传尚未验收。

主人 /stop 可越过忙碌队列进入已有共享停止入口，清理本 lane 排队回执，不替换原输出锚点。所有交互指定 Cindy desktop 原生路由，包括主人提问与访客审批；D-Chat 正文不能批准工具请求。取消/失败沿用绑定终态。真实待输入、取消、长任务与伙伴记忆工具仍需实际产品验收。

## 普通文字发送与严格能力

普通自动回复使用现有 send_text_message + content 能力，保留 stock 客户端 source=smartwork-cli / platform=pc 元数据，并在普通文字附加可见 Cindy 署名。不会要求 clean-send 实验补丁。此元数据是已调研 stock 协议值，不把它当作权限证据；来源标识不授予执行权限。

无标识 clean-v2 仍严格要求 dchat_im_clean_send_v2；引用与正式提及不在文字 API 范围，未提供也未降级模拟。每次发送重新核对账号与能力；配置/账号租约在异步预检后及 socket 提交前复核。资源回执以 resource: 标记，不冒充服务端消息 key。不应用 D-Chat 补丁，不进行真实发送。

## 验证与平台边界

定向单元测试覆盖原伙伴不 fallback、专线隔离、两个伙伴并发、排队/重启、未知发送、账号变化、自发消息拒绝与绑定输出。共享 runner 集成使用合成 Session.send；并非原伙伴真实能力验收。

真实加密合成库验证脚本为 scripts/verify-dchat-sqlcipher.mjs。使用本机 SQLCipher 4：设置 DCHAT_TEST_SQLCIPHER 为绝对可执行文件路径，以 pnpm exec tsx scripts/verify-dchat-sqlcipher.mjs 运行。它创建并清理一次性临时库，核验解密、schema、连续分页、exact queued lookup、拒绝 CREATE、只读前后 digest 不变、缺序号及账号切换拒绝。该 integration 不是 Mac 实库测试。

完整 --mock 窗口此前失败。恢复诊断捕获 renderer 多个模块 net::ERR_INSUFFICIENT_RESOURCES 和入口动态导入失败；只提高本任务测试子进程 nofile（1024 -> 65536）后，这批错误消失，但仍需根据后续原始 verdict 判定启动，不能以创建窗口或 packaged 空库 smoke 代替 UI。最终记录、基线对比、类型检查和 Linux 产物对应源码以本轮交付报告为准。

## 来源与未完成项

公开基线 6ef269cd62682236e7e4128c5802572023502285，Apache-2.0，与调查时安装版提交不同。QChat 0.4.6 ecc20858bcac488ec030f30f4722139f69b8ec61 仅用于协议事实参考；未复制许可未明源代码、Agent 引擎、依赖、运行数据或凭证。

仍需完成：可启用的设置向导与可信主人核验、完整群上下文/成员目录、长任务持久通知恢复、跨模块防外传验收、完整 mock UI 和原伙伴真实能力验收、Mac 构建与实际本地收发验收。Linux 包不能冒充 Mac 包。没有 PR、部署或覆盖安装授权；现有正式实例及 profile 不动。
