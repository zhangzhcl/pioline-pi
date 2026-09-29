# Pipline

English | [简体中文](./README.zh.md)

Pipline is a desktop coding workspace built around the Pi Coding Agent. Normal sessions retain Pi's native agent, tools, sessions, and extensions. Workflow mode adds a lazy-loaded canvas, a versioned node catalog, and constrained DAG execution; this functionality remains under development and acceptance.

> Early development. The desktop foundation is based on [Picot](https://github.com/shixin-guo/picot), an MIT-licensed Tauri application. Workflow functionality is under active development; platform and end-to-end acceptance are not complete.

## Target platforms

- Windows 10 x64
- macOS 11.0+ on Apple Silicon and Intel
- Pi Runtime ships inside each platform installer; users do not need to install Pi, Node, or Bun
- Reuses the user's `~/.pi/agent` configuration, credentials, sessions, and extensions
- Pipline workflow data is stored separately from Pi user data

## Development

Install Bun, Rust, and the Tauri build prerequisites for your platform. Bun manages frontend dependencies:

```sh
bun install --frozen-lockfile
bun run dev
```

Build an installer for the current platform:

```sh
bun run build
```
<img width="1947" height="1307" alt="image" src="https://github.com/user-attachments/assets/002dbed0-8273-49bf-a9f7-9eea413fba45" />
<img width="2184" height="1386" alt="image" src="https://github.com/user-attachments/assets/1c2e785e-53d8-4ed3-a8fc-0cccfc0da1fe" />

The macOS deployment target is 11.0. Developer ID signing and notarization are deferred release tasks, not development prerequisites.

## Project documents

- [0.1.0 internal preview notes (draft)](./docs/RELEASE_NOTES_0.1.0.md)
- [Local data and network notes](./docs/DATA_AND_PRIVACY.md)
- [Platform and Pi runtime decision](./docs/adr/0001-platform-and-pi-runtime.md)

## Source and licensing

The current desktop foundation is modified from [Picot](https://github.com/shixin-guo/picot). Its MIT license and copyright notice are retained. Pi Coding Agent is the official MIT-licensed Pi project; the exact bundled v0.85.1 license is included in each app bundle under `licenses/`. The workflow canvas uses MIT-licensed `@xyflow/react`. The full transitive dependency tree and bundled resources will be reviewed before release.

This project does not copy or depend on AGPL-licensed source from `wangmiaozero/pi-harness`.
