# Agent Note: 自愈启动保障

Status: implemented

[English](2026-09-15-self-healing-boot-guard.md) | 中文

## 问题

每个应用二进制都通过 `dsh-app-boot` 的 `boot()` 启动。启动一旦失败——插件在 apply 阶段抛错、entry 等待缺失的服务、或配置指向无法解析的模块——就会 fail-loud：进程打印一条诊断并 `exit(1)`。在 supervisor 下反复拉起只会以同样方式失败，损坏的 harness 永远崩溃循环，既无法降级，也没有任何信息告诉下一个 agent 会话：harness 自身的启动已经坏了。

## 决策

在 `dsh-app-boot` 中增加自愈启动保障。`$DSH_HOME/boot-health.json` 中的持久化账本记录每次启动的结果：连续失败次数、最后一次失败信息、以及该失败牵连的 loader entry id。当连续失败达到 `CRASH_LOOP_THRESHOLD`（2）时，`decideRecovery` 判定为崩溃循环。在恢复启动时，`boot()` 为这些牵连的 id 注入 `{ id, disabled: true }` 补丁，让插件树降级到可运行状态而非继续循环。`failedEntryIds` 从「无 fiber 或 fiber 失败/挂起」的 entry 中结构化地推导这些 id。

恢复摘要写入 stderr，并通过 `addBootHealthSection` 以最高优先级注入全局 system prompt，让 agent 意识到自身启动已损坏并优先修复。`boot()` 在插件树稳定后记录成功（清零失败次数）或失败（连同详情）。

该保障是可选开启的：`boot()` 新增可选的 `health` 参数，省略它即保留原有的零副作用约定。`dsh` CLI 在 `runProfile` 中传入 `{}`，因此所有 profile 表面（headless、web 及任意自定义 profile）都通过同一条共享启动路径受到保护。

## 备选方案

**在保障内部重启进程。** 否决，因为已崩溃或已退出的进程无法观察自身退出，也无法重新拉起自己；重启属于外部 supervisor（systemd、PM2）。本保障的职责是让每次重启都降级到可运行状态，而非再次崩溃。

**无条件在每次 `boot()` 记录账本。** 否决，因为每次启动都写 `$DSH_HOME` 会污染未 stub `DSH_HOME` 的测试。可选开启的 `health` 参数保持 `boot()` 零副作用，同时单点 CLI 接线即可全局启用。

**通过解析 loader 失败信息提取 entry id 来恢复。** 否决，因为 import 失败会回滚并移除该 entry，其 id 只存在于嵌套的 `failed to … loader entry <id>` 信息里。结构化的 `failedEntryIds` 覆盖 apply 与 pending 两种情形；import 失败时诊断信息仍会写明模块名。

**崩溃循环时禁用所有 entry（完整安全模式）。** 否决，因为不存在与部署无关的最小 entry 集合。对牵连 entry 的外科式禁用是可恢复的常见情形，且能保留组合的其余部分。

## 后果

崩溃循环现在能够降级：连续两次启动失败后，下一次启动会禁用牵连的 entry 并以可运行状态启动，成功时清零账本。import 失败不会被外科式禁用，因为其 entry 在 `failedEntryIds` 运行前已被回滚；失败信息仍会把模块名呈现给 agent。启动期失败由本保障覆盖；崩溃重启与运行中挂死检测由 `dsh watch` supervisor 负责——它会重启崩溃或心跳过期的子进程，而本保障负责打破崩溃循环。

单元与集成测试覆盖账本读写往返、阈值行为、恢复补丁注入、真实崩溃循环恢复、可选开启的零副作用，以及 prompt 区块注入。该保障无需密钥，并通过共享启动路径同时覆盖 Windows 与 POSIX。
