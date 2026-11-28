import "reflect-metadata";
import * as winston from "winston";

import config from "./config";
import { startTestdataCacheCleanup } from "./file";
import rpc from "./rpc";

if (process.getuid() !== 0) {
  winston.error("This program requires root to run");
  process.exit(1);
}

rpc.connect().then(() => {
  startTestdataCacheCleanup();
  for (let i = 0; i < config.taskConsumingThreads; i++) rpc.startTaskConsumerThread(i);
  return rpc.startHackConsumer();
});
