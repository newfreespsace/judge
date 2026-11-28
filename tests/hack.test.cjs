const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtempSync, rmSync } = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "judge-hack-"));
process.once("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));

const sandboxStatus = { OK: "OK", RuntimeError: "RuntimeError" };
const verdict = {
  Accepted: "Accepted",
  WrongAnswer: "WrongAnswer",
  PartiallyCorrect: "PartiallyCorrect",
  TimeLimitExceeded: "TimeLimitExceeded",
  JudgementFailed: "JudgementFailed",
  FileError: "FileError",
  RuntimeError: "RuntimeError",
  MemoryLimitExceeded: "MemoryLimitExceeded",
  OutputLimitExceeded: "OutputLimitExceeded"
};

class CanceledError extends Error {}
class CompileResultSuccess {
  binaryDirectory = "/compiled";
  extraInfo = {};

  async dereference() {}
}

async function loadSource(filename, deps, globals = {}) {
  const code = await fs.readFile(path.join(__dirname, "../src", filename), "utf8");
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true }
  }).outputText;
  const exports = {};
  new Function("require", "exports", ...Object.keys(globals), js)(
    name => deps[name] ?? require(name),
    exports,
    ...Object.values(globals)
  );
  return exports;
}

async function loadWorker({ target = [], support = [] } = {}) {
  const directory = await fs.mkdtemp(path.join(fixtureRoot, "worker-"));
  const calls = { target: [], support: [], compile: [], cleanup: 0, retained: [], released: 0 };
  const deps = {
    "simple-sandbox": { SandboxStatus: sandboxStatus },
    "@/compile": {
      compile: async program => {
        calls.compile.push(program);
        return new CompileResultSuccess();
      },
      CompileResultSuccess
    },
    "@/error": { CanceledError },
    "@/file": {
      getFile: id => path.join(directory, id),
      retainTestdata: async ids => {
        calls.retained.push(...new Set(ids));
        return async () => {
          calls.released++;
        };
      }
    },
    "@/fsNative": {
      exists: filename =>
        fs.access(filename).then(
          () => true,
          () => false
        ),
      remove: filename => fs.rm(filename, { force: true }),
      ensureDir: filename => fs.mkdir(filename, { recursive: true }),
      emptyDir: async filename => {
        calls.cleanup++;
        await fs.rm(filename, { recursive: true, force: true });
      }
    },
    "@/languages": () => ({ run: options => options }),
    "@/sandbox": {
      CpuAffinityStrategy: { UserProgram: "user" },
      SANDBOX_INSIDE_PATH_BINARY: "/binary",
      SANDBOX_INSIDE_PATH_WORKING: "/working",
      runSandbox: async (taskId, options) => {
        const workingDir = options.extraMounts[1].mappedPath.outside;
        const { status, code, output, inputFile, outputFile } = support[calls.support.length];
        const input = await fs.readFile(path.join(workingDir, inputFile ?? path.basename(options.stdinFile)));
        calls.support.push({ taskId, options, input });
        if (output) await fs.writeFile(path.join(workingDir, outputFile ?? path.basename(options.stdoutFile)), output);
        return { status, code };
      }
    },
    "@/taskQueue": { runTaskQueued: async callback => callback(await fs.mkdtemp(path.join(directory, "task-"))) },
    "@/utils": {
      safelyJoinPath: (base, name) =>
        typeof base === "string"
          ? path.join(base, name)
          : { inside: path.join(base.inside, name), outside: path.join(base.outside, name) }
    },
    "./submission/traditional": {
      TestcaseStatusTraditional: verdict,
      runHackTarget: async (...args) => {
        const next = target[calls.target.length];
        calls.target.push(args);
        if (next instanceof Error) throw next;
        assert.ok(next, "unexpected target execution");
        return next;
      }
    }
  };

  const { runHack } = await loadSource("task/hack.ts", deps);
  return { runHack, calls, directory };
}

function task(referenceOutput) {
  return {
    taskId: "hack-test-task",
    snapshot: {
      judgeInfo: { timeLimit: 1000, memoryLimit: 128, checker: { type: "builtin" } },
      validator: { language: "cpp", code: "validator", compileAndRunOptions: {} },
      reference: { language: "cpp", code: "reference", compileAndRunOptions: {} },
      testData: {},
      artifacts: {}
    },
    input: Buffer.from("输入\r\n  \n"),
    referenceOutput,
    target: { language: "cpp", code: "target", compileAndRunOptions: {} },
    outputLimit: 128
  };
}

test("validates stdin then preserves raw reference output for a file I/O target", async () => {
  const output = Buffer.from([0, 255, 13, 10]);
  const artifact = Buffer.from("checker artifact");
  const artifactId = "hack-" + createHash("sha256").update(artifact).digest("hex");
  const { runHack, calls, directory } = await loadWorker({
    support: [
      { status: sandboxStatus.OK },
      { status: sandboxStatus.OK, output, inputFile: "p.in", outputFile: "p.out" }
    ],
    target: [verdict.WrongAnswer]
  });
  const request = task();
  request.snapshot.judgeInfo.fileIo = { inputFilename: "p.in", outputFilename: "p.out" };
  request.snapshot.artifacts[artifactId] = artifact.toString("base64");
  request.snapshot.testData["checker.cpp"] = artifactId;
  assert.deepEqual(await runHack(request), { outcome: "Succeeded", verdict: verdict.WrongAnswer, output });
  assert.deepEqual(calls.compile, [request.snapshot.validator, request.snapshot.reference]);
  assert.deepEqual(
    calls.support.map(call => call.input),
    [request.input, request.input]
  );
  assert.ok(calls.support[0].options.stdinFile);
  assert.equal(calls.support[1].options.stdinFile, null);
  assert.equal(calls.target[0][2]["checker.cpp"], artifactId);
  assert.deepEqual(calls.target[0].slice(-2), [request.input, output]);
  assert.deepEqual(await fs.readFile(path.join(directory, artifactId)), artifact);
  assert.equal(calls.cleanup, 2);
  assert.deepEqual(calls.retained, [artifactId]);
  assert.equal(calls.released, 1);
});

test("uses the stored output on replay and confirms TLE with identical bytes", async () => {
  const { runHack, calls } = await loadWorker({
    target: [verdict.TimeLimitExceeded, verdict.TimeLimitExceeded]
  });
  const output = Buffer.alloc(0);
  assert.deepEqual(await runHack(task(output)), {
    outcome: "Succeeded",
    verdict: verdict.TimeLimitExceeded,
    output
  });
  assert.equal(calls.compile.length, 0);
  assert.equal(calls.target.length, 2);
  assert.deepEqual(calls.target[0], calls.target[1]);
});

for (const [label, target, outcome] of [
  ["accepted", [verdict.Accepted], "Failed"],
  ["partial credit", [verdict.PartiallyCorrect], "Failed"],
  ["a different failure during TLE confirmation", [verdict.TimeLimitExceeded, verdict.WrongAnswer], "Failed"],
  ["a checker failure", [verdict.JudgementFailed], "JudgeError"]
]) {
  test(`classifies ${label}`, async () => {
    const { runHack, calls } = await loadWorker({ target });
    assert.equal((await runHack(task(Buffer.from("answer")))).outcome, outcome);
    assert.equal(calls.target.length, target.length);
  });
}

for (const [label, support, outcome] of [
  ["validator rejection", [{ status: sandboxStatus.RuntimeError, code: 1 }], "InvalidInput"],
  ["validator crash", [{ status: sandboxStatus.RuntimeError, code: 2 }], "JudgeError"],
  ["reference crash", [{ status: sandboxStatus.OK }, { status: sandboxStatus.RuntimeError, code: 1 }], "JudgeError"],
  [
    "oversized output",
    [{ status: sandboxStatus.OK }, { status: sandboxStatus.OK, output: Buffer.alloc(129) }],
    "JudgeError"
  ]
]) {
  test(`stops before judging the target on ${label}`, async () => {
    const { runHack, calls } = await loadWorker({ support });
    assert.deepEqual(await runHack(task()), { outcome });
    assert.equal(calls.target.length, 0);
    assert.equal(calls.cleanup, support.length);
  });
}

test("rejects corrupted artifacts and propagates cancellation", async () => {
  const { runHack, calls } = await loadWorker({ target: [new CanceledError()] });
  const request = task(Buffer.from("answer"));
  request.snapshot.artifacts["hack-bad"] = "eA==";
  assert.deepEqual(await runHack(request), { outcome: "JudgeError" });
  assert.equal(calls.target.length, 0);
  request.snapshot.artifacts = {};
  await assert.rejects(runHack(request), CanceledError);
});

test("RPC skips the queue for old servers and stops work when the lease is rejected", async () => {
  const { EventEmitter } = require("node:events");
  const socket = new EventEmitter();
  const calls = [];
  const intervals = new Set();
  const request = task(Buffer.from("answer"));
  let capabilities;
  let release;
  let nextTask = request;
  const work = new Promise(resolve => {
    release = resolve;
  });
  const log = () => {};
  const config = { serverUrl: "https://example.test", key: "fixture", rpcTimeout: 1000 };
  const { RPC } = await loadSource(
    "rpc.ts",
    {
      "socket.io-client": () => {
        queueMicrotask(() => socket.emit("ready", "fixture", {}, capabilities));
        return socket;
      },
      winston: { info: log, error: log },
      "./config": { __esModule: true, default: config, updateServerSideConfig: log },
      "./task": {},
      "./task/hack": {
        runHack: () => work
      },
      "./systemInfo": async () => ({}),
      "./error": { CanceledError }
    },
    {
      setInterval: fn => intervals.add(fn) && fn,
      clearInterval: fn => intervals.delete(fn)
    }
  );

  const oldRpc = new RPC();
  await oldRpc.connect();
  await oldRpc.startHackConsumer();
  assert.equal(intervals.size, 0);

  socket.on("claimHack", (version, ack) => {
    assert.equal(version, 1);
    if (!nextTask) return ack(null);
    calls.push("claim");
    ack(nextTask);
    nextTask = null;
  });
  socket.on("heartbeatHack", (id, ack) => {
    assert.equal(id, request.taskId);
    calls.push("heartbeat");
    ack(false);
  });
  socket.on("finishHack", () => calls.push("finish"));

  capabilities = { hack: 1 };
  const rpc = new RPC();
  await rpc.connect();
  // Stop the consumer on its next claim after the cancelled task.
  const requestRpc = rpc.request.bind(rpc);
  const stop = new Error("stop fixture consumer");
  rpc.request = (event, payload) => {
    if (event === "claimHack" && !nextTask) return Promise.reject(stop);
    return requestRpc(event, payload);
  };
  const consumed = assert.rejects(rpc.startHackConsumer(), { message: stop.message });
  await new Promise(resolve => setImmediate(resolve));
  const [heartbeat] = intervals;
  assert.ok(heartbeat);
  assert.equal(rpc.isCanceled(request.taskId), false);
  await heartbeat();
  assert.equal(rpc.isCanceled(request.taskId), true);
  release({ outcome: "Failed", verdict: verdict.Accepted, output: request.referenceOutput });
  await consumed;
  assert.deepEqual(calls, ["claim", "heartbeat"]);
  assert.equal(intervals.size, 0);
});
