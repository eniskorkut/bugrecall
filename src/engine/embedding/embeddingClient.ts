import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { EmbeddingError, EmbeddingJob, EmbeddingResult } from "./types.js";

type Pending = {
  resolve: (result: EmbeddingResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type WorkerState = "idle" | "loading" | "ready" | "failed" | "disabled";

export class EmbeddingClient {
  private worker: Worker | null = null;
  private pending = new Map<string, Pending>();
  private state: WorkerState = "idle";
  private lastError: string | null = null;

  async embed(recordId: string, text: string, model: string, timeoutMs: number): Promise<EmbeddingResult> {
    const worker = this.ensureWorker();
    const requestId = randomUUID();
    const job: EmbeddingJob = {
      request_id: requestId,
      record_id: recordId,
      model,
      text,
    };

    return await new Promise<EmbeddingResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Embedding timeout after ${timeoutMs}ms for ${recordId}`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
      worker.postMessage(job);
    });
  }

  shutdown(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.state = "idle";
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Embedding worker shutdown"));
    }
    this.pending.clear();
  }

  setDisabledState(): void {
    this.state = "disabled";
  }

  getState(): WorkerState {
    return this.state;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.state = "loading";
    this.lastError = null;
    console.error("[embedder] worker loading");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const workerPath = path.resolve(here, "../../workers/embedder.worker.js");
    const worker = new Worker(workerPath);
    worker.on("message", (message: EmbeddingResult | EmbeddingError) => {
      if (!message || typeof message !== "object" || !("request_id" in message)) return;
      const reqId = String(message.request_id);
      const pending = this.pending.get(reqId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(reqId);
      if ("error" in message) {
        this.state = "failed";
        this.lastError = message.error;
        pending.reject(new Error(message.error));
      } else {
        this.state = "ready";
        pending.resolve(message);
      }
    });
    worker.on("error", (error) => {
      this.state = "failed";
      this.lastError = error.message;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.worker = null;
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        this.state = "failed";
        this.lastError = `worker exited with code ${code}`;
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Embedding worker exited with code ${code}`));
        }
        this.pending.clear();
      } else if (this.state !== "disabled") {
        this.state = "idle";
      }
      this.worker = null;
    });
    this.worker = worker;
    return worker;
  }
}

let singleton: EmbeddingClient | null = null;
export function getEmbeddingClient(): EmbeddingClient {
  if (!singleton) singleton = new EmbeddingClient();
  return singleton;
}
