# Pipline

[English](./README.md) | 简体中文

Pipline 是一款以 Pi Coding Agent 为核心的桌面编码工作台。普通会话使用 Pi 原生 Agent、工具、会话和扩展能力；工作流模式提供懒加载画布、版本化节点库与受限 DAG 执行，目前仍在开发和验收中。

> 项目处于开发早期。桌面底座基于 [Picot](https://github.com/shixin-guo/picot)（MIT）；工作流功能正在开发，跨平台和端到端验收尚未完成。

## 平台目标

- Windows 10 x64
- macOS 11.0+，Apple Silicon 与 Intel
- Pi Runtime 随各平台安装包一起分发，用户不需要预装 Pi、Node 或 Bun
- 直接复用用户 `~/.pi/agent` 下的 Pi 配置、凭证、会话和扩展
- Pipline 工作流数据单独保存，不覆盖 Pi 用户数据

## 开发

开发环境需要 Bun、Rust，以及对应平台的 Tauri 构建依赖。项目使用 Bun 管理前端依赖：

```sh
bun install --frozen-lockfile
bun run dev
```

构建当前平台安装包：

```sh
bun run build
```

macOS 发布目标设置为 11.0。macOS Developer ID 签名和 notarization 属于后续发行事项，不是当前开发前置条件。

## 方案和计划

- [0.1.0 内部预览说明（草稿）](./docs/RELEASE_NOTES_0.1.0.md)
- [本地数据与网络说明](./docs/DATA_AND_PRIVACY.md)
- [平台与运行时决策记录](./docs/adr/0001-platform-and-pi-runtime.md)

## 来源与许可

Pipline 当前桌面底座基于 [Picot](https://github.com/shixin-guo/picot) 修改，保留其 MIT 许可证和版权声明。Pi Coding Agent 为官方 Pi 项目（MIT）；随包 v0.85.1 的许可证副本位于安装包内 `licenses/` 目录。工作流画布使用 MIT 许可的 `@xyflow/react`。发行前仍须审核完整传递依赖和随包资源。

本项目不复制或依赖 `wangmiaozero/pi-harness` 的 AGPL 源码。
