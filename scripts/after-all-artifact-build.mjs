// electron-builder `afterAllArtifactBuild` hook (wired in electron-builder.json5).
// Reports where the packaged app landed, so `npm run dist` doesn't leave you hunting
// through the repo for the output. electron-builder loads it via
// app-builder-lib's resolveFunction → dynamicImportMaybe (import, with require fallback).
import { relative, join } from 'node:path'

export async function afterAllArtifactBuild(buildResult) {
  const artifacts = buildResult?.artifactPaths ?? []
  console.log('\n✅ Packaged app written to: release/')
  for (const artifact of artifacts) {
    console.log(`   • ${relative(process.cwd(), artifact)}`)
  }
  console.log(`   • Full path: ${join(process.cwd(), 'release')}\n`)
  // Return nothing: there are no extra artifacts to publish.
}

export default afterAllArtifactBuild
