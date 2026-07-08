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

## 文件清单

| 文件 | 说明 |
|------|------|
| `.github/workflows/ci.yml` | GitHub Actions CI/CD 主配置文件 |
| `electron-builder.json5` | electron-builder 打包配置 |
| `package.json` | 项目依赖和脚本定义 |
| `scripts/prepare-win-codesign.ps1` | Windows 签名工具缓存准备脚本（见第 7 节） |
