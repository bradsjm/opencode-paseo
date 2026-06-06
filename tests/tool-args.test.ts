import assert from "node:assert/strict"
import test from "node:test"
import {
  collapseNull,
  compactDefined,
  optionalNumber,
  optionalTrimmedString,
  requiredTrimmedString,
} from "../lib/tools/args.js"

test("tool arg helpers collapse null to omission without dropping falsey values", async (t) => {
  await t.test("collapseNull and optionalNumber treat null like undefined", () => {
    assert.equal(collapseNull(null), undefined)
    assert.equal(collapseNull(undefined), undefined)
    assert.equal(optionalNumber(null), undefined)
    assert.equal(optionalNumber(0), 0)
  })

  await t.test("optionalTrimmedString trims meaningful values and omits blank/null", () => {
    assert.equal(optionalTrimmedString(null), undefined)
    assert.equal(optionalTrimmedString("   "), undefined)
    assert.equal(optionalTrimmedString("  value  "), "value")
  })

  await t.test("requiredTrimmedString rejects blank input", () => {
    assert.throws(() => requiredTrimmedString(null, "field"), /field must not be empty/)
    assert.equal(requiredTrimmedString("  value  ", "field"), "value")
  })

  await t.test("compactDefined removes only undefined keys", () => {
    assert.deepEqual(compactDefined({ a: undefined, b: null, c: false, d: 0, e: "", f: [] as unknown[] }), {
      b: null,
      c: false,
      d: 0,
      e: "",
      f: [],
    })
  })
})
