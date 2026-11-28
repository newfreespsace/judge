import fs from "fs";
import { createHash, randomUUID } from "crypto";

import { SandboxStatus } from "simple-sandbox";

import { compile, CompileResultSuccess, CompileTask } from "@/compile";
import { CanceledError } from "@/error";
import { getFile, retainTestdata } from "@/file";
import * as fsNative from "@/fsNative";
import getLanguage from "@/languages";
import { CpuAffinityStrategy, runSandbox, SANDBOX_INSIDE_PATH_BINARY, SANDBOX_INSIDE_PATH_WORKING } from "@/sandbox";
import { runTaskQueued } from "@/taskQueue";
import { safelyJoinPath } from "@/utils";

import {
  HackJudgeInfo,
  runHackTarget,
  SubmissionContentTraditional,
  TestcaseStatusTraditional
} from "./submission/traditional";

export interface HackTask {
  taskId: string;
  snapshot: {
    judgeInfo: HackJudgeInfo;
    validator: CompileTask;
    reference: CompileTask;
    testData: Record<string, string>;
    artifacts: Record<string, string>;
  };
  input: Buffer;
  referenceOutput?: Buffer;
  target: SubmissionContentTraditional;
  outputLimit: number;
}

export interface HackReport {
  outcome: "Succeeded" | "Failed" | "InvalidInput" | "JudgeError";
  verdict?: TestcaseStatusTraditional;
  output?: Buffer;
}

const INVALID_INPUT_EXIT_CODE = 1;

const failingVerdicts = new Set([
  TestcaseStatusTraditional.WrongAnswer,
  TestcaseStatusTraditional.RuntimeError,
  TestcaseStatusTraditional.TimeLimitExceeded,
  TestcaseStatusTraditional.MemoryLimitExceeded,
  TestcaseStatusTraditional.OutputLimitExceeded,
  TestcaseStatusTraditional.FileError
]);

async function storeArtifact(id: string, encoded: string) {
  const bytes = Buffer.from(encoded, "base64");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (id !== `hack-${digest}`) throw new Error("Invalid Hack artifact");

  const file = getFile(id);
  if (await fsNative.exists(file)) return;
  const tempFile = `${file}.${randomUUID()}`;
  try {
    await fs.promises.writeFile(tempFile, bytes, { flag: "wx", mode: 0o600 });
    await fs.promises.rename(tempFile, file);
  } finally {
    await fsNative.remove(tempFile);
  }
}

async function readReferenceOutput(filename: string, limit: number) {
  // eslint-disable-next-line no-bitwise
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const file = await fs.promises.open(filename, flags);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid Hack reference output");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function runSupportProgram(task: HackTask, program: CompileTask, validate: boolean) {
  const cppDefines =
    validate && program.language === "cpp" ? { FAIL_EXIT_CODE: String(INVALID_INPUT_EXIT_CODE) } : undefined;
  const compiled = await compile(program, cppDefines);
  if (!(compiled instanceof CompileResultSuccess)) throw new Error("Failed to compile Hack support program");

  const { timeLimit, memoryLimit, fileIo } = task.snapshot.judgeInfo;
  const useFileIo = !validate && fileIo;
  try {
    return await runTaskQueued(async directory => {
      const binary = { outside: compiled.binaryDirectory, inside: SANDBOX_INSIDE_PATH_BINARY };
      const working = { outside: safelyJoinPath(directory, "working"), inside: SANDBOX_INSIDE_PATH_WORKING };
      const temp = safelyJoinPath(directory, "temp");
      const input = safelyJoinPath(working, useFileIo ? fileIo.inputFilename : randomUUID());
      const output = safelyJoinPath(working, useFileIo ? fileIo.outputFilename : randomUUID());
      const stderr = safelyJoinPath(working, randomUUID());
      try {
        await Promise.all([fsNative.ensureDir(working.outside), fsNative.ensureDir(temp)]);
        await fs.promises.writeFile(input.outside, task.input);
        const result = await runSandbox(task.taskId, {
          ...getLanguage(program.language).run({
            binaryDirectoryInside: binary.inside,
            workingDirectoryInside: working.inside,
            compileAndRunOptions: program.compileAndRunOptions,
            compileResultExtraInfo: compiled.extraInfo,
            time: timeLimit,
            memory: memoryLimit,
            stdinFile: useFileIo ? null : input.inside,
            stdoutFile: useFileIo ? null : output.inside,
            stderrFile: stderr.inside,
            parameters: []
          }),
          time: timeLimit,
          memory: memoryLimit * 1024 * 1024,
          workingDirectory: working.inside,
          tempDirectoryOutside: temp,
          extraMounts: [
            { mappedPath: binary, readOnly: true },
            { mappedPath: working, readOnly: false }
          ],
          cpuAffinity: CpuAffinityStrategy.UserProgram
        });

        // The sandbox reports all normal exits as OK and provides the exit code separately.
        if (validate && result.status === SandboxStatus.OK && result.code === INVALID_INPUT_EXIT_CODE) return null;
        if (result.status !== SandboxStatus.OK || result.code !== 0) throw new Error("Hack support program failed");
        return validate ? Buffer.alloc(0) : await readReferenceOutput(output.outside, task.outputLimit);
      } finally {
        await fsNative.emptyDir(directory);
      }
    });
  } finally {
    await compiled.dereference();
  }
}

export async function runHack(task: HackTask): Promise<HackReport> {
  let releaseTestdata: () => Promise<void>;
  try {
    const { snapshot, input, target, taskId } = task;
    releaseTestdata = await retainTestdata([...Object.values(snapshot.testData), ...Object.keys(snapshot.artifacts)]);
    await Promise.all(Object.entries(snapshot.artifacts).map(([id, bytes]) => storeArtifact(id, bytes)));

    let output = task.referenceOutput;
    if (!output) {
      if ((await runSupportProgram(task, snapshot.validator, true)) === null) return { outcome: "InvalidInput" };
      output = await runSupportProgram(task, snapshot.reference, false);
    }

    const judgeTarget = () => runHackTarget(taskId, snapshot.judgeInfo, snapshot.testData, target, input, output);
    let verdict = await judgeTarget();
    let confirmed = true;
    if (verdict === TestcaseStatusTraditional.TimeLimitExceeded) {
      verdict = await judgeTarget();
      confirmed = verdict === TestcaseStatusTraditional.TimeLimitExceeded;
    }
    if (verdict === TestcaseStatusTraditional.JudgementFailed) return { outcome: "JudgeError" };
    return { outcome: confirmed && failingVerdicts.has(verdict) ? "Succeeded" : "Failed", verdict, output };
  } catch (error) {
    if (error instanceof CanceledError) throw error;
    return { outcome: "JudgeError" };
  } finally {
    await releaseTestdata?.();
  }
}
