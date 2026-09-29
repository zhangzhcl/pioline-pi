# Pipline 更新包签名与发行配置

Tauri 更新器必须校验更新包签名。发行 workflow 会在各 runner 上从
`GITHUB_REPOSITORY` 生成临时的 `src-tauri/tauri.release.conf.json`，把 stable
更新端点指向当前 Pipline 仓库的 GitHub Release，并开启更新包及签名生成。
该文件只在 CI 工作区生成，不提交进源码。只有带有
`PIPLINE_RELEASE_REPOSITORY` 的 Pipline 发行构建会自动检查 stable 更新；Rust
会将此构建能力告知前端。开发构建和未配置 Pipline 发布仓库的内部构建不会调用
Tauri stable updater，设置页显示开发版本状态。源码配置保留不可用占位端点作为
保护性默认值，也不要求本地构建持有更新签名私钥。

## 首次发行前准备

1. 使用 Bun/Tauri CLI 生成专用更新签名密钥。把私钥放到仓库外的安全目录，
   例如 `~/.tauri/pipline-updater.key`：

   ```sh
   bunx tauri signer generate -w ~/.tauri/pipline-updater.key
   ```

   PowerShell 可使用：

   ```powershell
   bunx tauri signer generate -w "$env:USERPROFILE\.tauri\pipline-updater.key"
   ```

2. 将命令生成的公钥填入 `src-tauri/tauri.conf.json` 的
   `plugins.updater.pubkey`，并在仓库 Actions variables 中将同一公钥设置为
   `PIPLINE_UPDATER_PUBLIC_KEY`。release workflow 在安装依赖前核对公钥和私钥
   secret；安装依赖后会用私钥签名临时挑战文本，并用配置公钥验签，错配时在下载
   发布 Runtime 和编译应用前终止。临时签名及挑战文件会清理，私钥不会写入文件或
   传入命令行。不要把私钥或口令提交到仓库。
3. 在 GitHub 仓库 Actions secrets 中设置：
   - `TAURI_SIGNING_PRIVATE_KEY`：私钥文件内容（不是仓库路径）。
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成密钥时设置的口令；未设置则为空。
4. 保护并离线备份私钥及口令。已发布安装包绑定该公钥；遗失私钥会导致
   已安装版本无法接收后续签名更新。

当前 `tauri.conf.json` 的公钥与 Picot 上游配置相同，属于继承值；它还没有
与 Pipline 专用私钥配对。首次 Pipline updater release 前必须替换为新生成的
Pipline 公钥并设置对应 GitHub secrets，否则客户端无法验证 Pipline 更新包。

## 更新通道

- stable：release workflow 的 Tauri overlay 指向
  `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`。
- beta：Rust 发行构建通过 `PIPLINE_RELEASE_REPOSITORY` 编译同一实际仓库，
  Beta 检查指向 `releases/download/beta/latest.json`；workflow 在预发行完成后
  将该预发行构建生成的 `latest.json` 更新到 `beta` 通道 Release。
- release workflow 先把各平台构建、SBOM、许可证归档和校验和上传到 draft；
  只有所有平台构建及安装验收成功后才公开该 release，并随后更新 beta 通道。
  release jobs 只对 `v*` tag 执行；非 tag 的手动运行不会创建 release 草稿。
- `createUpdaterArtifacts` 只在该发行 overlay 中开启。若签名 secret 缺失，
  正式更新包构建应失败，不应发布不带验证签名的更新。

Apple Developer ID 签名与 notarization 是独立的 macOS 分发要求，按项目当前
决策另行处理；它们不替代 Tauri updater 的更新包签名。
