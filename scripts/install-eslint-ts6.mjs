// Side-by-side install of the TypeScript 6 API for typescript-eslint.
//
// typescript-eslint v8 only supports typescript <6.1.0, but the project itself
// uses TypeScript 7. Microsoft's documented TS7 approach is to run the linter
// "side-by-side" with the TS6 API: https://devblogs.microsoft.com/typescript/
// announcing-typescript-7-0/#running-side-by-side-with-typescript-6
//
// We install TS6 into the two node_modules locations that the @typescript-eslint/*
// packages resolve `typescript` from, so ESLint parses with TS6 while the rest of
// the build keeps using TS7. The project's package.json / lockfile are never
// touched (we copy a prebuilt TS6 into place rather than letting npm rebuild trees).
//
// Invoked from `postinstall` (so `npx eslint .` works for devs) and from the
// `lint` / `lint:fix` scripts (idempotent, and a safe fallback after `npm ci`).
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()

// Where the @typescript-eslint/* packages (and the meta package) look for `typescript`
// before falling back to the root-level TS7.
const targets = [
  path.join(root, 'node_modules', 'typescript-eslint', 'node_modules'),
  path.join(root, 'node_modules', '@typescript-eslint', 'node_modules'),
  // ts-api-utils is a transitive dep of @typescript-eslint/utils and must see the
  // same TS6 API, otherwise its type-flag checks blow up against the TS7 types.
  path.join(root, 'node_modules', 'ts-api-utils', 'node_modules'),
]

// Already bootstrapped? Skip to keep repeated `npm run lint` fast and offline.
const alreadyDone = targets.every((t) => {
  const pkg = path.join(t, 'typescript', 'package.json')
  if (!existsSync(pkg)) return false
  try {
    return (JSON.parse(readFileSync(pkg, 'utf8')).version || '').startsWith('6.')
  } catch {
    return false
  }
})
if (alreadyDone) {
  console.log('[eslint-ts6] TypeScript 6 API already in place for typescript-eslint — skipping.')
  process.exit(0)
}

// Install TS6 into an isolated temp project so npm does NOT pull the root tree.
const tmp = path.join(os.tmpdir(), 'markflow-ts6-' + Date.now())
mkdirSync(tmp, { recursive: true })
writeFileSync(
  path.join(tmp, 'package.json'),
  JSON.stringify({ name: 'markflow-ts6-tmp', version: '1.0.0', private: true }),
)
try {
  execSync('npm install typescript@^6 --no-audit --no-fund', { stdio: 'inherit', cwd: tmp })
} catch (err) {
  // Never break `npm ci` / `postinstall`: warn and continue. The `lint` script also
  // calls this, so a later attempt (after `npm ci` releases its cache lock) will retry.
  console.warn('[eslint-ts6] warning: could not install TypeScript 6 API:', err?.message || err)
  process.exit(0)
}

const srcTs = path.join(tmp, 'node_modules', 'typescript')
if (!existsSync(srcTs)) {
  console.warn('[eslint-ts6] warning: TypeScript 6 was not installed; eslint may fail under TS7.')
  process.exit(0)
}

for (const target of targets) {
  mkdirSync(target, { recursive: true })
  const dest = path.join(target, 'typescript')
  rmSync(dest, { recursive: true, force: true })
  cpSync(srcTs, dest, { recursive: true })
  console.log(`[eslint-ts6] TypeScript 6 API placed at ${path.relative(root, dest)}`)
}

rmSync(tmp, { recursive: true, force: true })
console.log('[eslint-ts6] done. typescript-eslint will now run against the TS6 API.')
