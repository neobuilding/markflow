// Fixture: a block plugin that throws a non-Error value (a plain string) on
// import. Used to verify loader.mjs's catch branch falls back to String(err)
// (not err.message) when the thrown value has no `.message`.
throw 'boom'
