# MarkFlow GitHub Actions CI/CD 调试笔记

> 本文档记录 Electron 打包构建、GitHub Actions 配置及相关问题的排查过程与解决方案。

## 1. electron-builder 输出目录结构与 artifact 匹配问题

### 问题描述

Release 页面显示上百个文件，且 Windows 版本的 ZIP 包找不到。

### 根本原因

- electron-builder 为每个平台构建时将所有产物输出到 `release/` 目录。
- `upload-artifact` 上传的是整个 `release/` 目录（包含所有文件）。
- `download-artifact` 下载后，文件结构为：

  ```
  artifacts/
    markflow-macos/
      markflow-1.0.0.dmg
    markflow-windows/
      MarkFlow-1.0.0-win.zip
    markflow-linux/
      MarkFlow-1.0.0.AppImage
  ```

- 原 workflow 的 `files` 参数使用 `release/win-unpacked/**` 等路径，与实际 artifact 结构不匹配。

### 解决方案

1. 修改 `electron-builder.json5`，为 Windows 平台设置自定义 `artifactName`：

   ```json5
   "win": {
     "artifactName": "${name}-${version}-${os}.${ext}"
   }
   ```

2. 统一使用 `files: | artifacts/*/\*` 匹配所有 artifact 目录中的文件。

## 2. macOS DMG 构建错误

### 错误日志

```
unable to execute hdiutil args=["convert","/private/var/...","-ov","-format","UDZO",...]
```

### 原因

- macOS runner 尝试将 dmg 转换为 UDZO 格式时失败。
- 这通常发生在 Apple Silicon (arm64) 处理器上，因为 APFS 文件系统不支持 HFS+。

### 解决方案

在 `electron-builder.json5` 中设置 `mac.target.arch` 为 `["universal"]`，而不是分开指定 `x64` 和 `arm64`：

```json5
"mac": {
  "target": [{ "target": "dmg", "arch": ["universal"] }]
}
```

## 3. Linux 依赖包名称变更

### 错误日志

```
E: Unable to locate package libwebkit2gtk-4.0-dev
```

### 原因

- Ubuntu 24.04+ 已将 `libwebkit2gtk-4.0-dev` 重命名为 `libwebkit2gtk-4.1-dev`。
- `libasound2` → `libasound2t64`。

### 解决方案

修改 CI 中的依赖安装命令：

```bash
sudo apt-get install -y \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libnss3-dev \
  libsecret-1-dev \
  libxss1 \
  libgbm1 \
  libasound2t64 \
  librsvg2-bin \
  rpm \
  fakeroot \
  libarchive-tools
```

## 4. GitHub Actions 插件版本升级

### 问题描述

Release 步骤出现 Node.js 20 弃用警告。

### 解决方案

升级所有 Action 插件到最新稳定版本：

- `actions/checkout@v6` (最新)
- `actions/setup-node@v6` (最新)
- `actions/download-artifact@v8` (最新)
- `actions/upload-artifact@v7` (最新)
- `softprops/action-gh-release@v3` (最新，替代 v2)

## 5. electron-builder publish 配置错误

### 问题描述

```
Cannot find module 'electron-publisher-never'
```

### 原因

错误地在顶层添加了 `"publish": "never"`。`publish: "never"` 不是有效的 electron-builder 配置项。

### 解决方案

移除顶层的 `publish: "never"`，改为在每平台内部配置或不设置。

## 6. Workflow 条件逻辑问题

### 问题描述

Build 和 Release 阶段被跳过。

### 原因

- `needs.auto-tag.outputs.tag_created` 是一个字符串输出，在 `if` 条件中使用 `!needs.auto-tag.outputs.tag_created` 会导致布尔类型错误。

### 解决方案

- 简化 `build` 的 `if` 条件，只检查 `version != ''` 和 `dry_run == false`。
- 为 `upload-artifact` 添加 `if-no-files-found: error`。

## 7. Windows 构建：winCodeSign 与 prepare-win-codesign.ps1

### 7.1 winCodeSign 是什么

`winCodeSign` 是 **electron-builder 用来给 Windows 安装包做代码签名/写入资源的一组二进制工具集**（由 electron-userland 维护），包含：

- **`rcedit-x64.exe` / `rcedit-ia32.exe`**：往 `.exe` 里写入图标、版本信息、manifest 等；
- **`openssl-ia32`** 等：用于给 exe/dll 做 Authenticode 数字签名（即 Windows 弹出"未知发布者"警告的那个签名）；
- **`windows-10` / `windows-6`**：Windows SDK 相关资源文件，用于正确的版本号与 UI 表现。

electron-builder 在打包 Windows 时会**自动下载并缓存**到：

```
%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\
```

> 注意：本项目当前 `electron-builder.json5` 的 `win` 配置**未设置 `certificateFile` / `certificatePassword`**，因此 winCodeSign 实际只被用来写 exe 的图标与版本资源，**并不会真正做数字签名**。脚本名中的 "codesign" 只是沿用了工具名。

### 7.2 prepare-win-codesign.ps1 是干什么的

它是一个**绕过 electron-builder 自动下载缓存失败**的补丁脚本。问题根源：

- electron-builder 自动下载的 `winCodeSign-2.6.0.7z` 压缩包里，除了 Windows 文件，还混有 **macOS/Linux 的符号链接（symlink）**。
- 在 **Windows 非管理员账号** 下，默认没有创建符号链接的权限（需要 `SeCreateSymbolicLinkPrivilege`，普通用户默认关闭，除非开启开发者模式）。
- 因此 electron-builder 自己解压缓存时一碰到 symlink 就报错，导致整个 `dist:win` 构建失败。

该脚本的做法是：自己把 `.7z` 下载下来，**只解压 Windows 相关的文件**（跳过 darwin/linux 的符号链接）：

```powershell
& $sevenZip x $tempZip "-o$targetDir" "windows-10" "windows-6" "appxAssets" "openssl-ia32" "rcedit-x64.exe" "rcedit-ia32.exe" -y -bd
```

然后写一个标记文件 `.win-only-extracted`，下次再跑就直接跳过（避免重复下载）。支持的下载源带 GitHub 备用地址回退：

```
https://npmmirror.com/mirrors/electron-builder-binaries/winCodeSign-2.6.0/winCodeSign-2.6.0.7z
https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z
```

### 7.3 为什么用 PowerShell 而不是 cmd

1. **不需要给脚本签名**：npm 脚本里通过 `powershell -ExecutionPolicy Bypass -File ...` 直接绕过执行策略，签名只是可选方案，本地开发/CI 都用 Bypass，不会弹"禁止运行脚本"错误。
2. **脚本大量依赖 PowerShell 专有命令**，cmd 没有或很难实现：
   - `Invoke-WebRequest` 下载（带备用地址回退）；cmd 只能靠 `certutil -urlcache`，不支持回退；
   - `Join-Path` / `Test-Path` / `Get-ChildItem` / `Where-Object` / `Set-Content` 用于路径拼接、存在性判断、目录过滤、写标记文件；cmd 批处理写起来冗长且易错。
3. **真正的目的是绕过非管理员无法创建符号链接的坑**：手动下载并按文件名选择性解压的逻辑，用 PowerShell 表达最干净。

> 若想彻底去掉 PowerShell 依赖，可把这段逻辑改写成纯 Node 脚本（用 `https` + `child_process` 调用 7za），跨平台与 CI 更统一，但改动较大。

### 7.4 相关文件

| 文件 | 说明 |
|------|------|
| `scripts/prepare-win-codesign.ps1` | 手动下载并只解压 Windows 签名工具，规避符号链接权限问题 |
| `package.json` → `scripts.dist:win` | `powershell -ExecutionPolicy Bypass -File scripts/prepare-win-codesign.ps1 && npm run build && electron-builder --win` |
| `electron-builder.json5` → `win` | Windows 打包配置；如需真签名需补 `certificateFile` / `certificatePassword` |

## 8. Release 阶段失败：builder-debug.yml / Draft / 404 与版本号

### 8.1 现象（一次真实的发版失败）

触发 `v0.2.0` tag 后 Release 阶段报错，三处异常：

1. **产物文件名版本号错误**：所有文件被命名为 `1.0.0`（而非正确的 `v0.2.0`）。
2. **Release 停留在 Draft**：内容只生成了一部分，未正式发布。
3. **报错 `Not Found`**：
   ```
   error updating release asset metadata for builder-debug.yml: HttpError: Not Found
   ✅ Uploaded builder-debug.yml
   Error: Not Found - https://docs.github.com/rest/releases/assets#update-a-release-asset
   ```

### 8.2 根因分析（关键认知）

**版本号错误**：CI 构建前没有把 `package.json` 的 `version`（写死为 `1.0.0`）更新为 tag 版本，electron-builder 按 `package.json` 版本命名产物。

**404 的真正原因（最终版，基于 v0.5.4 日志实证）**

核心机制：`softprops/action-gh-release` 对每个要上传的文件，会先**按文件名查重**；若 release 里已有同名 asset（无论是本次已上传的、还是复用旧 release 残留的），就走"**覆盖更新**"分支，调用 `PATCH /repos/{owner}/{repo}/releases/assets/{id}`（即报错里的 `update-a-release-asset`）。而 **GitHub 的 `updateReleaseAsset` 接口对「属于 Draft Release 的 asset」一律返回 404**——这是 API 限制：draft 态的 asset 不能通过该 PATCH 端点更新。

`builder-debug.yml` 为何必然中招——**跨平台同名碰撞**：

- electron-builder 在 macos / windows / linux **三个产物目录里各自生成一份** `builder-debug.yml`，**文件名完全相同**。
- action 依次处理 `artifacts/markflow-macos/*`、`.../windows/*`、`.../linux/*` 三个 glob；遇到第 2、3 个 `builder-debug.yml` 时，发现同名 asset 已存在 → 走"覆盖更新" → PATCH → 因为是 Draft，404。
- 其余产物（`*.dmg`、`*-win.zip`、`*.AppImage`、`.blockmap`）平台名各不相同，**绝不撞名**，所以全部 ✅。
- 这就解释了为什么**只有 builder-debug.yml 报错**——它是三个目录里唯一的重复文件名。
- **与"是否有旧草稿"无关**：v0.5.4 是全新 release（日志 `Creating new GitHub release`），没有旧草稿也照样 404。因为撞名发生在**本次上传的三个目录之间**，不依赖历史 release。

**`!**/builder-debug.yml` 否定式是无效修复（关键陷阱）**：action 对 `files:` 里的 `!**/...` 取反模式处理有缺陷——实测会警告 `Pattern '!**/builder-debug.yml' does not match any files`，且**仍然把该文件上传**。所以仅靠在 `files:` 末尾加否定式挡不住 `builder-debug.yml`，它还是会被三个 glob 扫到并上传、撞名、404。

**正确修法**：不能靠 `files:` 取反，必须在上传前**直接从 artifacts 删除** `builder-debug.yml`（`find artifacts -name 'builder-debug.yml' -delete`），让三个 glob 扫不到它，从源头消除撞名。

次要路径（仍可能存在，已由"删旧草稿"步骤兜底）：若上次失败的 run 残留了一个含有若干 asset 的 Draft Release，本次 action 会复用它、对其中已存在的 asset 发 PATCH → 404（此时所有已存在文件都会 404，不仅 builder-debug.yml）。`Delete stale release` 步骤（gh api + 纯数字校验）专门清掉这种旧草稿。

**Draft 残骸**：第一次 PATCH 404 就让整个 Release step 中断，Release 从未完成发布 → 残留为 Draft，进而成为"次要路径"的源头。

> ⚠️ 历史误判复盘：早期曾误以为"action 上传后会主动对 builder-debug.yml 单独 PATCH 元数据"或"单纯 Draft 导致 404"。实测推翻二者——**真正触发 PATCH 的是跨平台同名碰撞**，且其他文件在 Draft 下上传完全正常。

### 8.3 修复措施（已写入 ci.yml）

| 改动 | 位置 | 作用 |
|------|------|------|
| 注入版本号 | `build` job：`Inject release version into package.json` | `npm version --no-git-tag-version --no-commit <ver>` 覆盖 `package.json`，使产物名正确 |
| `shell: bash` | 同上 step | Windows runner 默认 shell 是 PowerShell，不认 `VAR="x"` 语法；强制 bash 跨平台一致 |
| 删除调试文件 | `release` job 上传前加 `find artifacts -name 'builder-debug.yml' -delete` | 直接在 artifacts 中删掉该文件，让三个平台 glob 扫不到它，**从源头消除跨平台同名碰撞**（见 8.2）。注意：`files:` 里的 `!**/builder-debug.yml` 否定式**无效**（action 会警告且仍上传），不能用它来排除 |
| 删旧草稿 | `release` job：`Delete stale release (if any)`，改用 `gh api` REST（`GET …/releases/tags/{tag}` 取 id → `DELETE …/releases/{id}`） | 重跑前清掉上次失败残留的 Draft，避免**路径 B** 已存在 asset 触发 404。原 `gh release view/delete` 子命令对 draft 解析不可靠、实际未删除，故改用 `gh api`（不依赖 git 上下文、对 draft/published 都稳定）。只删 Release 对象，**保留 git tag** |
| Draft 安全网 | `Create Release` 设 `draft: true` | 上传期间保持草稿，失败只留草稿不污染用户 |
| 显式发布 | `Publish Release` step：`gh release edit <tag> --draft=false`，`if: success()` | 仅在全部 asset 上传成功后把草稿翻为已发布 |
| 仓库上下文 | `release` job 开头加 `actions/checkout@v6` | 提供 `.git`，让 `gh release view/edit/delete` 能解析目标仓库；否则报 `not a git repository`（见第 9 节） |

> 保留 Draft + 显式发布 是用户明确要求的"防半成品"设计：以前默认 `draft: false` 时 action 会自动发布，无需该步；改为 `draft: true` 后 action 永不自动发布，必须加这一步。

### 8.4 关键经验

1. **矩阵 job 的每个 step 都会按组合数重复执行**。`build` 是 `mac/win/linux` 三平台矩阵，所以"注入版本号"会跑 3 次——这是正常的。原因是三个分支在互不相通的独立虚拟机上各自 `checkout`，没有共享文件系统，不存在"跑在所有分支之前"的内部步骤。要"只注入一次"必须提升为独立的无矩阵 `prep` job，并用 artifact 把改好的 `package.json` 传下去（增加复杂度，对当前项目收益不大，故保留 3 次）。

2. **bash 语法 step 在 Windows runner 上必须显式 `shell: bash`**。否则 `VAR="value"` 被 PowerShell 当成命令名报 `not recognized`。`release` job 只在 `ubuntu-latest` 跑（默认 bash），无需加。

3. **不要在 `test` job 里引用 `needs.auto-tag.outputs.version` 并做版本注入**。`test` job 没有 `needs: auto-tag`，在非发版触发（push 到 main、开 PR）时该输出为空，会导致 `npm version ""` 报错、CI 全红。`test` job 只构建 web 渲染层（Vite），不调用 electron-builder，注入版本对它无意义。

4. **`builder-debug.yml` 是 electron-builder 在每个平台产物目录都生成一份的调试文件，且文件名完全相同**：它是产生"跨平台同名碰撞 → Draft 下 PATCH 404"的唯一元凶。不能靠 `files:` 的 `!**/...` 否定式排除（action 会警告且仍上传），正确做法是在上传前 `find artifacts -name 'builder-debug.yml' -delete` 直接从 artifacts 删除。删除它不影响可分发包。

5. **删旧草稿必须可靠（路径 B 的关键）**：原 `gh release view/delete` 子命令对 draft 解析异常/返回非零，导致删除步骤被 `if` 静默跳过、旧 draft 残留继续触发 404。已改用 `gh api` 直接调 REST 接口（不依赖 git 上下文、对 draft/published 都能稳定解析）实现删除。若升级删除步骤前已残留 Draft，仍需手动到 Releases 页面删一次，之后即可自动清理。

6. **`gh api` 404 时会把错误 JSON 打到 stdout，`|| true` 会把它当成结果**：`RELEASE_ID=$(gh api ".../releases/tags/${TAG}" --jq '.id' 2>/dev/null || true)`——当 tag 没有对应 release 时，`gh api` 以非零退出**并把 `{"message":"Not Found",...}` 写到 stdout**，被 `RELEASE_ID` 捕获。此时 `[ -n "$RELEASE_ID" ]` 误判为"存在"，接着拿这段 JSON 当 id 去 `DELETE .../releases/{id}`，报 `unsupported protocol scheme ""` 并让 job 失败。修法：**只把纯数字 id 视为有效**，用 `if [[ "$RELEASE_ID" =~ ^[0-9]+$ ]]; then` 判断，非数字（含错误 JSON、空值）一律走"无已存在 release"分支。

### 8.5 当前 Release 流程时序

```
auto-tag  → 算出 version（如 v0.4.0）
  ↓
build（矩阵 ×3 平台，各自）：
   注入 package.json 版本 → npm ci → vite build → electron-builder 打包
   上传 artifact
  ↓
release：
   checkout 仓库（提供 .git，供 gh 解析目标仓库）
   → 下载 artifacts
   → 删旧草稿（若有）
   → 以 Draft 创建 Release，上传 6 个产物（排除 builder-debug.yml）
   → 仅当全部成功：gh release edit --draft=false 发布
```

## 9. Release 阶段失败：release job 缺少 checkout 导致 `gh` 报 "not a git repository"

### 9.1 现象（一次真实的发版失败）

`Publish Release` step 报错退出（以 `v0.5.0` 为例）：

```
Run TAG="v0.5.0"
  gh release edit "$TAG" --draft=false
failed to run git: fatal: not a git repository (or any of the parent directories): .git
Error: Process completed with exit code 1.
```

### 9.2 根因

`release` job 里**没有 `checkout` 步骤**，工作目录中不存在 `.git`。`gh release edit/view/delete` 这类命令需要先解析"当前命令针对哪个 GitHub 仓库"，`gh` 的解析顺序是：

1. `GH_REPO` 环境变量；
2. 当前目录的 git remote（即 `.git`）；
3. 在 GitHub Actions 中还会回退读取 `GITHUB_REPOSITORY` 环境变量。

本项目 `release` job 既没设 `GH_REPO`，也没 checkout，于是 `gh` 退回到调用 `git` 来定位仓库，而此时没有 `.git`，直接抛 `fatal: not a git repository`。

### 9.3 隐藏的同源 bug（为什么只有 Publish 暴露报错）

同一 `release` job 的 **"Delete stale release (if any)"** 步骤内部同样调用了 `gh release view`（以及 `gh release delete`），同样会触发这个 git 报错。但它被包在 `if gh release view "$TAG" >/dev/null 2>&1; then ... else ...` 里——`gh` 的失败被 `if` 捕获，错误输出被静默吞掉，流程走入 `else` 分支误判为"没有已存在的 release"。

所以：两个 `gh` 调用其实都中招了，**只是 Publish 那一步的 `gh` 失败未被 `if` 包裹、直接以非零退出码中断了 job**，才让问题显现。只修 Publish 不改 Delete 的话，重跑时旧草稿不会被清掉（见 8.2 第二条复现路径），依然可能 404。

### 9.4 修复（已写入 ci.yml）

在 `release` job 的最开头加一个 `actions/checkout@v6`：

```yaml
    steps:
      # `gh` resolves the target repository from the local git context ...
      - uses: actions/checkout@v6

      - name: Download all artifacts
        uses: actions/download-artifact@v8
```

checkout 后会生成 `.git`，`gh` 即可通过 git remote 正确解析仓库，Delete stale release 与 Publish Release 两步都恢复正常。

> 注（后续演进）：`Delete stale release` 步骤后来从 `gh release view/delete` 改为直接 `gh api` 调 REST 接口（见第 8 节），因此 9.3 描述的"git 报错被 `if` 静默吞掉"已不再发生；但 `Publish Release` 仍用 `gh release edit`，**checkout 仍是必需的**。

可选加固：若不想为本 job 拉取整个仓库，也可不 checkout，而是显式设置仓库上下文：

```yaml
    env:
      GH_REPO: ${{ github.repository }}
```

`gh` 读到 `GH_REPO` 后不会再调用 `git`，同样能修好。本项目选择 checkout 方案，更通用、与 `gh` 版本无关。

### 9.5 关键经验

1. **任何需要仓库上下文的 `gh` 命令，job 里要么 `checkout`、要么显式声明 `GH_REPO`/`GITHUB_REPOSITORY`**。`gh release …`、`gh pr …`、`gh issue …` 这类都依赖仓库定位。
2. **`release` job 本身不需要源码编译**，但它用 `gh` CLI，所以仍需要 git 上下文（checkout 或 GH_REPO），不能因为它"只上传 artifact"就省掉 checkout。
3. **被 `if` 包裹的命令失败会被吞掉**，可能掩盖真实问题（如本例的 Delete stale release 误判）。排查 `gh`/`git` 报错时，注意哪些命令被 `if`/管道吞了退出码，必要时先临时去掉 `if` 跑一次看真实报错。

## 文件清单

| 文件 | 说明 |
|------|------|
| `.github/workflows/ci.yml` | GitHub Actions CI/CD 主配置文件 |
| `electron-builder.json5` | electron-builder 打包配置 |
| `package.json` | 项目依赖和脚本定义 |
| `scripts/prepare-win-codesign.ps1` | Windows 签名工具缓存准备脚本（见第 7 节） |
