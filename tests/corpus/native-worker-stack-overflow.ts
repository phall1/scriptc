import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

function deep(n: number): number {
  return n === 0 ? 0 : deep(n - 1) + 1;
}
function endless(n: number): number {
  return endless(n + 1) + 1;
}

if (isMainThread) {
  for (const mode of ["caught", "uncaught"]) {
    await new Promise<void>((resolve) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: mode });
      worker.on("message", (text: string) => console.log(mode, "message", text));
      worker.on("error", (error: Error) =>
        console.log(mode, "error", error.name, error.message, error instanceof RangeError),
      );
      worker.on("exit", (code: number) => {
        console.log(mode, "exit", code);
        resolve();
      });
    });
  }
  console.log("main", deep(3000));
} else if (workerData === "caught") {
  try {
    endless(0);
  } catch (e) {
    parentPort!.postMessage(`${e instanceof RangeError} ${(e as Error).message}`);
  }
  parentPort!.postMessage(`still running ${deep(3000)}`);
} else {
  parentPort!.postMessage(`before ${deep(2000)}`);
  endless(0);
}
