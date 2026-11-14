# ADR-0037: Windows packaging — remove the winCodeSign pre-cache script and ship unsigned

- **Status:** Accepted
- **Decided:** 2026-11-14
- **Supersedes:** nothing
- **Amends:** `electron-builder.json5` (`win.signExecutable: false`), `package.json` (`dist:win`
  drops the `prepare-win-codesign.ps1` step), `scripts/prepare-win-codesign.ps1` (deleted),
  `README.md` / `README.zh-CN.md` / `CONTRIBUTING.md` / `QUICKSTART.md` (Windows build note
  rewrite)
- **Related:** ADR-0015 (build-output layout and bundle); `docs/agents/domain.md` (flag ADR
  conflicts explicitly rather than overwriting history)

---

## 1. Requirement

| #   | Requirement                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-a | The Windows packaging step must not depend on a pre-build script that extracts a winCodeSign toolset electron-builder 26 never consumes.                                                |
| R-b | The shipped `MarkFlow.exe` signing status must be explicit and deterministic — not an accidental side effect of whether the build machine happens to have the Windows SDK installed.    |
| R-c | We must document the real signing behavior truthfully, not the script's self-reported "cache prepared" message.                                                                         |
| R-d | The decision must stay reversible: if a code-signing certificate or Azure Trusted Signing becomes available later, enabling signing is a one-line config change, not a tooling rebuild. |

---

## 2. Evidence

- **Baseline build (2026-11-14, `npm run dist:win`, electron-builder 26.15.3, exit 0).** Log at
  `docs.local/dist-win-baseline.log`:
  - `[winCodeSign] Cache already prepared. Skipping.` is printed by `scripts/prepare-win-codesign.ps1`
    **itself** (the script's own marker), not by electron-builder.
  - No `downloading winCodeSign-2.6.0.7z`, no `using cached artifact` — electron-builder **never
    downloaded** the winCodeSign toolset.
  - `signing with signtool.exe` is printed by `app-builder-lib/out/codeSign/windowsCodeSign.js:13`
    **unconditionally** whenever `azureSignOptions` is unset. The actual signing decision happens
    later in `windowsSignToolManager.js:155-158` at DEBUG level: with no `certificateFile` /
    `WIN_CSC_LINK` / `certificateSubjectName` configured, it logs "no signing info identified,
    signing is skipped" and returns. So the INFO line is misleading.
  - `Get-AuthenticodeSignature release/win-unpacked/MarkFlow.exe` → **NotSigned**.
- **Cache directory (`%LOCALAPPDATA%\electron-builder\Cache`):** the only `winCodeSign` entry is the
  script-created `winCodeSign\winCodeSign-2.6.0` (`.win-only-extracted` marker dated 2026-07-10, plus
  `rcedit-*.exe` / `windows-*/signtool.exe` from 2019). It has **no** electron-builder `.state` /
  `.7z` / hash extractDir, so electron-builder ignores it. Resource editing in 26.x uses pure-JS
  `resedit`, not the script's `rcedit.exe`.
- **Proper-signing routes evaluated and found unavailable:**
  - Traditional CA certificate (OV/EV): requires purchasing a cert and securing the private key in CI
    secrets. Rejected — no certificate available.
  - Azure Trusted Signing (`win.azureSignOptions`, native in 26.15.3 via
    `windowsSignAzureManager.js`, authenticated through Azure `EnvironmentCredential`): requires an
    Azure subscription + Trusted Signing account + Key Vault + service principal. Rejected — no Azure
    account available.
  - Self-signed: produces a "signed" exe with an untrusted publisher, so SmartScreen still blocks end
    users. Not a real fix for distribution.

---

## 3. Decision

1. **Delete `scripts/prepare-win-codesign.ps1`** and remove its call from the `dist:win` npm script
   (`package.json`). The script pre-cached a winCodeSign toolset electron-builder 26 never reads, and
   its `.win-only-extracted` marker was self-referential.
2. **Set `win.signExecutable: false`** in `electron-builder.json5`. This makes "no signing" explicit
   and deterministic: electron-builder skips the signing attempt entirely (no misleading
   `signing with signtool.exe` INFO line, no dependence on whether the build machine has the Windows
   SDK / a system signtool). Resource editing (icons / version info) is preserved because it uses
   `resedit`, independent of `signExecutable`.
3. **Document the real behavior** in `README.md` / `README.zh-CN.md` / `CONTRIBUTING.md` /
   `QUICKSTART.md`: the Windows build does **not** download or use a signing toolset; the shipped exe
   is **unsigned** and Windows SmartScreen / "unknown publisher" may warn on first run (the user
   clicks "More info → Run anyway"). Remove the old claims about the pre-cache script, the
   `winCodeSign\winCodeSign-2.x.x` layout, the `.win-only-extracted` marker, developer-mode / admin
   requirements, and the `ELECTRON_BUILDER_CACHE` warning.
4. **Guard the change** with a string test (in `scripts/*.test.ts`, mirroring `packaging.test.ts`):
   `dist:win` must not reference the ps1, and `electron-builder.json5` must carry
   `signExecutable: false`. The CI Windows job keeps a log assertion that no `winCodeSign` download
   occurs.

---

## 4. Consequences

- **Positive:** one fewer moving part; `dist:win` no longer runs a no-op PowerShell script; the
  signing status is explicit and identical on every machine (no Windows-SDK-dependent behavior); the
  misleading log line is gone.
- **Positive:** the deleted script's only artifact (the stale `winCodeSign\winCodeSign-2.6.0` cache
  dir) can be cleaned up manually; electron-builder still downloads only what it actually needs
  (e.g. 7zip).
- **Negative / trade-off:** the shipped `MarkFlow.exe` is **unsigned**, so Windows SmartScreen /
  "unknown publisher" warns the first time a user runs it. This is an explicit, accepted trade-off
  given that no code-signing certificate or Azure Trusted Signing account is available.
- **Reversible:** enabling signing later is a one-line change — remove `win.signExecutable: false` and
  supply a cert (`win.certificateFile` + `CSC_KEY_PASSWORD`, or `WIN_CSC_LINK`) or
  `win.azureSignOptions` + Azure `EnvironmentCredential` env. No tooling rebuild required.
- **Not changed:** resource editing (icons / version) via `resedit`; the zip-only Windows target (no
  AppX); ADR-0015's bundle / output layout.
