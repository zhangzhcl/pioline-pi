# 模块拆解路线图与超大文件治理规范 (Module Split Plan)

本文档记录 Pipline 项目中超出 500 行护栏的超大文件治理成果、拆解责任边界及持续防护规范。

## 一、架构原则与硬性约束

1. **单一职责原则**：每个模块专注单一核心功能（例如：纯协议编解码、UI 事件总线、会话状态树、文件类型渲染），禁止因调用便利向既有文件堆砌无关逻辑。
2. **500 行代码护栏**：任何新功能或改动，凡涉及超过 500 行的既有文件，必须优先执行独立模块抽离，严禁单文件继续膨胀。全仓库所有业务源码、样式表、构建烟雾测试脚本（`scripts/`）、后端 Rust 集成测试与单元测试模块（`src-tauri/src/`）以及前端与扩展单元测试文件（`public/`、`extensions/`）均 100% 严格控制在 500 行以内，并由 `scripts/module-guardrails.test.js` 自动守卫。
3. **编排入口薄门面化**：
   - 前端 `public/native/app.js` 作为 Composition Root，体积控制在 500 行护栏以内（当前 463 行），仅负责模块导入与顶层组装，业务逻辑下沉到 `public/native/` 各子领域。
   - 后端 `src-tauri/src/host_server.rs`（416 行）、`src-tauri/src/host_data.rs`（202 行）、`src-tauri/src/git_service.rs`（252 行）、`src-tauri/src/metadata_store.rs`（47 行）、`src-tauri/src/main.rs`（446 行）、`src-tauri/src/terminal_manager.rs`（373 行）、`src-tauri/src/skill_install.rs`（314 行）、`src-tauri/src/native_pi_manager.rs`（477 行）均已作为服务分发门面，内部实现下沉至对应子模块目录。
   - 扩展层 `extensions/picot-config.ts`（447 行）与 `extensions/chat-inbox/extension-entry.ts`（484 行）均已作为薄编排入口，模型目录、OAuth 设备码、设置存储及远程会话提示词构建下沉至独立子模块。
4. **禁止导入期附带副作用**：工具和业务模块应导出清晰的工厂函数、类或纯函数，严禁在模块加载（import）阶段隐式改变全局状态。

---

## 二、P0 核心入口拆解完成清单（全部达标 <500 行）

| 模块路径 | 重构前行数 | 当前行数 | 状态 | 下沉子模块归属 |
|---|---|---|---|---|
| `public/native/app.js` | 3,368 | 463 | 已完成 | `public/native/session/`、`public/native/workspace/`、`public/native/composer/`、`public/native/workflow/`、`public/native/acp/`、`public/native/features/`、`public/native/extensions/`、`public/native/transport/` |
| `src-tauri/src/host_server.rs` | 4,638 | 416 | 已完成 | `src-tauri/src/host_server/dispatch.rs`、`src-tauri/src/host_server/ws.rs`、`src-tauri/src/host_server/data_operations.rs`、`src-tauri/src/host_server/host_operations.rs`、`src-tauri/src/host_server/routes/mod.rs` |
| `src-tauri/src/host_data.rs` | 3,469 | 202 | 已完成 | `src-tauri/src/host_data/transcript_reader.rs`、`src-tauri/src/host_data/branch_tree.rs`、`src-tauri/src/host_data/sessions.rs`、`src-tauri/src/host_data/files.rs`、`src-tauri/src/host_data/cost_metrics.rs` |

---

## 三、P1 业务子系统拆解完成清单（全部达标 <500 行）

### 1. 前端代码库（`public/`）

| 优先级 | 文件路径 | 重构前行数 | 当前行数 | 状态 | 下沉子模块清单 |
|---|---|---|---|---|---|
| P1 | `public/native/settings/models-page.js` | 1,854 | 239 | 已完成 | `public/native/settings/models-catalog-rows.js`、`public/native/settings/models-config-editor.js`、`public/native/settings/models-config-forms.js`、`public/native/settings/models-health-and-key-editor.js`、`public/native/settings/models-oauth-login.js`、`public/native/settings/models-provider-picker.js` |
| P1 | `public/native/workflow/workflow-panel.js` | 1,725 | 498 | 已完成 | `public/native/workflow/workflow-inspector-panel.js`、`public/native/workflow/workflow-history.js`、`public/native/workflow/workflow-run-controls.js`、`public/native/workflow/workflow-run-controls-dom.js` |
| P1 | `public/native/session/session-sidebar.js` | 1,699 | 466 | 已完成 | `public/native/session/session-sidebar-actions.js`、`public/native/session/session-sidebar-item.js`、`public/native/session/session-sidebar-search.js`、`public/native/session/session-sidebar-sections.js`、`public/native/session/session-sidebar-storage.js` |
| P1 | `public/file-preview-panel.js` | 1,512 | 477 | 已完成 | `public/file-preview-panel-controls.js`、`public/file-preview-panel-diff.js`、`public/file-preview-panel-loader.js`、`public/file-preview-panel-save.js`、`public/file-preview-panel-tabs.js` |

### 2. 后端代码库（`src-tauri/src/`）

| 优先级 | 文件路径 | 重构前行数 | 当前行数 | 状态 | 下沉子模块清单 |
|---|---|---|---|---|---|
| P1 | `src-tauri/src/git_service.rs` | 3,231 | 252 | 已完成 | `src-tauri/src/git_service/status_write.rs`、`src-tauri/src/git_service/commit.rs`、`src-tauri/src/git_service/history.rs`、`src-tauri/src/git_service/porcelain.rs`、`src-tauri/src/git_service/process.rs` |
| P1 | `src-tauri/src/metadata_store.rs` | 2,146 | 47 | 已完成 | `src-tauri/src/metadata_store/schema.rs`、`src-tauri/src/metadata_store/workflows.rs`、`src-tauri/src/metadata_store/runs.rs`、`src-tauri/src/metadata_store/workflow_validation.rs`、`src-tauri/src/metadata_store/tests.rs` |
| P1 | `src-tauri/src/main.rs` | 1,658 | 446 | 已完成 | `src-tauri/src/app_shell/startup.rs`、`src-tauri/src/app_shell/workflow_windows.rs`、`src-tauri/src/app_shell/workspace_windows.rs` |

---

## 四、P2 运行时与渲染核心拆解完成清单（全部达标 <500 行）

### 1. 前端代码库（`public/`）

| 优先级 | 文件路径 | 重构前行数 | 当前行数 | 状态 | 下沉子模块清单 |
|---|---|---|---|---|---|
| P2 | `public/native/workflow/workflow-runner.js` | 917 | 422 | 已完成 | `public/native/workflow/workflow-builtin-executors.js`、`public/native/workflow/pi-agent-executor.js`、`public/native/workflow/workflow-run-context.js` |
| P2 | `public/cost/infobar.js` | 898 | 270 | 已完成 | `public/cost/infobar-charts.js`、`public/cost/infobar-metrics.js` |
| P2 | `public/ui/message-renderer.js` | 848 | 495 | 已完成 | `public/ui/message-renderer-helpers.js`、`public/ui/message-renderer-search.js` |

### 2. 后端代码库（`src-tauri/src/`）

| 优先级 | 文件路径 | 重构前行数 | 当前行数 | 状态 | 下沉子模块清单 |
|---|---|---|---|---|---|
| P2 | `src-tauri/src/terminal_manager.rs` | 1,645 | 373 | 已完成 | `src-tauri/src/terminal_manager/commands.rs`、`src-tauri/src/terminal_manager/pty_lifecycle.rs`、`src-tauri/src/terminal_manager/tests.rs` |
| P2 | `src-tauri/src/skill_install.rs` | 1,334 | 314 | 已完成 | `src-tauri/src/skill_install/discovery.rs`、`src-tauri/src/skill_install/settings_store.rs`、`src-tauri/src/skill_install/tests.rs` |
| P2 | `src-tauri/src/native_pi_manager.rs` | 1,075 | 477 | 已完成 | `src-tauri/src/native_pi_manager/lifecycle.rs`、`src-tauri/src/native_pi_manager/tests.rs` |

---

## 五、P3 全量 500 行护栏收官清单（全部达标 <500 行）

### 1. 后端代码库（`src-tauri/src/`，8 个模块）

| 文件路径 | 重构前行数 | 当前行数 | 下沉子模块清单 |
|---|---|---|---|
| `src-tauri/src/acp_manager.rs` | 964 | 422 | `src-tauri/src/acp_manager/protocol.rs`、`src-tauri/src/acp_launch.rs` |
| `src-tauri/src/pi_launch.rs` | 817 | 309 | `src-tauri/src/pi_launch/extensions.rs`、`src-tauri/src/pi_launch/external_apps.rs`、`src-tauri/src/pi_launch/packages.rs` |
| `src-tauri/src/workflow_code_process.rs` | 647 | 472 | `src-tauri/src/workflow_code_process/guard.rs`、`src-tauri/src/workflow_code_process/tests.rs` |
| `src-tauri/src/workflow_code_runner.rs` | 635 | 337 | `src-tauri/src/workflow_code_runner/windows.rs` |
| `src-tauri/src/host_server/routes/workspace.rs` | 540 | 126 | `src-tauri/src/host_server/routes/git.rs`、`src-tauri/src/host_server/routes/files.rs`、`src-tauri/src/host_server/routes/sessions.rs` |
| `src-tauri/src/git_service/status_write.rs` | 538 | 453 | `src-tauri/src/git_service/porcelain.rs` |
| `src-tauri/src/host_data/transcript_reader.rs` | 532 | 477 | `src-tauri/src/host_data/branch_tree.rs` |
| `src-tauri/src/pi_rpc_bridge.rs` | 506 | 476 | `src-tauri/src/host_server/dispatch.rs` |

### 2. 前端代码库（`public/`，16 个模块）

| 文件路径 | 重构前行数 | 当前行数 | 下沉子模块清单 |
|---|---|---|---|
| `public/native/workflow/workflow-canvas.jsx` | 812 | 270 | `public/native/workflow/workflow-canvas-ports.js`、`public/native/workflow/workflow-canvas-status.js`、`public/native/workflow/workflow-canvas-toolbar.js` |
| `public/native/workspace/remote-workspace-dialog.js` | 773 | 472 | `public/native/workspace/remote-workspace-dialog-dom.js` |
| `public/ui/conv-nav.js` | 739 | 434 | `public/ui/layout-insets.js` |
| `public/git-panel.js` | 732 | 485 | `public/git-panel-dialogs.js`、`public/git-history-panel.js`、`public/git-diff-renderer.js` |
| `public/native/acp/subagent-card.js` | 709 | 435 | `public/native/acp/subagent-runs.js`、`public/native/acp/subagent-store.js` |
| `public/terminal-panel.js` | 672 | 480 | `public/terminal-panel-dom.js`、`public/terminal-tab.js` |
| `public/components/super-agent-runtime.js` | 665 | 491 | `public/components/super-agent-runtime-cards.js` |
| `public/native/settings/skills-discovered-tab.js` | 661 | 440 | `public/native/settings/skills-discovered-views.js`、`public/native/settings/skills-install-tab.js` |
| `public/ui/tool-card.js` | 632 | 491 | `public/ui/tool-card-dom.js` |
| `public/native/workspace/file-browser.js` | 619 | 465 | `public/file-type-icons.js` |
| `public/native/settings/settings-config.js` | 593 | 412 | `public/native/settings/settings-custom-provider.js` |
| `public/native/extensions/dialog.js` | 561 | 482 | `public/native/session/dialog-handler.js` |
| `public/native/composer/composer-slash-menu.js` | 551 | 351 | `public/native/composer/slash-commands.js` |
| `public/native/settings/settings-panel.js` | 540 | 334 | `public/native/settings/settings-toggles.js`、`public/native/settings/settings-save-status.js` |
| `public/native/features/super-agent-controller.js` | 538 | 406 | `public/super-agent/native-dispatch.js`、`public/super-agent/session.js` |
| `public/native/session/session-tree.js` | 517 | 428 | `public/native/session/info-panel-tree-dom.js` |

### 3. 扩展代码库（`extensions/`，7 个模块）

| 文件路径 | 重构前行数 | 当前行数 | 下沉子模块清单 |
|---|---|---|---|
| `extensions/picot-config.ts` | 1,766 | 447 | `extensions/picot-config-models.ts`、`extensions/picot-config-health.ts`、`extensions/picot-config-settings.ts`、`extensions/picot-config-oauth.ts`、`extensions/picot-config-model-ops.ts` |
| `extensions/chat-inbox/extension-entry.ts` | 1,238 | 484 | `extensions/chat-inbox/prompt-context.ts`、`extensions/chat-inbox/chat-tools.ts`、`extensions/chat-inbox/chat-commands.ts` |
| `extensions/ssh-remote.ts` | 817 | 349 | `extensions/ssh-remote-config.ts`、`extensions/ssh-remote-settings.ts` |
| `extensions/chat-inbox/runtime.ts` | 629 | 433 | `extensions/chat-inbox/render/format.ts`、`extensions/chat-inbox/render/streaming.ts` |
| `extensions/chat-inbox/remote-operations.ts` | 619 | 345 | `extensions/chat-inbox/prompt-context.ts` |
| `extensions/skill-inventory.ts` | 570 | 477 | `extensions/skill-discovery.ts`、`extensions/skill-inventory-mutation.ts`、`extensions/skill-inventory-rules.ts` |
| `extensions/chat-inbox/live/telegram.ts` | 548 | 295 | `extensions/chat-inbox/live/telegram-api.ts` |

### 4. 前端样式表（`public/`，9 个模块）

| 文件路径 | 重构前行数 | 当前行数 | 下沉子样式表清单 |
|---|---|---|---|
| `public/native/settings/settings-config.css` | 1,264 | 315 | `public/native/settings/settings-config-forms.css`（356 行）、`public/native/settings/settings-api-keys.css`（395 行）、`public/native/settings/settings-config-modals.css`（225 行） |
| `public/native/session/session-sidebar.css` | 882 | 490 | `public/native/session/session-sidebar-menus.css`（452 行） |
| `public/style.css` | 847 | 384 | `public/native/workspace/git-panel.css`（323 行）、`public/native/workspace/git-diff-dialog.css`（201 行） |
| `public/native/settings/package-browse.css` | 699 | 398 | `public/native/settings/package-manager.css`（304 行） |
| `public/ui/message-renderer.css` | 641 | 293 | `public/ui/message-thinking-footer.css`（346 行） |
| `public/native/workspace/file-preview-panel.css` | 614 | 455 | `public/native/workspace/file-preview-toolbar.css`（159 行） |
| `public/native/settings/cost-dashboard.css` | 561 | 339 | `public/native/settings/cost-dashboard-tables.css`（225 行） |
| `public/native/header.css` | 560 | 376 | `public/native/header-model-dropdown.css`（186 行） |
| `public/native/settings/settings-panel.css` | 525 | 370 | `public/native/settings/settings-panel-controls.css`（158 行） |

### 5. 构建脚本与后端集成/单元测试模块（8 个模块）

| 文件路径 | 重构前行数 | 当前行数 | 下沉子模块清单 |
|---|---|---|---|
| `scripts/smoke-pi-rpc.js` | 730 | 323 | `scripts/smoke-pi-rpc-helpers.js`（287 行） |
| `scripts/smoke-pi-workflow-rpc.js` | 566 | 457 | `scripts/smoke-pi-workflow-rpc-bridge.js`（255 行）、`scripts/smoke-pi-workflow-rpc-provider.js`（327 行） |
| `scripts/cargo-target-matrix.test.js` | 543 | 278 | `scripts/release-target-matrix.test.js`（280 行） |
| `src-tauri/src/host_server_workflow_broadcast.rs` | 885 | 477 | `src-tauri/src/host_server_workflow_broadcast/recovery.rs`（400 行） |
| `src-tauri/src/host_server_real_pi_smoke.rs` | 1,918 | 242 | `src-tauri/src/host_server_real_pi_smoke/fake_providers.rs`（211 行）、`src-tauri/src/host_server_real_pi_smoke/extension_ui_smoke.rs`（466 行）、`src-tauri/src/host_server_real_pi_smoke/session_smoke.rs`（391 行）、`src-tauri/src/host_server_real_pi_smoke/workflow_proposal.rs`（484 行）、`src-tauri/src/host_server_real_pi_smoke/node_meta_proposal.rs`（243 行）、`src-tauri/src/host_server_real_pi_smoke/workflow_run.rs`（225 行） |
| `src-tauri/src/host_data/tests.rs` | 892 | 473 | `src-tauri/src/host_data/session_lifecycle_tests.rs`（420 行） |
| `src-tauri/src/host_server/tests.rs` | 1,062 | 341 | `src-tauri/src/host_server/health_and_auth_tests.rs`（371 行）、`src-tauri/src/host_server/websocket_tests.rs`（367 行） |
| `src-tauri/src/metadata_store/tests.rs` | 2,394 | 290 | `src-tauri/src/metadata_store/workflow_graph_tests.rs`（487 行）、`src-tauri/src/metadata_store/workflow_run_create_tests.rs`（435 行）、`src-tauri/src/metadata_store/workflow_run_replay_tests.rs`（435 行）、`src-tauri/src/metadata_store/workflow_run_transition_tests.rs`（450 行）、`src-tauri/src/metadata_store/workflow_run_recovery_tests.rs`（367 行） |

### 6. 扩展与前端单元测试模块（`extensions/` 与 `public/`，15 个模块）

| 文件路径 | 重构前行数 | 当前行数 | 下沉子测试模块清单 |
|---|---|---|---|
| `extensions/ssh-remote.test.ts` | 991 | 448 | `extensions/ssh-remote-transport.test.ts`（352 行）、`extensions/ssh-remote-extension.test.ts`（249 行） |
| `extensions/picot-config.test.ts` | 917 | 462 | `extensions/picot-config-providers.test.ts`（486 行） |
| `extensions/package-skill-inventory.test.ts` | 817 | 476 | `extensions/package-skill-candidates.test.ts`（371 行） |
| `extensions/skill-inventory.test.ts` | 802 | 355 | `extensions/skill-discovery.test.ts`（240 行）、`extensions/skill-inventory-mutation.test.ts`（306 行） |
| `public/native/workflow/workflow-runner.test.js` | 1,204 | 464 | `public/native/workflow/workflow-runner-nodes.test.js`（469 行）、`public/native/workflow/workflow-runner-retry.test.js`（347 行） |
| `public/native/session/session-sidebar.test.js` | 936 | 495 | `public/native/session/session-sidebar-actions.test.js`（491 行） |
| `public/native/workflow/workflow-run-controls.test.js` | 859 | 464 | `public/native/workflow/workflow-run-controls-rerun.test.js`（461 行） |
| `public/file-preview-panel.test.js` | 800 | 474 | `public/file-preview-panel-tabs.test.js`（471 行） |
| `public/native/settings/settings-config-editors.test.js` | 753 | 396 | `public/native/settings/settings-config-editors-health.test.js`（415 行） |
| `public/ui/message-renderer.test.js` | 613 | 359 | `public/ui/message-renderer-toolbar.test.js`（348 行） |
| `public/git-panel.test.js` | 558 | 314 | `public/git-panel-commit.test.js`（281 行） |
| `public/ui/at-file-mention.test.js` | 552 | 306 | `public/ui/at-file-mention-navigation.test.js`（296 行） |
| `public/components/super-agent-runtime.test.js` | 551 | 272 | `public/components/super-agent-runtime-dispatch.test.js`（323 行） |
| `public/native/settings/cost-dashboard-render.test.js` | 546 | 391 | `public/native/settings/cost-dashboard-filters.test.js`（195 行） |
| `public/native/session/info-panel.test.js` | 507 | 380 | `public/native/session/info-panel-selection.test.js`（186 行） |

---

## 六、分阶段推进总结

1. **第一阶段（P0 阶段 - 基础架构解耦，已完成）**：完成 `public/native/app.js`、`src-tauri/src/host_server.rs`、`src-tauri/src/host_data.rs` 三大顶层编排与宿主入口拆解。
2. **第二阶段（P1 阶段 - 业务子系统轻量化，已完成）**：完成前端 4 个核心视图模块与后端 `git_service.rs`、`metadata_store.rs`、`main.rs` 领域拆解。
3. **第三阶段（P2 阶段 - 运行时与渲染核心解耦，已完成）**：完成前端 `workflow-runner.js`、`cost/infobar.js`、`ui/message-renderer.js` 与后端 `terminal_manager.rs`、`skill_install.rs`、`native_pi_manager.rs` 全量拆解。
4. **第四阶段（P3 阶段 - 全仓库 500 行护栏清零，已完成）**：完成 `src-tauri/src/`（8 个）、`public/`（16 个 JS/JSX 模块 + 9 个 CSS 样式表）、`extensions/`（7 个）全部剩余超 500 行非测试源码与样式模块的职责拆解。
5. **第五阶段（P4 阶段 - 脚本与后端测试模块 500 行护栏延伸，已完成）**：完成 `scripts/` 下 3 个超 500 行脚本/测试文件与 `src-tauri/src/` 下全部 5 个超 500 行的集成测试及单元测试模块拆解，使 `src-tauri/src/` 与 `scripts/` 下所有文件 100% 控制在 500 行以内。
6. **第六阶段（P5 阶段 - 扩展与前端测试模块 500 行护栏全覆盖，已完成）**：完成 `extensions/`（4 个）与 `public/`（11 个）下全部超 500 行单元测试文件的职责拆解，并通过 `scripts/module-guardrails.test.js` 自动化守卫全仓库 500 行代码上限、零 emoji 规范与架构文档路径一致性。
