# Pipline 0.1.0 — 内部预览说明（草稿） / Internal Preview (Draft)

> **仅供内部预览，暂不可对外发布。** 本文记录截至 2026-09-28 的当前工作区与本机 Windows 11 24H2 包构建状态。平台和端到端验收未完成，正式发布前必须更新本文。
>
> **Internal preview only; not for public distribution.** This draft reflects the current workspace and local Windows 11 24H2 package build as of 2026-09-28. Platform and end-to-end acceptance remain incomplete; update these notes before any public release.

## 本版本内容 / What is included

- 桌面端内置 Pi Coding Agent 0.85.1 Runtime；普通会话沿 Pi 原生 RPC 路径运行，并复用用户的 `~/.pi/agent` 配置、凭证、会话和扩展。用户无需另行安装 Pi、Node 或 Bun。
- The desktop bundles Pi Coding Agent 0.85.1. Normal sessions use Pi’s native RPC runtime and reuse the user’s `~/.pi/agent` settings, credentials, sessions, and extensions. Users do not need to install Pi, Node, or Bun separately.
- 工作流模式提供独立画布窗口、全局语言切换、九类首发内置节点（Start、End、Pi Agent、Assign、Template、Extract、Merge、Filter、Condition），以及有界 DAG Run、运行记录和受限续跑能力。
- Workflow mode provides a standalone canvas window, global locale switching, nine initial built-in node types (Start, End, Pi Agent, Assign, Template, Extract, Merge, Filter, and Condition), bounded DAG Runs, run history, and constrained retry/resume behavior.
- Pi 对话可检索节点并读取当前画布/Run 摘要；Agent 图修改经 revision 校验和用户确认后应用。NodeMeta 源码候选可保存供查看，但不会因此自动执行。
- Pi conversations can search node templates and read the current canvas/Run summary. Agent graph edits are revision-checked and require user approval. NodeMeta source candidates can be saved for review but are not executed automatically.
- 工作流和 Run 数据存放在 Pipline app-data 数据库，与 Pi 的用户 profile 分开。详细位置及网络边界见[本地数据与网络说明](./DATA_AND_PRIVACY.md)。
- Workflow and Run data live in Pipline’s app-data database, separate from the Pi user profile. See [Local Data and Network Notes](./DATA_AND_PRIVACY.md) for locations and network boundaries.

## 当前平台状态 / Platform status

- **Windows:** 当前工作区已生成 x64 MSI 与 NSIS 内部安装包；NSIS 在 Windows 11 24H2 上的隔离安装/卸载通过。安装版启动检查尚未完成。Windows 10 干净环境验收未完成。安装包未签名，不是公开发行包。
- **Windows:** The current workspace produced x64 MSI and NSIS internal installers. Isolated NSIS install/uninstall passed on Windows 11 24H2. Startup from the installed package has not been verified. Clean-environment acceptance on Windows 10 is outstanding. Installers are unsigned and are not public-release packages.
- **macOS:** macOS 11.0+ Intel 与 Apple Silicon 的源码/构建目标已配置；本草稿对应的 macOS 工件构建、安装和原生运行验收尚未完成。Developer ID、公证和 staple 按项目决定延期。
- **macOS:** Source and build targets are configured for macOS 11.0+ on Intel and Apple Silicon. macOS artifacts, installation, and native runtime acceptance have not been completed for this draft. Developer ID signing, notarization, and stapling are deferred by project decision.

## 已知范围 / Known scope and limitations

- 工作流中只允许具有应用内受信 executor 的内置节点执行。Code、HTTP、MCP、Knowledge 工作流节点不属于本版本的可执行节点；Loop、SubWorkflow、Sleep 也未纳入首发调度范围。Pi 普通会话自身已配置的工具、扩展和 MCP 能力仍按 Pi 配置使用。
- Workflow Runs execute only built-in nodes with trusted in-app executors. Code, HTTP, MCP, and Knowledge workflow nodes are not executable in this version; Loop, SubWorkflow, and Sleep are also outside the initial scheduler scope. Tools, extensions, and MCP servers configured for normal Pi sessions remain governed by Pi configuration.
- Windows 10、macOS 原生构建/运行、可见桌面对话、工作流多窗口协作及完整运行恢复仍有验收项未完成；自动化测试通过不等于这些平台验收通过。
- Windows 10, native macOS builds/runs, visible desktop conversations, cross-window workflow collaboration, and full run-recovery acceptance still have outstanding checks. Passing automated tests does not imply those platform checks have passed.
- 普通会话的模型请求由用户 Pi profile 中配置的 provider 处理；模型、扩展和集成的网络/数据策略由对应服务决定。请先阅读[本地数据与网络说明](./DATA_AND_PRIVACY.md)。
- Model requests in normal sessions are handled by the provider configured in the user’s Pi profile. Network and data practices depend on each model provider, extension, and integration. Read [Local Data and Network Notes](./DATA_AND_PRIVACY.md) first.

## 第三方许可 / Third-party licenses

Pi Runtime、前端、Rust 依赖和字体的许可证索引及声明随构建生成，见 [`../licenses/README.md`](../licenses/README.md)。运行时并非字面上的“全 MIT”；以随包具体声明和 SBOM 为准。

License indexes and notices for the Pi Runtime, frontend, Rust dependencies, and fonts are generated with the build; see [`../licenses/README.md`](../licenses/README.md). The runtime is not literally “all MIT”; consult the package-specific notices and SBOM.
