import { cpus } from "node:os";
import { isForkServerEnabled } from "./fork-server.ts";

// [local patch] Replaced `import { Semaphore } from "../../utils/semaphore.js"`
// (prime repo-internal util, not vendored) with this minimal inline
// implementation. Only `run(fn, signal?)` is exercised by this module.
// Semantics preserved: FIFO queue, bounded concurrency; abort rejects a
// queued waiter without running the task.
class Semaphore {
	private active = 0;
	private queue: Array<{ run: () => void; signal?: AbortSignal }> = [];

	constructor(private readonly limit: number) {}

	run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (this.active < this.limit) {
			this.active++;
			return fn().finally(() => {
				this.active--;
				this.pump();
			});
		}
		return new Promise<T>((resolve, reject) => {
			const waiter: { run: () => void; signal?: AbortSignal } = {
				run: () => {
					this.active++;
					fn().then(resolve, reject).finally(() => {
						this.active--;
						this.pump();
					});
				},
				// [local patch] exactOptionalPropertyTypes: spread instead of `signal`.
				...(signal !== undefined ? { signal } : {}),
			};
			this.queue.push(waiter);
			signal?.addEventListener("abort", () => {
				const index = this.queue.indexOf(waiter);
				if (index >= 0) {
					this.queue.splice(index, 1);
					reject(new Error("operation aborted while waiting for kernel boot permit"));
				}
			}, { once: true });
			this.pump();
		});
	}

	private pump(): void {
		while (this.active < this.limit && this.queue.length > 0) {
			const waiter = this.queue.shift();
			if (waiter) waiter.run();
		}
	}
}

// Above core count because boots are IO-bound (cold imports), but capped so a
// fan-out can't thrash the FS past the port-resolve window.
const DEFAULT_KERNEL_BOOT_CONCURRENCY = Math.min(16, Math.max(4, (cpus().length || 4) * 2));
const MAX_KERNEL_BOOT_CONCURRENCY = 64;
// Fork-per-child is ~ms and bypasses the FS, so we can admit well past the
// direct-spawn cap. But fork only removes the *import* cost — every admitted
// kernel still starts a live ioloop + heartbeat thread + rlm bootstrap, and
// letting all N do that at once trips the ready timeout (measured: 256 collapses
// to ~28% boot at N=200; core*4 holds 100%). So the gate stays a real bound.
// Explicit env overrides may go higher than the auto default, but not unbounded —
// past this the live-kernel startup storm regresses boot rate.
const FORKSERVER_KERNEL_BOOT_CONCURRENCY_MAX = 128;
const FORKSERVER_KERNEL_BOOT_CONCURRENCY = Math.min(
	FORKSERVER_KERNEL_BOOT_CONCURRENCY_MAX,
	Math.max(32, (cpus().length || 4) * 4),
);

export function resolveKernelBootConcurrency(): number {
	const raw = process.env.PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS;
	const fallback = isForkServerEnabled() ? FORKSERVER_KERNEL_BOOT_CONCURRENCY : DEFAULT_KERNEL_BOOT_CONCURRENCY;
	if (raw === undefined || !/^\d+$/.test(raw)) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	// A malformed or out-of-range value (incl. 0, e.g. "00") falls back to the
	// default rather than mis-bounding the gate or throwing at module load.
	if (parsed < 1) {
		return fallback;
	}
	// An explicit override may exceed the auto default (that's its purpose), but is
	// still clamped: the FS-contention cap on direct spawn, a looser backstop on fork.
	const max = isForkServerEnabled() ? FORKSERVER_KERNEL_BOOT_CONCURRENCY_MAX : MAX_KERNEL_BOOT_CONCURRENCY;
	return Math.min(max, parsed);
}

// Resolved lazily on first boot, not at module load, so the fork-server flag is
// honored whenever it is set before the first kernel starts — not just if it
// happened to be set at import time.
let kernelBootSemaphore: Semaphore | undefined;

export function withKernelBootPermit<T>(boot: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!kernelBootSemaphore) {
		kernelBootSemaphore = new Semaphore(resolveKernelBootConcurrency());
	}
	return kernelBootSemaphore.run(boot, signal);
}
