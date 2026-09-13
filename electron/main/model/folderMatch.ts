// folderMatch.ts re-exports the document store's path-matching helper.
//
// `isInFolder` is now defined ONCE in shared/fileUtils.ts (single source, shared by
// main and renderer). It is re-exported here so `documentStore` and any tests that
// import from folderMatch keep working unchanged.
export { isInFolder } from '../../../shared/fileUtils'
