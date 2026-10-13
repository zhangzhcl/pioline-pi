# Pipline 最终技术方案

> 产品定位：基于 Pi Coding Agent 的桌面编码工作台，并提供可选的工作流观测、生成与编排能力。
>
> 核心目标：普通对话和编码保留 Pi 原有 Agent、工具、会话与扩展能力；用户明确启用工作流后，Pi 对话与可视化画布围绕同一份工作流状态协作。
>
> 许可目标：自有代码可闭源分发，尽量采用 MIT 依赖；不引入 `wangmiaozero/pi-harness` 的源码或依赖。发行前逐项审核完整依赖树与附带资源，不把“直接依赖是 MIT”当作全链路许可结论。

## 1. 最终结论

方案可落地。关键是将 Pipline 设计为 **Pi 桌面宿主 + 工作流控制层**：Pi 仍负责 Agent 推理、编码工具和会话；Pipline 把 Pi 的会话与工具事件映射成桌面 UI，并在工作流模式下额外提供节点库、画布、结构化工作流工具和 DAG 调度器。

Pi 不需要理解 React Flow，也不负责调度整个 DAG。工作流模式下，Pi 通过 Pipline 提供的结构化工具读取、提议和修改工作流；Pipline 校验修改并更新共享状态。调度器负责执行工作流节点；Pi 作为其中一种 Agent 节点运行内部编码任务。

## 2. 用户体验与模式

### 2.1 普通会话模式（默认）

- 主界面提供项目工作区、会话列表、Pi 消息流、工具调用卡片、日志与文件差异视图。
- 使用 Pi 原生 AgentSession 或官方 RPC 接口，保留模型、工具、会话持久化、扩展、MCP 等 Pi 能力。
- UI 将 Pi 事件渲染为消息和状态组件，包括思考/文本流、工具开始、工具增量输出、工具结束、错误及回合完成；敏感内容遵守脱敏策略。
- 默认不加载工作流画布代码、不附加工作流系统提示词、不建立工作流 run、不执行工作流逻辑。
- 普通对话可采集通用会话事件用于 UI，但不将普通工具调用自动解释为 DAG 节点。

### 2.2 工作流模式

用户可通过两种方式启动：在 UI 中手动开启，或在对话中明确提出“用工作流处理”等意图。对话触发时，Pi 可调用 `enter_workflow_mode` 之类的 Pipline 工具；用户确认后，Pipline 开启工作流上下文并加载画布。不要只依赖关键词分类自动执行：模糊请求先由 Pi 询问或提示用户确认。

工作流模式包括三种协作状态：

1. **需求转流程**：Agent 根据需求搜索现有节点，提出节点选择、参数和连线方案；缺少能力时可生成新节点候选。校验后画布实时显示草稿，用户可在对话中继续修改。
2. **人工编排**：用户可在画布拖拽、连线、改参数、替换节点。每次编辑写入共享工作流状态，并产生有序变更事件，使 Agent 在后续对话中能理解具体变更。
3. **执行与观测**：提交后产生不可变运行快照，由调度器执行。运行中锁定结构性编辑（或先分支编辑为新草稿）；画布展示每个节点的状态、输入输出、日志和错误，对话可解释状态、排查失败和提出修复。

用户可暂停工作流会话或关闭画布。离开画布不终止运行；再次打开时恢复同一 workflow/run。退出工作流模式不会破坏 Pi 会话。

## 3. 进程与模块架构

### 随包 Pi Runtime 与最低系统版本

- Windows 10 x64 继续随包使用官方 Pi 0.85.1 编译版 `pi.exe`。
- 官方 Pi 0.85.1 macOS 编译版的最低系统版本是 macOS 13，不能用于本产品的 macOS 11.0+ 目标。macOS 包改用 Pi 官方 npm 发行文件的 CLI/RPC 入口，并随包携带官方 Node.js 22 LTS Runtime；通过 `pi` 启动脚本仍以 `pi --mode rpc` 启动相同 Pi CLI，不依赖用户安装 Node/Bun。
- Node.js 22.23.3 arm64 与 x64 官方发行归档均以 SHA-256 锁定；构建时校验 Mach-O 架构、macOS 最低版本、Pi-TUI/clipboard 原生 addon 架构与系统版本，避免包内任一 Pi Runtime Mach-O 高于 macOS 11.0 门槛。Pi/npm 依赖 lock 与 Node LICENSE/SBOM 分开归档。
- Pi 官方 Node 入口要求 Node.js >=22.19.0。这里的 Node 仅承载 Pi；工作流候选源码依然不可执行，也不以 Node Permission Model 作为代码沙箱。

```text
┌────────────────────────── Tauri Desktop ──────────────────────────┐
│ React UI                                                          │
│  普通工作区：会话 / 流式消息 / 工具卡片 / 文件 diff               │
│  工作流页：按需加载 @xyflow/react，编辑、观测、属性面板            │
├───────────────────────────────────────────────────────────────────┤
│ Rust Host                                                         │
│  窗口与项目管理 / Node 子进程生命周期 / 权限入口 / 事件转发         │
│  SQLite（工作流元数据、运行记录；Pi 会话存储按选定策略管理）         │
├───────────────────────────────────────────────────────────────────┤
│ TypeScript Runtime（受监督的本地子进程）                           │
│  Pi Adapter ─ Pi AgentSession 或 `pi --mode rpc`                   │
│  Workflow Service ─ 共享状态、版本、命令、事件                     │
│  Validator ─ Schema、端口、DAG、权限校验                           │
│  Scheduler ─ 运行快照、依赖调度、取消与恢复                         │
│  Node Registry ─ 内建节点、Pi Agent 节点、已审核自定义节点          │
└───────────────────────────────────────────────────────────────────┘
```

**建议起步边界：Rust Host + TypeScript Runtime 子进程 + 版本化 JSON IPC。**Pi SDK 属于 TypeScript/Node 生态，不在 Rust 或 WebView 内直接执行。由 Rust 监督 Runtime，Runtime 调用 Pi SDK；UI 通过 Tauri 命令或本地 IPC 消费结构化事件，不将 Pi SDK 对象直接暴露给前端。

Pi 接入在阶段 0 通过技术验证后择一确定：

- 同进程 SDK：Runtime 内调用 `@mariozechner/pi-coding-agent` 的 `createAgentSession()`，用 `AgentSession.subscribe()` 获取类型化事件，扩展灵活。
- RPC 子进程：由 Runtime 启动 `pi --mode rpc`，适合显式进程隔离和协议解耦。

不要同时实现两套生产路径。根据会话恢复、扩展兼容、工具事件完整度、凭证复用、Windows/macOS/Linux 打包结果做决定。Picot 已有 Tauri/Rust Host、Pi RPC 与前端通信实现，可作为 fork 候选；采用前先审查其架构、扩展方式、Pi 版本与平台支持，避免重复建设。Picot 声明 MIT。

### macOS 11 WebView 兼容底线

- 以 macOS 11.0 自带的 WKWebView 为语法/API 基线；不得假定用户的 Safari/WebKit 已通过后续 Safari 更新升级。
- `scripts/build-frontend.js` 将实际浏览器源码模块镜像转译到 Safari 14 兼容目录，并把 vendor bundle 以 Safari 14 为目标构建；应用入口不得依赖 Safari 15 才支持的顶层 `await`。
- Import Maps 通过本地打包的 MIT `es-module-shims` 支持，连同许可证一起放入安装包；首启不联网下载兼容代码。
- 首屏兼容脚本提供缺失的 `structuredClone`、`Object.hasOwn` 与 `Array.prototype.at`；CSS 不依赖 Safari 15.4 才加入的 `:has()`。
- 修改浏览器 API 或依赖版本时，重新核对 macOS 11 WebKit 支持；原生 Mac 11 构建/运行验收按项目里程碑执行，当前不宣称通过。

## 4. Pi 事件到桌面 UI

建立自有 `PiAdapter`，只消费 Pi 实际提供的会话和工具事件，转换为稳定的 Pipline UI 事件，例如：

```ts
type PiUiEvent =
  | { type: "assistant.delta"; sessionId: string; delta: string }
  | { type: "assistant.message"; sessionId: string; messageId: string; content: unknown[] }
  | { type: "tool.started"; sessionId: string; callId: string; name: string; input: unknown }
  | { type: "tool.updated"; sessionId: string; callId: string; update: unknown }
  | { type: "tool.finished"; sessionId: string; callId: string; result: unknown; isError: boolean }
  | { type: "turn.started" | "turn.finished"; sessionId: string }
  | { type: "session.error"; sessionId: string; code: string; message: string };
```

实际事件字段必须按所锁定 Pi SDK/RPC 版本定义，不依赖假定的 `onSubtaskSpawn` 等 API。UI 负责显示内容和状态，不承担 Agent 生命周期或调度。

若需显示 Pi 子 Agent/子任务拓扑，必须有能关联父子关系的真实标识。Pi 基础事件若不提供该语义，Pipline 可通过自有扩展/自定义工具记录 `taskId`、`parentTaskId` 与生命周期，再绘制任务树。不得把时间顺序或任意 tool call 猜成依赖 DAG。

## 5. 工作流共享状态：让 Agent 知道“正在干嘛”

这是交互闭环的核心。对话、画布、节点仓库和执行器围绕一份由 Workflow Service 管理的规范状态，不各自保存互相冲突的副本。

- UI 每次画布编辑提交结构化命令，如 `AddNode`、`ConnectPorts`、`SetParam`、`MoveNode`、`RemoveNode`。
- Agent 通过 Pipline 注册给 Pi 的工作流工具读取当前工作流摘要/节点详情、查找节点模板、提议编辑、请求验证、启动运行、查询运行结果。读取前等待本地待提交命令后刷新 Host 权威 revision/事件记录；revision 冲突时返回重读提示，不能从某个 WebView 的缓存宣称图状态为最新。
- Agent 的改动必须以结构化命令提交到 Workflow Service；经过校验后广播给画布。模型不得直接写数据库或自由拼接 React Flow 内部状态。
- 变更带 `workflowId`、`revision`、`actor`（user/agent）、时间和命令；Agent 基于 revision 修改，发生冲突则读取最新状态并重试或请用户裁决。
- NodeMeta 目录 revision 由 Host 根据 SQLite 中排序后的模板 `id/version` 集合生成；列表操作返回该 token。保存新模板与 Agent 图 CAS 必须提交读取时 token，Host 在同一存储锁内核对目录版本，避免跨窗口事件广播延迟期间按旧节点目录写入。
- 工作流运行创建 `runId` 并冻结 workflow revision、节点模板版本、参数与连线，调度和 UI 均使用同一快照。
- 工作流事件以有序事件流同步给 UI 和 Agent；大日志或大输出保存在存储中，事件只携带引用/摘要。Pi 读取工作流时，除当前图/运行状态外返回最近 12 条画布操作摘要（角色、revision、时间、结构化命令）；参数/输入值不进入编辑历史摘要，Agent 需要当前值时读取当前图状态。摘要应有硬数量和字段长度上限。

建议工作流工具最小集合：

```text
workflow.get_summary()
workflow.get_node(instanceId)
workflow.search_node_templates(query)
workflow.propose_changes(baseRevision, operations[])
workflow.validate()
workflow.run(options)
workflow.get_run(runId)
workflow.cancel(runId)
```

对执行类操作（运行、删除大量节点、修改正在运行的结构）保留 UI 确认门槛。Agent 可先生成草稿并解释变化，再由用户接受。

**当前首版接口实现边界：**`pipline_workflow` Pi 原生工具仅在手动工作流模式开启时启用；支持按能力查询 `search_node_templates(query)`、分页读取当前图/节点目录/运行状态和最近画布变更，以及用 `baseRevision` 与 `expectedCatalogRevision` 提交 `add_node`、`connect`、`move_node`、删除、设参和静态输入等有限操作。节点搜索只返回有界的本地化能力摘要；变更摘要不包含参数/输入的实际值。Host 不接受模型直接写库，前端先按可信 NodeMeta 校验提案，再向用户展示完整操作并确认，随后以一个 revision/CAS 批次写入。NodeMeta 候选生成和跨客户端广播已接入首版；新建自定义 NodeMeta 必须提供 en/zh/es/ja 完整显示文案，旧模板可继续读取并以原始文案回退显示。Agent 直接启动/取消 Run 仍属后续开发项。

## 6. 节点和工作流数据模型

节点模板是可复用能力定义；画布实例存放位置、参数和输入绑定；运行记录保存实际输入输出和状态。三者分离，避免编辑态被执行状态污染。

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type ValueType =
  | { kind: "string" | "number" | "boolean" | "any" }
  | { kind: "object"; schema?: Record<string, unknown> }
  | { kind: "array"; items: ValueType };

interface PortDef {
  name: string;
  label: string;
  type: ValueType;
  required: boolean;
  multi?: boolean;
  allowStaticValue: boolean;
  description?: string;
}

interface ParamDef {
  name: string;
  label: string;
  type: ValueType | { kind: "select"; options: { label: string; value: string }[] };
  required: boolean;
  defaultValue?: JsonValue;
  description?: string;
  secret?: boolean;
}

interface WorkflowNodeMeta {
  schemaVersion: 1;
  id: string;
  version: string; // 不可变版本，例如 1.0.0
  type: string;
  label: string;
  description: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  // Optional for legacy templates. New custom templates provide complete
  // en/zh/es/ja display text; IDs and execution contracts stay language-neutral.
  i18n?: Record<"en" | "zh" | "es" | "ja", {
    label: string;
    description: string;
    inputs: Record<string, string>;
    outputs: Record<string, string>;
    params: Record<string, {
      label: string;
      description?: string;
      options?: Record<string, string>;
    }>;
  }>;
  execution: {
    kind: "builtin" | "pi-agent" | "user-code";
    entrypoint?: string;
    sourceRef?: string;
  };
  permissions: {
    filesystem: "none" | "workspace";
    network: "none" | "allowlist" | "unrestricted";
    shell: "none" | "restricted" | "unrestricted";
  };
  // Custom-node source/artifact are inert metadata until a sandboxed executor is enabled.
  implementationDraft?: {
    language: "typescript";
    source: string;
    entryFn: string;
    compilerVersion?: "esbuild-wasm@0.28.0";
    compiledSource?: string;
  };
}

type InputBinding =
  | { mode: "static"; value: JsonValue }
  | { mode: "links"; edgeIds: string[] };

interface WorkflowNode {
  instanceId: string;
  meta: { id: string; version: string };
  position: { x: number; y: number };
  paramValues: Record<string, JsonValue>;
  inputBindings: Record<string, InputBinding>;
}

interface WorkflowEdge {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

interface Workflow {
  schemaVersion: 1;
  id: string;
  revision: number;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

interface WorkflowRunNode {
  instanceId: string;
  status: "blocked" | "ready" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
  attempt: number;
  inputs?: Record<string, JsonValue>;
  outputs?: Record<string, JsonValue>;
  error?: { code: string; message: string };
  startedAt?: string;
  finishedAt?: string;
}
```

关键约定：

- 使用 Zod（或同等运行时校验器）校验所有持久化边界和 Agent 命令，不只校验 AI 生成的 NodeMeta。
- NodeMeta 的 machine ID、端口/参数名、对象 schema 属性名及 option value 最多 128 个 Unicode 字符；可见 label 最多 256 个 Unicode 字符，description 最多 4,000 个 Unicode 字符。四语 i18n 对应字段采用相同限制；前端 validator 和 Rust Host 存储边界必须保持一致，避免无界定义进入目录和 Agent 上下文。
- `WorkflowEdge` 是边的唯一真值来源；输入绑定不能再重复存一份独立 link。可在内存中从边派生绑定。
- 端口连接规则：必需输入必须有静态值或边；非 `multi` 输入最多一条边；静态值与边默认互斥。需要优先级/合并时，做成显式策略。
- `multi: true` 表示端口类型是所有连线值汇总后的数组类型，`items` 是单条连线的类型；静态值必须符合该数组类型，executor 收到的连线值也会按聚合数组 schema 校验。
- `array` 类型递归声明元素类型；数值、对象、数组校验应有明确规则。初期 `any` 只用于内部通用节点，避免滥用。
- 参数默认值在创建实例时物化，便于复现；schema 或默认值升级不悄悄改变既有工作流。
- 模板版本不可变，模板更新生成新版本；工作流引用精确版本。执行快照包含所有节点 meta/参数/边的确定性副本。
- Run 持久化实际引用的版本化 NodeMeta 副本；历史重跑与续跑从 Run 副本恢复校验和参数语义，不依赖当前模板目录仍保留旧版本。
- secret 参数只保存 credential reference，不把密钥放进工作流 JSON、AI 上下文、运行日志或普通事件。
- 运行状态属于 `WorkflowRun` / `WorkflowRunNode`，不写回模板定义。
- Schema 版本迁移要显式且可回滚；SQLite 存放用户工作流、节点元数据索引、run 元数据和事件引用。
- `search_node_templates` 按当前语言、其他已保存翻译与机器键搜索，并返回有界能力摘要；NodeMeta 目录 revision 随结果返回，后续提案必须携带并在用户审批后再次核验。

基础节点参考清单、首发取舍、执行安全约束和分期见[《Pipline 工作流基础节点参考与落地分期》](./PIPLINE工作流基础节点参考.md)。用户提供的 16 类节点示例是能力参考，落地时统一转换为本节 `WorkflowNodeMeta`/`WorkflowNode`/`WorkflowEdge`/`WorkflowRun` 契约；不照搬其 `runnableCode`、`portValues` 或未定义的 `ctx.*` 执行 API。

## 7. 验证与调度规则

每次保存/运行前验证：节点模板与版本存在；端口存在且方向正确；端口类型兼容；必需输入有值；单值端口没有多条连接；参数符合 schema；无环路；执行类型与权限策略受支持。

MVP 调度器采用确定规则：冻结快照 → 对 DAG 拓扑排序 → 初始无依赖节点进入 ready → 按并发上限运行 → 校验输出 → 成功后解锁下游。第一版可采用全局 fail-fast；之后增加分支失败策略、重试与人工审批节点。取消 run 时传递 abort 信号并记录无法中断的外部工具状态。运行中结构性修改应创建新 revision，不改变当前快照。

Pi Agent 节点调用 Pi 处理该节点的输入并生成输出；内层的读写、bash、MCP 工具调用显示在该节点详情/桌面对话中，但不自动变成外层 DAG 节点。

## 8. AI 创建节点与安全策略

AI 生成节点流程：需求 → 查询节点库 → 若缺少则生成 NodeMeta 候选 → schema 校验 → 带源码时懒加载随包 MIT `esbuild-wasm@0.28.0` Worker 执行 TypeScript 语法转换并拒绝模块解析 → 用户审阅完整候选 → 保存为新模板版本 → 放入工作流草稿。编译只校验语法和生成 JS，不是安全检查；原始 TS 与固定版本编译产物均作为惰性元数据保存，首发候选不执行。

`source: string` 加 `isolated-vm` **不等于已建立充分安全边界**。Pi 的 bash、文件工具、MCP 和扩展代码也可能具有本地高权限。首期不执行 AI 生成的任意源码，只运行 Pipline 内建节点和 Pi Agent 节点。以后开放用户代码前，单独设计并验证低权限进程/容器隔离、workspace 文件访问白名单、网络策略、CPU/内存/超时限制、凭证隔离、审计和跨平台打包；isolated-vm 只能作为纵深防护的一部分，不能单独作为安全承诺。

运行前必须对整个不可变 Run 快照做 executor 完整性预检；只要有一个节点缺少受信 executor，就在持久化 queued Run 或调度任何节点之前拒绝整次运行，避免前序 Pi Agent 节点已产生副作用后才遇到不支持的自定义代码节点。

M5 自定义代码运行时决策、平台边界和阻止启用代码执行的门槛见 [ADR 0002](./docs/adr/0002-workflow-code-runtime.md)。现行 Node 24 macOS 官方二进制最低要求高于 macOS 11，且 Node Permission Model 本身不是恶意代码沙箱；因此产品不以系统 Node 或 Pi 可执行文件充当自定义代码 Runtime。

## 9. 依赖与许可决策

- Pi：`@mariozechner/pi-coding-agent`，使用其公开 SDK/RPC 与事件 API；锁定版本。
- 画布：`@xyflow/react`（React Flow 当前包名），仅工作流页面动态加载。
- 自定义 NodeMeta 源码转换：MIT `esbuild-wasm@0.28.0`，在工作流提案时懒加载；WASM 与其 MIT 许可证文本随安装资源分发。该转换器不执行用户代码，也不提供安全隔离。
- 桌面底座：Picot 可评估 fork；其仓库声明 MIT，fork 时保留版权和许可证文本。
- Schema：Zod（版本锁定并审核完整依赖树）。
- 存储：SQLite；确定 Rust 侧还是 Node 侧唯一写入者，避免两套迁移系统。
- `pi-harness-runtime`：**不作为 Pipline 必需运行时或事件适配器**。公开目录资料显示它是 Beta Pi 插件/自主编码 Harness，而非本方案所需的通用 DAG 转换 SDK；如未来评估，须独立审核源码、API、依赖、许可证和权限。
- `wangmiaozero/pi-harness`：不复制、不依赖、不将其源码纳入发行包。公开仓库标注 AGPL-3.0-only。

“可闭源分发”应通过发布时生成 SBOM、第三方许可证清单、Pi/Picot/插件资源来源记录和版本锁文件来持续证明。审核范围包括传递依赖、Native binaries、Tauri 插件、字体和图标。

## 10. MVP 里程碑与验收标准

### M0：架构与平台验证

- 选定 Picot fork 或自建 Tauri Host。
- Windows 上启动 Pi；验证消息流、工具事件、会话保存/恢复、停止/取消、扩展与凭证路径。
- 评估 SDK 与 RPC；记录选择、Node Runtime 打包策略和依赖许可证清单。

### M1：Pi 桌面工作台

- 普通模式可完成真实编码会话，显示 Pi 文本和工具卡片，支持项目切换、历史会话、错误与终止。
- 工作流页面未打开时不下载/初始化 `@xyflow/react`，普通模式没有工作流 prompt 或 scheduler。

### M2：共享工作流草稿与观测画布

- 定义版本化 Workflow/NodeMeta/事件协议。
- 用户手动开启工作流，画布能显示结构。
- Agent 可读取工作流、提出变更；用户和 Agent 的更改都进入相同 revision 流，互相可见。
- Pi 普通工具活动与工作流节点区分呈现；只对有真实父子 ID 的任务绘制拓扑。

### M3：保存与可视化编排

- 节点模板库、工作流保存/加载、端口和参数表单；登记 Start、End、Pi Agent、Assign、Template、Extract、Merge、Filter、Condition 元数据与属性表单。
- Zod 校验、端口校验、DAG 环路检测、revision 冲突处理。
- 用户画布编辑后能在对话中让 Agent 准确说明节点、参数和连线。

### M4：安全可控的执行

- 首批可运行节点：Start、End、Assign、Template、Extract、Merge、Filter、受限声明式 Condition、Pi Agent；Run 快照可重放、取消、报错。Pi Agent v2 保留文本输出并提供可选 JSON 对象输出；下游连接 JSON 端口时提示 Pi 返回纯 JSON 对象，解析失败时仍保留文本结果。
- Code、Loop、SubWorkflow、Knowledge、Sleep 不进入首发执行验收；HTTP/MCP 需单独完成权限、凭证引用和网络/工具调用限制后再开放。
- 画布显示运行状态和节点输入输出；Agent 可读取运行状态并解释失败。
- 首版不执行任意模型生成源码。

### M5：AI 节点生成与扩展运行时

- Agent 生成并验证候选 NodeMeta，用户审阅后保存；候选默认不可执行，首发不运行 AI 生成源码。
- 再基于明确威胁模型和平台矩阵决定是否开放用户代码沙箱。

## 11. 主要风险及对应措施

| 风险 | 处理方式 |
|---|---|
| Pi SDK/API 演进 | 锁定版本；PiAdapter 隔离 SDK 类型；升级时跑兼容验证 |
| Pi 没有通用子任务生命周期事件 | Pipline 扩展对自建子 Agent 工具增加 task/parent ID；不猜 DAG |
| Agent 与画布状态不一致 | 单一 Workflow Service、revision、命令事件流；禁止 UI/Agent 直接改数据库 |
| AI 生成无效节点 | 结构化输出、Zod 验证、错误回传修复、人工审核 |
| AI 代码执行风险 | 初版不执行任意生成代码；后续按威胁模型实施 OS 级隔离 |
| 长任务中断/崩溃 | run 快照与事件持久化；恢复时识别未完成节点并要求重试或继续 |
| 桌面端打包复杂 | M0 优先验证 Node runtime、Pi 二进制、WebView/Tauri 跨平台发行 |
| MIT 声明过度 | 生成 SBOM 与许可证审查报告，覆盖传递依赖和附带资源 |

## 12. 最终决策摘要

1. Pi 是编码 Agent 和会话运行时；Pipline 是桌面宿主、事件 UI 与工作流控制面。
2. 普通模式尽量保持原生 Pi 行为，不加载工作流上下文和画布。
3. 工作流由明确意图或用户操作开启；Pi 通过结构化 Pipline 工具与工作流协作。
4. Agent、画布和调度器共享 Workflow Service 的同一版本化状态；Run 使用不可变快照。
5. React Flow 只负责可视化和交互；自研 validator/scheduler 负责语义与执行。
6. 只把真实可观测的 Pi 事件展示出来；子任务拓扑需明确关联 ID。
7. 先交付内建节点和 Pi Agent 节点；任意生成代码的沙箱留到后续独立安全阶段。
8. `pi-harness-runtime` 不承担当前方案设想的 DAG Event SDK 职责；AGPL Pi-Harness 源码不进入项目。
