# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| older   | :x:                |

## Reporting a Vulnerability

请**勿**在公开 Issue 中披露安全漏洞。请通过 GitHub 的
[Security → Report a vulnerability](https://github.com/yourusername/markflow/security/advisories/new)
私信提交，我们会尽快确认并修复。

CI 已启用 CodeQL 静态扫描（`codeql.yml`），其告警也会出现在本仓库
Security 面板的 Code scanning alerts 中，欢迎在此跟踪进展。

此外，仓库在本地与 CI 中均运行 **Secretlint**（`npm run lint:secret`）扫描可能泄露的密钥
（AWS / 私钥 / Token 等）。提交前请运行 `npm run quality` 确保通过。

> ⚠️ 请勿在代码、配置或文档中提交任何真实凭据或密钥。如不慎提交，请立即轮换并撤销该密钥。
