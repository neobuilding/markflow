// Fixture: a block plugin whose default export is NOT a function. Used to
// verify loader.mjs skips such plugins (warns) instead of registering them or
// crashing. The number 123 is intentionally not callable.
export default 123
