# Pipline 工作流基础节点参考与落地分期

> 来源：用户提供的 16 类工作流节点 Meta JSON、实例 JSON 与 TypeScript 示例。
>
> 本文把示例作为能力清单和交互参考；不把示例代码、字段命名或执行上下文当作已确定的运行时 API。所有节点必须映射到《PIPLINE最终技术方案.md》的版本化 `WorkflowNodeMeta`、节点实例、权限和 Run 模型。

## 1. 节点清单与计划归属

| 参考节点 | 目标能力 | 开发计划 | 首发处理 |
| --- | --- | --- | --- |
| Start 开始 | 定义一次 Run 的外部输入 | M3 定义/渲染；M4 执行 | MVP 必需；每个 workflow 恰好一个 Start，输入按 schema 校验 |
| End 结束 | 汇总工作流最终输出 | M3 定义/渲染；M4 执行 | MVP 必需；允许明确建模多个终止分支，默认模板提供一个 End；支持保留 JSON 值或转成文本 |
| LLM 大模型 | 生成文本或结构化结果 | M3 定义/渲染；M4 Pi Agent executor；后续扩展 | 首发以 Pi Agent 节点调用 Pi 当前模型/会话能力；不硬编码 `gpt-4o-mini`，也不假设存在 `ctx.llm.chat` |
| Code 代码 | 用户自定义 TypeScript 变换 | M5 以后单独安全评估 | 节点模板可作为设计参考；首发不执行任意源码，不调用示例中的 `ctx.sandbox.compile` |
| Condition 条件分支 | 根据数据选择执行分支 | M3 定义/配置；M4 调度 | MVP 采用受限声明式条件；禁止 `eval`/任意表达式源码；调度器负责未选分支的 skip 状态 |
| Loop 循环 | 遍历集合并重复执行子图 | 后续高级调度阶段 | 不进入首发基础调度；需先确定循环体子图、并发/顺序、最大迭代与取消语义 |
| Assign 变量赋值 | 生成或重命名数据字段 | M3 定义/渲染；M4 执行 | MVP 内建纯数据节点 |
| SubWorkflow 子工作流 | 在父流程中调用已保存流程 | 后续高级调度阶段 | 延后；需冻结子流程 revision、定义输入输出映射、调用深度和递归防护 |
| Knowledge 知识库检索 | 从知识源检索片段 | 外部集成阶段 | 延后；先明确知识源、索引、访问控制、引用与数据保留策略 |
| HTTP 请求 | 调用外部 HTTP API | 后续受控集成阶段 | 首发不默认开放任意 URL；需域名 allowlist、DNS/IP 防护、超时/响应体上限及凭证引用 |
| MCP 工具 | 调用已配置 MCP server 的工具 | M8 安全集成阶段 | 不进入 M0–M6 首发节点；后续仅可用 Pi 当前用户已配置且授权的 MCP 工具，调用前执行 Pi/用户权限策略，不接受模型任意 server/credential |
| Sleep 延时 | 延后继续执行 | 后续调度阶段 | 首发延后；需要可取消等待、重启恢复和最大等待时间 |
| Merge 多输入合并 | 汇聚并按策略合并多路数据 | M3 定义/渲染；M4 执行 | MVP 支持显式策略（对象键冲突策略、数组拼接/按端口对象）；不得隐式覆盖 |
| Filter 数组过滤 | 按受限条件筛选数组 | M3 定义/渲染；M4 执行 | MVP 采用声明式谓词和类型校验，不执行字符串表达式 |
| Extract 数据提取 | 从对象/数组按路径取值 | M3 定义/渲染；M4 执行 | MVP 内建纯数据节点；路径语法固定并对缺失值定义行为。新建节点使用 `pipline.extract@2.0.0`，`source` 接受 JSON 值并支持对象字段/数组下标；`1.0.0` 保留给历史工作流，目录隐藏 |
| Template 文本模板 | 插值生成文本 | M3 定义/渲染；M4 执行 | MVP 支持纯文本插值；默认转义/缺失变量行为明确，不执行模板脚本 |

## 2. 与规范数据模型的适配

- 节点模板采用 `WorkflowNodeMeta`：`schemaVersion`、不可变 `version`、`execution.kind`、`permissions` 与类型化端口/参数。参考 JSON 的 `runnableCode` 可用于说明节点意图，但不作为首发 executor 的源码载体。
- NodeMeta 的 ID、端口/参数名、对象 schema 属性名及 option value 最多 128 个 Unicode 字符；可见 label 最多 256 个字符、description 最多 4,000 个字符。四语翻译沿用对应文本限制，前端与 Rust Host 均验证。
- 参数字段统一为规范的 `defaultValue`；参考中的 `default` 在导入/转换时显式迁移。模板 id 和实例 id 分离，工作流实例引用精确的 `metaId + version`。
- 参数执行采用统一默认值物化：实例显式填写值优先，否则使用该模板版本的 `defaultValue`；完整性校验也把有效默认值视为满足 required。默认值来自版本化模板元数据，不把 UI 占位显示误当作实例已保存值。
- Extract/Filter/Template 的固定路径访问只遍历 JSON 对象自有字段与有效数组下标；原型链属性、非法/空路径片段和越界数组下标均按缺失处理。`pipline.extract@2.0.0` 可从对象字段或数组下标开始读取；`1.0.0` 的 object-only 输入仅为既有工作流保留，不再作为新建模板。
- `pipline.template@1.0.0` 将缺失路径和 `null` 插值为空文本；字符串原样插入，其他 JSON 值紧凑序列化。插入值不会被再次解析为模板表达式；Template 产物是纯文本，不做 HTML 转义或脚本执行，下游 UI 必须按文本或经净化的 Markdown 显示。
- 边 `WorkflowEdge` 是连接的唯一真值。实例不再同时保存一份重复的 `portValues.mode=link`；静态值由输入绑定保存，链接由 edge 派生。保存前需拒绝静态值与连接冲突，除非该端口显式定义合并策略。用户为已填静态值的输入建立连接时，编辑命令会原子移除被连接覆盖的静态绑定；读取历史草稿/Run 时也按既有的“连线优先”执行语义清理旧的遮蔽值。
- `multi: true` 端口的 `type` 声明所有上游值聚合后的数组类型，数组 `items` 声明每条连接各自必须匹配的类型；静态输入同样是聚合数组。执行器收到的 linked/static 输入都按这个完整数组 schema 校验。
- Start 的输入 schema 定义 Run 的外部入参；每次运行快照带经校验的 workflow input。End 将绑定输入写入 Run 最终输出，不通过节点源码修改全局上下文。
- 首发 Start schema 使用有界的递归 JSON 配置：`properties` 定义字段，`required` 定义必填项；字段可用简写类型，也可用 `{ "type": "object", "properties": {...}, "required": [...] }` 或 `{ "type": "array", "items": ... }` 描述嵌套对象和数组元素。前端工作流契约与 Rust Host SQLite create/CAS 均先验证 schema 结构，Run 创建与执行阶段再校验实际字段类型及必填项；未声明字段允许通过。深度最多 16 层、每个对象最多 256 个字段、总字段最多 1024；不支持字段默认值、`additionalProperties`、格式/范围约束或完整 JSON Schema。
- 运行输出、日志和错误放入 `WorkflowRun` / `WorkflowRunNode`；Run 同时冻结其引用的 NodeMeta 定义，重跑/续跑优先使用 Run 自带定义，避免模板目录变化改写历史运行语义；不把 `runtime` 写回模板，也不让持久化的 workflow 草稿承载某次运行状态。
- 端口类型支持递归 array/object schema；schema 校验、默认值物化和端口类型兼容由同一 validator 实现。无 schema 的 `any` 只用于 Start/End 等有意开放的边界，不作为默认类型。

- Condition/Filter 的 exists 按值是否缺失判断：显式 JSON null、false、0 和空字符串都属于已存在值；只有无法解析的路径（内部结果为 undefined）不匹配。
- 新建 Condition 使用 `pipline.condition@2.0.0`，支持可选固定字段路径；路径留空时比较整个输入值。`pipline.condition@1.0.0` 保留给历史 workflow/Run 快照并从新建节点目录隐藏，不能改写其既有执行语义。`exists` 对路径结果按上一条缺失值契约判断。

## 3. 安全与执行边界

- 示例中的 `ctx.evalExpr`、`ctx.sandbox.compile`、`ctx.llm.chat`、`ctx.mcp.call`、`ctx.jsonPath.query` 和 `ctx.setWorkflowResult` 都是示意 API，不是当前 Pi RPC 或 Pipline 已存在的接口。每项能力进入执行计划前必须定义版本化 executor contract 和权限来源。
- Pi Agent 节点通过 Pipline 管理的 Pi runtime 执行，并复用 Pi 已配置模型、扩展和 MCP 能力。Pi 节点的内部 tool call 显示在节点运行详情/桌面对话，不自动变成外层 DAG 节点。
- Condition/Filter 只接受限定操作符、字段路径和 JSON 常量组成的声明式表达式树；限制深度、操作数量和输入大小，不运行 JS 字符串表达式。
- `equals` / `notEquals` 对 JSON 值按结构比较：对象键顺序不影响结果，数组按长度和顺序逐项比较；不得使用 JS 对象引用相等判断 JSON 参数。DAG 分支下游在所有入边前驱完成后判定：有任意激活入边则解析活动端口并执行（必需端口缺值交由输入校验报错），只有所有入边都未激活才标记 skipped。此规则使多路 Merge 可汇合被选分支，且未选分支不触发下游节点。
- HTTP 节点默认网络权限为 none；用户显式为节点配置 allowlist 后才开放。执行时阻断 loopback、私网、link-local、云元数据地址及重定向绕过，并限制 DNS 解析目标、超时和响应大小。凭证存 credential reference，不进入 workflow JSON 或 Pi 上下文。
- MCP 节点只能引用已配置 server/tool 标识；敏感工具依 Pi/用户授权策略审批。不要把 server URL、API key 或任意可执行命令从节点参数传入。
- Code 节点的源码字段不代表可安全执行。首发不执行 AI 生成或用户提交的任意源码；未来须先设计 OS 级低权限隔离、文件/网络限制、资源上限、凭证隔离和审计，`isolated-vm` 单独不足以构成安全边界。
- Loop、SubWorkflow、Sleep 会引入等待、嵌套运行、取消与恢复语义；在调度器状态机和重启恢复策略成熟前不得作为可运行内建节点发布。

## 4. 建议首发模板库

### M3：可视化可编辑、暂不执行

- Start、End、Pi Agent、Assign、Template、Extract、Merge、Filter、Condition 的模板版本、端口、参数表单、权限声明和示例。
- 节点模板自带 schema 校验与静态端口定义；所有工作流变更通过 Workflow Service revision 命令流。

### M4：允许执行的首批节点

- Start、End、Assign、Template、Extract、Merge、Filter、Condition、Pi Agent。
- 执行快照固定模板版本、参数、输入和边；受限条件分支产生确定的 skipped 节点状态。
- HTTP、MCP 只有完成权限策略、密钥引用和请求限制后再单独开放；Code、Loop、SubWorkflow、Knowledge、Sleep 不纳入首发执行验收。

### M5：Agent 组合与 NodeMeta 候选

- Agent 从模板库检索并拼装工作流草稿；缺少能力时提出 NodeMeta 候选，但候选默认不执行。
- 新生成的 Code/源码类 NodeMeta 仅保存为不可信候选，不获得执行能力。
- 新建自定义 NodeMeta 必须含 en/zh/es/ja 全量可见文案（节点/端口/参数/选项/说明）；机器 ID、端口名、参数名和 option value 保持稳定且不翻译。旧模板无翻译表时保留原文回退，后续可通过新的不可变版本补齐翻译。

### M7：高级控制流与子工作流（首发之后）

- Loop：先定义循环体子图模型、顺序/并发策略、最大迭代数、单次迭代状态、取消与重启恢复，再实现执行器。
- SubWorkflow：固定被调用工作流的 revision 和 NodeMeta 快照，定义输入/输出映射、最大调用深度、递归检测、失败传播与取消语义。
- Sleep：定义持久化等待截止时间、取消、应用重启后的恢复，以及允许的最大等待时长。
- 三类节点须完成调度状态机与持久化迁移设计，并在 Windows 10 / macOS 11+ 的目标环境验收后，才进入可运行节点库。

### M8：安全执行与外部集成（首发之后，按能力分开开放）

- Code：完成 Windows/macOS OS 级隔离 helper、文件/网络/凭证权限边界、CPU/内存/时间限制、进程生命周期与审计；仅当隔离和平台验证过关后，才允许执行不可信源码。TypeScript 转译成功或用户批准模板不等于源码安全。
- HTTP：实现显式域名 allowlist、DNS/IP 与重定向防护、超时和响应体限额；凭证只通过安全引用传递。通过威胁建模和安全验收后再开放。
- MCP：只调用 Pi 当前用户已配置且已授权的 server/tool，复用 Pi 的权限确认；定义输入输出 schema、敏感操作提示、超时、取消和错误映射，不接受节点任意指定 server 或凭证。此项属于 M8，不是 M4/M5 首发交付。
- Knowledge：先确定支持的知识源、索引生命周期、workspace 隔离、访问控制、引用来源和数据保留策略，再实现检索节点。
- M8 的四类能力独立验收、独立启用，不把某一集成的通过视为其他节点也具备安全性。

## 5. 参考样例的实现前校正清单

1. 把示例节点结构迁移到规范的 `WorkflowNodeMeta`、`WorkflowNode`、`WorkflowEdge` 和 `WorkflowRun`，禁止两套并行 schema。
2. 为 Start/End、Condition、Loop、SubWorkflow 定义图语义：唯一入口、可达性、条件未选路径、循环子图和子流程调用边界。
3. 给每个可执行节点定义由宿主提供的最小 executor contract；节点不得直接访问任意文件、网络、数据库、Pi 凭证或进程。
4. 首批提交模板库前，逐项校验默认值/必填参数、输入输出类型、secret 标记、权限级别和错误/取消语义。
5. 示例位置和源码只供理解 UI/能力，不复制外部仓库代码；不依赖 AGPL `pi-harness`。
6. M7/M8 是首发后的规划，不阻塞首发九类节点；不得把尚未完成的平台隔离、权限或恢复语义降格成普通 NodeMeta 参数后提前发布。

## 6. 用户样例字段与当前契约的差异核对

以下核对用于开发计划的 M3/M4 逐节点验收。参考 JSON 描述期望交互，不代表对应字段已经一一进入当前 schema 或已有 executor 行为。

| 示例中的字段/行为 | 当前处理与需要落实的计划 |
| --- | --- |
| `id`、`type`、`label`、`description`、`inputs`、`outputs`、`params` | 转换为版本化 NodeMeta；实例用独立 instance id 引用精确的 `metaId + version`。核对模板目录、节点面板与画布端口使用同一份定义。 |
| `runnableCode` / `entryFn` | 不直接执行示例源码。内建节点映射到应用内受信、版本化 executor；自定义代码按 M8 安全执行门槛处理。 |
| 实例中的 `position`、`paramValues`、`runtime` | `position` 属于 Workflow 实例持久状态；参数统一按版本化 `defaultValue` 物化；运行状态/日志/结果只属于 WorkflowRun，不写回模板或持久工作流草稿。 |
| 示例 `portValues.mode="link"` | 当前以 WorkflowEdge 作为连线唯一真值，静态输入与边不得同时覆盖同一输入端口；连线后链接值由边解析。 |
| Start `inputSchema` 和 `ctx.workflowInput` | Start 使用受限递归输入 schema：字段可直接使用 `string/number/boolean/object/array/any`，或用 `{ type: "object", properties, required }`、`{ type: "array", items }` 声明嵌套结构；Run 创建和执行时均校验类型及必填项，再经 Start 输出传递。未声明字段允许；不支持默认值、`additionalProperties`、格式/范围约束或完整 JSON Schema；schema 深度最多 16 层、每个对象最多 256 个字段、总字段最多 1024 个。 |
| End `returnMode` (`variable`/`text`) 与 `ctx.setWorkflowResult` | End 的 `returnMode` 参数默认为 `variable`：Run 结果保留绑定输入的 JSON 类型和值；`text`：字符串原样返回，其他 JSON 值紧凑序列化为文本。每个 End 的变换后值作为该分支结果，多个成功 End 的结果按工作流节点顺序组成数组。不调用示例 `ctx.setWorkflowResult` API。 |
| Merge 多路输入聚合 | `pipline.merge@2.0.0` 保留原有按顺序收集语义；`pipline.merge@3.0.0` 的 `in0` 接受 `multi` 聚合数组，`mode=collect` 按连线顺序收集各值，`mode=concatenate` 要求每个值是数组并按连线顺序拼接。`pipline.merge-by-port@1.0.0` 声明四个固定命名输入组 `input0..input3`，每组接受多条连线并输出同名数组属性，未绑定组返回空数组。`pipline.merge@1.0.0` 是独立对象合并模板，显式选择重复键 `error/first/last`。|
| Assign `value`、`varName` 与 `ctx.setVar` | 新建模板使用 `pipline.assign@2.0.0`：`value` 可从静态值或上游连线取得，`varName` 是必填字段名，输出对象为 `{ [varName]: value }`。不写入隐式全局变量，便于沿端口追踪数据。旧 `pipline.assign@1.0.0` 继续供已有工作流/历史 Run 使用，目录中隐藏。 |
| LLM `model`、`temperature`、`ctx.llm.chat` 和 JSON 双输出 | `pipline.pi-agent@2.0.0` 复用当前 Pi 模型、会话、扩展和工具，不增加模型/温度选择；保留 `content` 文本输出，并在响应为 JSON 对象时填充可选 `json` 输出。仅当 `json` 端口有下游连线时，附加提示要求 Pi 返回无 Markdown 包裹的 JSON 对象；解析失败时文本响应仍成功、JSON 端口为空。v1 保留既有语义并从新建目录隐藏。 |
| Code `codeSource`、`ctx.sandbox.compile` | 候选源码仅可保存为不可信元数据，M5 编译只作转译/错误检查，不代表安全执行；M8 OS 级隔离和两平台验收前不允许运行。 |
| `NodePort.allowStaticValue` | 若模板字段允许静态值，须由画布表单提供静态编辑；若不允许，提交/存储 validator 必须拒绝，不能只作为展示提示。 |
| `NodeParam.default`、`required`、`options` | 导入时映射到规范 `defaultValue` 并校验类型；显式实例值优先，缺省才使用模板默认值；select 默认值必须属于 options。 |

这张表和第 1 节的 16 类节点映射共同构成计划追踪入口：M3 核对 schema/编辑表单/绑定，M4 核对 executor/分支/Run 结果，M5 核对 Agent 读写和候选生成；M7/M8 能力仍按其专属安全及调度门槛延后。
