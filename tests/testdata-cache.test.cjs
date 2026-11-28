const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "judge-testdata-"));
process.once("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "hack-" + "a".repeat(64)
];

async function loadSource(filename, deps = {}, globals = {}) {
  const code = await fs.readFile(path.join(__dirname, "../src", filename), "utf8");
  const { outputText } = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true }
  });
  const exports = {};
  new Function("require", "exports", ...Object.keys(globals), outputText)(
    name => deps[name] ?? require(name),
    exports,
    ...Object.values(globals)
  );
  return exports;
}

async function fixture(maxSize) {
  const directory = await fs.mkdtemp(path.join(fixtureRoot, "cache-"));
  const { TestdataCache } = await loadSource("testdata-cache.ts");

  const filename = name => path.join(directory, name);
  const put = async (name, lastUse, modified = lastUse) => {
    await fs.writeFile(filename(name), "test");
    await fs.utimes(filename(name), lastUse, modified);
  };
  return { directory, filename, put, cache: new TestdataCache(directory, maxSize), TestdataCache };
}

test("evicts by last use and keeps the timestamp across worker restarts", async () => {
  const { directory, filename, put, cache, TestdataCache } = await fixture(8);
  const [mostRecentlyUsed, oldest, newer] = ids;
  await put(mostRecentlyUsed, 100);
  await put(oldest, 200, 150);
  await put(newer, 300, 110);

  const release = await cache.retain([mostRecentlyUsed]);
  await release();
  const cached = await fs.stat(filename(mostRecentlyUsed));
  assert.ok(cached.atimeMs > 300000);
  assert.equal(cached.mtimeMs, 100000);

  await new TestdataCache(directory, 8).trim();
  assert.deepEqual((await fs.readdir(directory)).sort(), [mostRecentlyUsed, newer]);
});

test("keeps files until every task releases them and excludes temporary files and symlinks", async () => {
  const { directory, filename, put, cache } = await fixture(4);
  const [active, cold, symbolic, hack] = ids;
  await put(active, 100);
  await put(cold, 200);
  await put(hack, 300);
  await put("unmanaged", 100);
  await fs.mkdir(filename("temp"));
  await fs.symlink(filename("unmanaged"), filename(symbolic));

  const releaseFirst = await cache.retain([active, active, hack]);
  const releaseSecond = await cache.retain([active]);
  await releaseFirst();
  await cache.trim();
  assert.deepEqual((await fs.readdir(directory)).sort(), [active, symbolic, "temp", "unmanaged"].sort());
  assert.ok((await fs.lstat(filename(symbolic))).isSymbolicLink());

  await releaseSecond();
  await put(cold, 100);
  await cache.trim();
  assert.deepEqual((await fs.readdir(directory)).sort(), [active, symbolic, "temp", "unmanaged"].sort());
});

test("waits for an in-flight eviction before a new task can replace a cache miss", async () => {
  const { directory, filename, put, cache } = await fixture(4);
  const [oldest, newer] = ids;
  await put(oldest, 100);
  await put(newer, 200);
  const requests = [];
  const { ensureFiles, retainTestdata } = await loadSource("file.ts", {
    winston: { verbose: () => {}, info: () => {} },
    "./config": { dataStore: directory, dataStoreMaxSize: 4, maxConcurrentDownloads: 1 },
    "./rpc": {
      requestFiles: async files => {
        requests.push(files);
        return ["fixture-url"];
      }
    },
    "./testdata-cache": {
      TestdataCache: function FixtureCache() {
        return cache;
      }
    },
    "./fsNative": {
      ensureDir: name => fs.mkdir(name, { recursive: true }),
      exists: name =>
        fs.access(name).then(
          () => true,
          () => false
        )
    },
    "./utils": {
      safelyJoinPath: path.join,
      download: async (url, name) => {
        assert.equal(url, "fixture-url");
        await fs.writeFile(name, "test");
      },
      waitForAll: promises => Promise.all(promises)
    }
  });
  const unlink = fs.unlink;
  let start;
  let resume;
  const started = new Promise(resolve => {
    start = resolve;
  });
  const pendingRemoval = new Promise(resolve => {
    resume = resolve;
  });
  fs.unlink = async name => {
    if (name === filename(oldest)) {
      start();
      await pendingRemoval;
    }
    return unlink(name);
  };
  const trimming = cache.trim();
  await started;
  let acquired = false;
  const acquiring = retainTestdata([oldest]).then(release => {
    acquired = true;
    return release;
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(acquired, false);
  } finally {
    resume();
    fs.unlink = unlink;
  }
  const release = await acquiring;
  await trimming;
  await assert.rejects(fs.stat(filename(oldest)), { code: "ENOENT" });
  await ensureFiles([oldest, newer]);
  assert.deepEqual(requests, [[oldest]]);
  await cache.trim();
  assert.equal(await fs.readFile(filename(oldest), "utf8"), "test");
  await release();
});

test("preserves an existing cache when no size limit is configured", async () => {
  const { directory, put, cache } = await fixture();
  await put(ids[0], 100);
  const release = await cache.retain([ids[0]]);
  await release();
  await cache.trim();
  assert.deepEqual(await fs.readdir(directory), [ids[0]]);
});

async function cleanupSchedule(initialTime, trim) {
  const timers = [];
  const warnings = [];
  let now = initialTime;
  const { startTestdataCacheCleanup } = await loadSource(
    "file.ts",
    {
      winston: { warn: message => warnings.push(message) },
      "./config": { dataStore: fixtureRoot, dataStoreMaxSize: 4, maxConcurrentDownloads: 1 },
      "./rpc": {},
      "./fsNative": {},
      "./testdata-cache": {
        TestdataCache: function FixtureCache() {
          return { trim };
        }
      },
      "./utils": {}
    },
    {
      Date: class extends Date {
        constructor(value = now) {
          super(value);
        }
      },
      setTimeout: (callback, delay) => {
        timers.push({ callback, at: now.getTime() + delay });
        return { unref() {} };
      }
    }
  );
  startTestdataCacheCleanup();
  return {
    timers,
    warnings,
    async runNextTimer() {
      const { callback, at } = timers.shift();
      now = new Date(at);
      await callback();
    }
  };
}

test("first checks at 03:00 and schedules the next day after a failed cleanup", async () => {
  let calls = 0;
  const schedule = await cleanupSchedule(new Date(2026, 10, 28, 2, 55), async () => {
    calls++;
    if (calls === 1) throw new Error("fixture failure");
  });
  assert.equal(calls, 0);
  assert.deepEqual(
    schedule.timers.map(timer => timer.at),
    [new Date(2026, 10, 28, 3).getTime()]
  );

  await schedule.runNextTimer();
  assert.equal(calls, 1);
  assert.match(schedule.warnings[0], /fixture failure/);
  assert.deepEqual(
    schedule.timers.map(timer => timer.at),
    [new Date(2026, 10, 29, 3).getTime()]
  );

  await schedule.runNextTimer();
  assert.equal(calls, 2);
  assert.deepEqual(
    schedule.timers.map(timer => timer.at),
    [new Date(2026, 10, 30, 3).getTime()]
  );
});

test("a restart after 03:00 schedules the next calendar day", async () => {
  const schedule = await cleanupSchedule(new Date(2026, 10, 30, 15), async () => {
    assert.fail("restart must not trigger cleanup");
  });
  assert.deepEqual(
    schedule.timers.map(timer => timer.at),
    [new Date(2026, 11, 1, 3).getTime()]
  );
});
