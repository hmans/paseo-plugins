import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConditionExpression, ConditionResult, ReadyWorkflow } from "../shared/workflow";
import { atomicWrite, isMissing } from "./store";

const builtins: Record<string, { interval: number; run(cwd: string, signal: AbortSignal, timeout: number): Promise<ConditionResult> }> = {
  "git.dirty": {
    interval: 2000,
    async run(cwd, signal, timeout) {
      const check = await runCheck(["git", "--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"], cwd, timeout, signal);
      if (check.error) return unknown(check.error);
      return check.code === 0 ? value(check.output.length > 0) : unknown("Git status failed. Is this workspace a Git checkout?");
    },
  },
};

const unknown = (message: string): ConditionResult => ({ value: "unknown", message });
const value = (result: boolean): ConditionResult => ({ value: result ? "true" : "false" });
export function milliseconds(duration: string) {
  const [, amount, unit] = /^(\d+)(ms|s|m)$/.exec(duration)!;
  return Math.min(Number(amount) * ({ ms: 1, s: 1000, m: 60000 }[unit]!), 3600000);
}

export async function evaluate(expression: ConditionExpression, resolve: (name: string) => Promise<ConditionResult>): Promise<ConditionResult> {
  if (typeof expression === "string") return resolve(expression);
  if ("not" in expression) {
    const result = await evaluate(expression.not, resolve);
    return result.value === "unknown" ? result : value(result.value === "false");
  }
  const all = "all" in expression;
  let uncertain: ConditionResult | undefined;
  for (const child of "all" in expression ? expression.all : expression.any) {
    const result = await evaluate(child, resolve);
    if (result.value === (all ? "false" : "true")) return result;
    if (result.value === "unknown") uncertain = result;
  }
  return uncertain ?? value(all);
}

// Bounded output, no implicit shell, and process-group cleanup on POSIX.
export function runCheck(command: string[], cwd: string, timeout: number, signal?: AbortSignal): Promise<{ code: number | null; output: string; error?: string }> {
  if (signal?.aborted) return Promise.resolve({ code: null, output: "", error: "Condition checks stopped." });
  return new Promise(resolve => {
    let output = "";
    let bytes = 0;
    let failure: string | undefined;
    const child = spawn(command[0], command.slice(1), { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Process already exited. */ }
    };
    const timer = setTimeout(() => { failure = "Condition timed out."; kill(); }, timeout);
    const abort = () => { failure = "Condition checks stopped."; kill(); };
    signal?.addEventListener("abort", abort, { once: true });
    const collect = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > 65536) { failure = "Condition output exceeded 64 KiB."; kill(); }
      else if (stdout) output += chunk.toString();
    };
    child.stdout.on("data", chunk => collect(chunk, true));
    child.stderr.on("data", chunk => collect(chunk, false));
    child.on("error", error => { failure = `Cannot run condition: ${error.message}`; });
    child.on("close", code => { clearTimeout(timer); signal?.removeEventListener("abort", abort); kill(); resolve({ code, output, error: failure }); });
  });
}

export class Conditions {
  private cache = new Map<string, { expires: number; result: ConditionResult }>();
  private running = new Map<string, Promise<ConditionResult>>();
  private active = 0;
  private lifetime = new AbortController();
  constructor(private directory: string) {}

  async close() {
    this.lifetime.abort();
    await Promise.allSettled(this.running.values());
    this.cache.clear();
  }

  private async identity(snapshot: ReadyWorkflow, cwd: string) {
    const canonical = await realpath(cwd);
    const key = createHash("sha256").update(JSON.stringify([snapshot.workspaceId, canonical])).digest("hex");
    const fingerprint = createHash("sha256").update(JSON.stringify(snapshot.workflow.conditions)).digest("hex");
    return { canonical, key, fingerprint, path: join(this.directory, `trust-${key}.json`) };
  }

  async trusted(snapshot: ReadyWorkflow, cwd: string) {
    const id = await this.identity(snapshot, cwd);
    try { return (await readFile(id.path, "utf8")) === id.fingerprint; }
    catch (error) { if (isMissing(error)) return false; throw error; }
  }

  async trust(snapshot: ReadyWorkflow, cwd: string, trusted: boolean) {
    const id = await this.identity(snapshot, cwd);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await atomicWrite(id.path, trusted ? id.fingerprint : "revoked");
    this.cache.clear();
  }

  async results(snapshot: ReadyWorkflow, cwd: string, force = false, actionLabel?: string) {
    const deadline = Date.now() + 20000;
    const id = await this.identity(snapshot, cwd);
    const trusted = await this.trusted(snapshot, cwd);
    const resolved = new Map<string, Promise<ConditionResult>>();
    const resolve = (name: string): Promise<ConditionResult> => {
      const existing = resolved.get(name);
      if (existing) return existing;
      const custom = snapshot.workflow.conditions[name];
      if (custom && !trusted) return Promise.resolve(unknown("Trust custom commands to evaluate this condition."));
      const key = JSON.stringify([id.key, id.fingerprint, name]);
      const run = async () => {
        // A dispatch waits for an earlier observation, then obtains a new result.
        if (force) await this.running.get(key);
        const pending = this.running.get(key);
        if (pending) return pending;
        const cached = this.cache.get(key);
        if (!force && cached && cached.expires > Date.now()) return cached.result;
        const operation = async (): Promise<ConditionResult> => {
          if (this.lifetime.signal.aborted) return unknown("Condition checks stopped.");
          if (this.active >= 4) return unknown("Condition checks are busy. Retry shortly.");
          if (Date.now() >= deadline) return unknown("Condition evaluation exceeded 20 seconds.");
          this.active++;
          try {
            if (!custom) return builtins[name] ? await builtins[name].run(id.canonical, this.lifetime.signal, Math.max(1, Math.min(5000, deadline - Date.now()))) : unknown(`Unknown condition: ${name}.`);
            if (!await this.trusted(snapshot, cwd)) return unknown("Custom command trust was revoked.");
            const check = await runCheck(custom.command, id.canonical, Math.max(1, Math.min(milliseconds(custom.timeout), deadline - Date.now())), this.lifetime.signal);
            if (check.error) return unknown(check.error);
            return check.code === 0 ? value(true) : check.code === 1 ? value(false) : unknown(`Condition exited with ${check.code ?? "a signal"}.`);
          } finally { this.active--; }
        };
        const promise = operation();
        this.running.set(key, promise);
        try {
          const result = await promise;
          if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(key, { result, expires: Date.now() + (result.value === "unknown" ? 2000 : custom ? milliseconds(custom.interval) : builtins[name]?.interval ?? 2000) });
          return result;
        } finally { if (this.running.get(key) === promise) this.running.delete(key); }
      };
      const promise = run();
      resolved.set(name, promise);
      return promise;
    };
    const actionConditions: Record<string, ConditionResult> = Object.create(null);
    for (const action of snapshot.workflow.states[snapshot.state].actions) {
      if (actionLabel && action.label !== actionLabel) continue;
      actionConditions[action.label] = action.when ? await evaluate(action.when, resolve) : value(true);
    }
    return { actionConditions, commandsTrusted: trusted };
  }
}
