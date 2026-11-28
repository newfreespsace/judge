import fs from "fs";
import path from "path";

import winston from "winston";

const cacheFilename = /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|hack-[0-9a-f]{64})$/i;
const batchSize = 64;

async function forEachFile(files: string[], operation: (filename: string) => Promise<void>) {
  for (let offset = 0; offset < files.length; offset += batchSize) {
    await Promise.all(files.slice(offset, offset + batchSize).map(operation));
  }
}

export class TestdataCache {
  private readonly retained = new Map<string, number>();

  private usedWhileTrimming: Set<string>;

  private pendingRemoval: { filename: string; done: Promise<boolean> };

  private trimming: Promise<void>;

  constructor(private readonly directory: string, private readonly maxSize?: number) {}

  async retain(ids: string[]): Promise<() => Promise<void>> {
    if (this.maxSize == null) return async () => undefined;

    const filenames = [...new Set(ids)].filter(id => cacheFilename.test(id));
    for (const filename of filenames) {
      this.retained.set(filename, (this.retained.get(filename) ?? 0) + 1);
      this.usedWhileTrimming?.add(filename);
    }

    // Reserve all files before waiting for an unlink already in progress.
    const removal = this.pendingRemoval;
    if (removal && filenames.includes(removal.filename)) await removal.done;

    return async () => {
      await forEachFile(filenames, async filename => {
        this.usedWhileTrimming?.add(filename);
        const fullPath = path.join(this.directory, filename);
        try {
          const stat = await fs.promises.lstat(fullPath);
          if (stat.isFile()) await fs.promises.lutimes(fullPath, new Date(), stat.mtime);
        } catch (error) {
          if (error.code !== "ENOENT") winston.warn(`Could not record test data use: ${error.message}`);
        } finally {
          const count = this.retained.get(filename);
          if (count === 1) this.retained.delete(filename);
          else this.retained.set(filename, count - 1);
        }
      });
    };
  }

  async trim(): Promise<void> {
    if (this.maxSize == null) return;
    if (!this.trimming) {
      this.usedWhileTrimming = new Set<string>();
      this.trimming = this.removeColdFiles().finally(() => {
        this.usedWhileTrimming = undefined;
        this.trimming = undefined;
      });
    }
    await this.trimming;
  }

  private async removeColdFiles() {
    const files = await fs.promises.readdir(this.directory, { withFileTypes: true });
    const candidates: { filename: string; size: number; lastUse: number }[] = [];
    await forEachFile(
      files.filter(file => file.isFile() && cacheFilename.test(file.name)).map(file => file.name),
      async filename => {
        try {
          const stat = await fs.promises.lstat(path.join(this.directory, filename));
          if (stat.isFile())
            candidates.push({ filename, size: stat.size, lastUse: Math.max(stat.atimeMs, stat.mtimeMs) });
        } catch (error) {
          if (error.code !== "ENOENT") winston.warn(`Could not inspect cached test data: ${error.message}`);
        }
      }
    );

    let size = candidates.reduce((total, file) => total + file.size, 0);
    if (size <= this.maxSize) return;

    candidates.sort((a, b) => a.lastUse - b.lastUse || a.filename.localeCompare(b.filename));
    for (const file of candidates) {
      if (size <= this.maxSize) break;
      if (this.retained.has(file.filename) || this.usedWhileTrimming.has(file.filename)) continue;

      const done = fs.promises.unlink(path.join(this.directory, file.filename)).then(
        () => true,
        error => {
          if (error.code === "ENOENT") return true;
          winston.warn(`Could not evict cached test data: ${error.message}`);
          return false;
        }
      );
      this.pendingRemoval = { filename: file.filename, done };
      if (await done) size -= file.size;
      this.pendingRemoval = undefined;
    }
  }
}
