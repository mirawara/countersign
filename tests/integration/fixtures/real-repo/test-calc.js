const assert = require("node:assert/strict");
const test = require("node:test");
const { add } = require("./calc");

test("add returns the sum", () => {
  assert.equal(add(2, 3), 5);
});
