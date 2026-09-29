# 本地数据与网络说明 / Local Data and Network Notes

> 适用范围：Pipline 当前 Windows 与 macOS 开发版。本文描述源码中已实现的数据路径和网络边界，不构成法律意义上的隐私政策。最后核对：2026-09-28。
>
> Scope: current Pipline Windows and macOS development builds. This note describes paths and network behavior implemented in the source; it is not a legal privacy policy. Last reviewed: 2026-09-28.

## 数据保存位置 / Where data is stored

| 内容 / Data | 位置 / Location | 说明 / Notes |
| --- | --- | --- |
| Pi 配置、凭证、会话、扩展 / Pi settings, credentials, sessions, extensions | 默认 `~/.pi/agent`；Windows 通常为 `%USERPROFILE%\.pi\agent`。若设置 `PI_CODING_AGENT_DIR`，则使用该目录。 / Defaults to `~/.pi/agent`; on Windows usually `%USERPROFILE%\.pi\agent`. `PI_CODING_AGENT_DIR` overrides it. | Pipline 将同一目录交给随包 Pi Runtime 使用，不复制或导入 Pi 数据。Pi 会话历史仍由 Pi 管理。 / Pipline gives this same directory to the bundled Pi Runtime; it does not copy or import Pi data. Pi manages its own session history. |
| 工作区文件 / Workspace files | 用户打开的本地项目目录；远程工作区的项目文件留在 SSH 主机。 / The opened local project directory; remote project files remain on the SSH host. | Pi 的文件工具和终端命令按用户选择的工作区工作，文件不会因为打开项目而迁入 Pipline 数据库。 / Pi file tools and terminal commands operate in the selected workspace; opening a project does not copy its files into Pipline’s database. |
| 工作流、节点模板、运行历史和配对设备记录 / Workflows, node templates, run history, paired-device records | Tauri app-data 目录下的 `picot.sqlite3`，应用标识为 `app.pipline.desktop`。Windows：`%APPDATA%\app.pipline.desktop\picot.sqlite3`；macOS：`~/Library/Application Support/app.pipline.desktop/picot.sqlite3`。 / `picot.sqlite3` under Tauri’s app-data directory for bundle identifier `app.pipline.desktop`. Windows: `%APPDATA%\app.pipline.desktop\picot.sqlite3`; macOS: `~/Library/Application Support/app.pipline.desktop/picot.sqlite3`. | 包含工作区路径登记、工作流与节点定义、变更事件、Run 快照/结果/事件、偏好，以及配对设备的 token 哈希；不包含项目文件副本。 / Stores workspace path registrations, workflows and node definitions, change events, Run snapshots/results/events, preferences, and paired-device token hashes; it does not store copies of project files. |
| 会话显示偏好和终端标签元数据 / Session display preferences and terminal-tab metadata | `dirs::config_dir()/picot/session-ui-profiles.json` 与 `dirs::config_dir()/picot/terminal-state.json`。 / `dirs::config_dir()/picot/session-ui-profiles.json` and `dirs::config_dir()/picot/terminal-state.json`. | 前者记录 provider、model ID 和 thinking level；后者记录终端标签、顺序、profile 与面板高度。终端命令输出、进程 ID、环境变量和检查点不写入 `terminal-state.json`。路径中的 `picot` 是沿用的存储目录名。 / The first stores provider, model ID, and thinking level; the second stores terminal tabs, order, profile, and panel height. Terminal output, process IDs, environment variables, and checkpoints are not written to `terminal-state.json`. `picot` is a retained storage-folder name. |
| 诊断日志 / Diagnostic logs | Tauri 日志目录：Windows `%LOCALAPPDATA%\app.pipline.desktop\logs`；macOS `~/Library/Logs/app.pipline.desktop`。 / Tauri log directory: Windows `%LOCALAPPDATA%\app.pipline.desktop\logs`; macOS `~/Library/Logs/app.pipline.desktop`. | 应用记录 Info 及以上级别日志。日志可能包含错误详情、运行状态或本地路径；分享前请检查并删去敏感内容。 / The app records Info-level and higher logs. Logs can include error details, runtime status, or local paths; review and redact sensitive content before sharing. |
| SSH 远程工作区锚点 / SSH remote-workspace anchors | 默认 `~/.picot/remotes/` 下的本地目录。 / Local directories under `~/.picot/remotes/` by default. | 锚点中的 `.pi/settings.json` 保存远程主机/路径绑定，不保存 SSH 密码。通过连接对话框输入的密码只在 Pipline 进程内存中保留，并传给对应 Pi 子进程；SSH 私钥仍由用户的 SSH 配置管理。 / The anchor’s `.pi/settings.json` stores the remote-host/path binding, not an SSH password. A password entered in the connection dialog is held in Pipline process memory and passed to the corresponding Pi child process; SSH keys remain managed by the user’s SSH configuration. |

Tauri 的 app-data、config 与 log 路径由系统和应用标识共同决定；操作系统的目录重定向或配置可能改变实际位置。[Tauri PathResolver 文档](https://docs.rs/tauri/latest/tauri/path/struct.PathResolver.html)说明了平台默认位置。

Tauri app-data, config, and log paths depend on the operating system and bundle identifier; OS folder redirection or configuration can change the resolved location. See the [Tauri PathResolver documentation](https://docs.rs/tauri/latest/tauri/path/struct.PathResolver.html) for platform defaults.

设置中的“导出诊断日志”会通过系统保存对话框，将活动和轮转的 Pipline 应用日志合并到用户选择的文本文件。它不会打包 Pi 会话、provider 凭证、工作区文件或工作流数据库。日志本身仍可能包含本地路径和错误详情，请在分享前检查并删去敏感信息。

Settings → “Export diagnostic logs” uses the native save dialog to combine active and rotated Pipline application logs into a text file chosen by the user. It does not bundle Pi sessions, provider credentials, workspace files, or the workflow database. Logs can still contain local paths and error details; review and redact sensitive content before sharing.

## 网络连接与第三方服务 / Network connections and third parties

- Pi Runtime 在本机运行，并按共享 `~/.pi/agent` 中的 provider 配置连接模型服务。发送的提示词、被选入上下文的内容及工具结果会按 Pi/provider 的运行方式发往相应服务；各服务自身的日志、保留与隐私政策适用。
- The Pi Runtime runs locally and connects to the model provider configured in the shared `~/.pi/agent` profile. Prompts, selected context, and tool results are sent as required by Pi and that provider; the provider’s own logging, retention, and privacy terms apply.
- 用户启用的 Pi 扩展、MCP server、SSH 主机或其他集成可能自行访问网络并处理数据。请按具体集成的信任与权限设置使用。
- User-enabled Pi extensions, MCP servers, SSH hosts, and other integrations may make their own network requests and process data. Use them according to their individual trust and permission settings.
- Pipline 的本机 Host 监听网络接口以支持配对的远程客户端；工作区数据接口要求有效的配对授权。启用远程访问会把所选工作区及其可用操作暴露给已配对设备，请只配对可信设备，并考虑所在网络的防火墙策略。
- Pipline’s local Host listens on network interfaces to support paired remote clients; workspace data routes require valid pairing authorization. Remote access exposes the selected workspace and available operations to paired devices. Pair only trusted devices and consider the network firewall policy.
- 发布构建可按发布配置检查更新并下载安装包。Pi Runtime、Node Runtime、字体与工作流代码编译器随相应安装包提供；Windows 缺少 WebView2 Evergreen Runtime 时，安装器配置为静默下载 bootstrapper。
- Release builds can check for updates and download installers according to release configuration. The Pi Runtime, Node Runtime, fonts, and workflow code compiler are bundled with the applicable installer. On Windows, the installer is configured to silently download the WebView2 bootstrapper if the Evergreen Runtime is missing.
- Pipline 源码中未配置独立的模型代理服务。本文不承诺 Pi、模型 provider、扩展、MCP server 或更新服务不会记录其收到的信息；请查看相应服务的政策。
- The Pipline source does not configure a separate model-proxy service. This note does not claim that Pi, model providers, extensions, MCP servers, or update services never log information they receive; consult each service’s terms.

## 工作流与生成代码 / Workflows and generated code

工作流定义、节点参数、运行输入/输出、日志和历史事件保存在本机数据库中，可能包含用户提供的业务数据。M0–M6 中 AI 生成的节点源码仅作为候选元数据保存；没有受信执行器的节点会在运行前被拒绝，不会因为保存或批准模板而执行任意源码。

Workflow definitions, node parameters, run inputs/outputs, logs, and historical events are stored in the local database and may contain user-provided business data. In M0–M6, AI-generated node source is stored only as candidate metadata. Nodes without a trusted executor are rejected before a Run; saving or approving a template does not execute arbitrary source code.

## 卸载、备份与删除 / Uninstall, backup, and deletion

- Pi 配置/会话和工作区文件位于安装目录之外；卸载 Pipline 不应被视为删除这些数据的操作。Pipline app-data 与配置目录也与程序安装目录分开。删除前请关闭应用并备份需要保留的工作流数据库。
- Pi settings/sessions and workspace files live outside the installation directory; uninstalling Pipline should not be treated as deleting them. Pipline app-data and config directories are also separate from the program installation. Close the app and back up the workflow database before deleting data you want to keep.
- 若要重置 Pi 的配置和会话，应按 Pi 的管理方式处理 `~/.pi/agent`；这也会影响使用同一目录的其他 Pi 客户端。若只要移除 Pipline 工作流数据，应单独备份后移除 app-data 中的 `picot.sqlite3`。配置目录内的终端/UI 状态可按需单独删除。
- To reset Pi settings and sessions, manage `~/.pi/agent` through Pi; doing so also affects other Pi clients sharing that directory. To remove only Pipline workflow data, back up and separately remove `picot.sqlite3` from app-data. Terminal/UI state files under the config directory can be deleted separately if desired.

## 第三方声明 / Third-party notices

安装包内包含 Pi Runtime、前端、Rust 依赖与字体的第三方许可证及 SBOM 材料。索引和声明见 [`licenses/README.md`](../licenses/README.md)、`licenses/pi-runtime/0.85.1/THIRD_PARTY_NOTICES.md`、`licenses/cargo/` 和 `public/vendor/licenses/THIRD_PARTY_NOTICES.md`。生成的运行时声明不是对每项依赖的法律审查。

Installers include third-party license and SBOM materials for the Pi Runtime, frontend, Rust dependencies, and fonts. See [`licenses/README.md`](../licenses/README.md), `licenses/pi-runtime/0.85.1/THIRD_PARTY_NOTICES.md`, `licenses/cargo/`, and `public/vendor/licenses/THIRD_PARTY_NOTICES.md`. Generated notices are not a legal review of every dependency.
