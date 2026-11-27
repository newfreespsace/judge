const assert = require("node:assert/strict");
const fs = require("node:fs");

const builtinCheckers = require("../build/Release/builtin_checkers.node");
const fsNative = require("../build/Release/fs_native.node");
const posix = require("../build/Release/posix.node");

assert.equal(typeof builtinCheckers.runBuiltinChecker, "function");
assert.equal(typeof fsNative.ensureDirSync, "function");

const { read, write } = posix.pipe();
try {
  const message = Buffer.from("judge");
  const received = Buffer.alloc(message.length);
  assert.equal(fs.writeSync(write, message), message.length);
  assert.equal(fs.readSync(read, received, 0, received.length, null), received.length);
  assert.deepEqual(received, message);
} finally {
  posix.close(read);
  posix.close(write);
}
