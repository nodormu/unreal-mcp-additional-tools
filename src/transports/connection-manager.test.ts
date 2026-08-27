import { describe, expect, it, vi } from "vitest";
import { PythonExecutionError } from "../utils/errors.js";
import { ConnectionManager } from "./connection-manager.js";
import type { PluginBridgeClient } from "./plugin-bridge.js";
import type { PythonExecClient } from "./python-exec.js";
import type { RemoteControlClient } from "./remote-control.js";

/**
 * These tests exercise ConnectionManager's status caching/invalidation logic
 * directly against fake transport clients, bypassing initialize() (which would
 * construct real PythonExecClient/RemoteControlClient instances that touch
 * actual sockets — python-exec's discovery alone waits up to 5s for a reply
 * that will never come in a test environment with no UE editor present).
 */
function makeManager(overrides: {
	pythonAvailable?: () => Promise<boolean>;
	pythonExecute?: () => Promise<string>;
	rcAvailable?: () => Promise<boolean>;
	rcExecutePython?: () => Promise<string>;
}): ConnectionManager {
	const manager = new ConnectionManager();
	manager.python = {
		isAvailable: overrides.pythonAvailable ?? (async () => false),
		execute: overrides.pythonExecute ?? (async () => "ok"),
	} as unknown as PythonExecClient;
	manager.rc = {
		isAvailable: overrides.rcAvailable ?? (async () => false),
		executePython: overrides.rcExecutePython ?? (async () => "ok"),
	} as unknown as RemoteControlClient;
	manager.plugin = {
		isAvailable: async () => false,
	} as unknown as PluginBridgeClient;
	return manager;
}

describe("ConnectionManager.requireEditor self-heal", () => {
	it("throws when no transport is available", async () => {
		const manager = makeManager({});
		await manager.refreshStatus();
		await expect(manager.requireEditor()).rejects.toThrow(/not connected/i);
	});

	it("returns immediately (fast path) when status is already cached as connected", async () => {
		const isAvailable = vi.fn(async () => true);
		const manager = makeManager({ pythonAvailable: isAvailable });
		await manager.refreshStatus();
		expect(isAvailable).toHaveBeenCalledTimes(1);

		await manager.requireEditor();
		// requireEditor's fast path must not re-probe when already known good.
		expect(isAvailable).toHaveBeenCalledTimes(1);
	});

	it("re-probes and self-heals when the editor starts after a cached-down status", async () => {
		vi.useFakeTimers();
		try {
			let editorStarted = false;
			const manager = makeManager({ pythonAvailable: async () => editorStarted });

			await manager.refreshStatus();
			await expect(manager.requireEditor()).rejects.toThrow(/not connected/i);

			editorStarted = true; // Editor launches mid-session.
			vi.advanceTimersByTime(2001); // past requireEditor's re-probe cooldown
			await manager.requireEditor(); // Should re-probe and succeed, not throw.
			expect(manager.status.editorRunning).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not re-probe again within the cooldown window", async () => {
		const isAvailable = vi.fn(async () => false);
		const manager = makeManager({ pythonAvailable: isAvailable });

		await manager.refreshStatus();
		expect(isAvailable).toHaveBeenCalledTimes(1);

		await expect(manager.requireEditor()).rejects.toThrow(); // triggers a re-probe
		expect(isAvailable).toHaveBeenCalledTimes(2);

		await expect(manager.requireEditor()).rejects.toThrow(); // within cooldown
		expect(isAvailable).toHaveBeenCalledTimes(2); // unchanged
	});
});

describe("ConnectionManager.runPython status invalidation", () => {
	it("invalidates pythonExec and editorRunning when the connection fails with no RC fallback", async () => {
		const manager = makeManager({
			pythonAvailable: async () => true,
			pythonExecute: async () => {
				throw new Error("connection dropped");
			},
			rcAvailable: async () => false,
		});
		await manager.refreshStatus();
		expect(manager.status.pythonExec).toBe(true);
		expect(manager.status.editorRunning).toBe(true);

		await expect(manager.runPython("print(1)")).rejects.toThrow("connection dropped");

		expect(manager.status.pythonExec).toBe(false);
		expect(manager.status.editorRunning).toBe(false);
	});

	it("does NOT invalidate the transport or fall back to RC on a script error (connection alive)", async () => {
		const rcExecute = vi.fn(async () => "rc result");
		const manager = makeManager({
			pythonAvailable: async () => true,
			pythonExecute: async () => {
				// A PythonExecutionError = the code round-tripped and the user's
				// script raised. The connection is fine.
				throw new PythonExecutionError("NameError: name 'foo' is not defined", "{}");
			},
			rcAvailable: async () => true,
			rcExecutePython: rcExecute,
		});
		await manager.refreshStatus();

		await expect(manager.runPython("foo()")).rejects.toBeInstanceOf(PythonExecutionError);

		// The healthy Python transport must stay marked available...
		expect(manager.status.pythonExec).toBe(true);
		expect(manager.status.editorRunning).toBe(true);
		// ...and RC must NOT have been asked to re-run the same broken code.
		expect(rcExecute).not.toHaveBeenCalled();
	});

	it("falls back to Remote Control on Python failure and keeps editorRunning true if RC succeeds", async () => {
		const manager = makeManager({
			pythonAvailable: async () => true,
			pythonExecute: async () => {
				throw new Error("connection dropped");
			},
			rcAvailable: async () => true,
			rcExecutePython: async () => "rc result",
		});
		await manager.refreshStatus();

		const result = await manager.runPython("print(1)");

		expect(result).toBe("rc result");
		expect(manager.status.pythonExec).toBe(false); // invalidated
		expect(manager.status.remoteControl).toBe(true); // RC still good
		expect(manager.status.editorRunning).toBe(true); // still true via RC
	});

	it("invalidates remoteControl when the RC fallback itself fails", async () => {
		const manager = makeManager({
			pythonAvailable: async () => true,
			pythonExecute: async () => {
				throw new Error("python down");
			},
			rcAvailable: async () => true,
			rcExecutePython: async () => {
				throw new Error("rc down too");
			},
		});
		await manager.refreshStatus();

		await expect(manager.runPython("print(1)")).rejects.toThrow("rc down too");

		expect(manager.status.pythonExec).toBe(false);
		expect(manager.status.remoteControl).toBe(false);
		expect(manager.status.editorRunning).toBe(false);
	});

	it("a subsequent requireEditor() call re-probes after runPython invalidates the status", async () => {
		let editorAlive = true;
		const manager = makeManager({
			pythonAvailable: async () => editorAlive,
			pythonExecute: async () => {
				if (!editorAlive) throw new Error("editor closed");
				return "ok";
			},
		});
		await manager.refreshStatus();
		expect(manager.status.editorRunning).toBe(true);

		// Editor closes mid-session; the next runPython call is what discovers it.
		editorAlive = false;
		await expect(manager.runPython("print(1)")).rejects.toThrow("editor closed");
		expect(manager.status.editorRunning).toBe(false);

		// A later requireEditor() call must re-probe and get the real (down) state
		// rather than trusting a status that predates the invalidation.
		await expect(manager.requireEditor()).rejects.toThrow(/not connected/i);
	});
});

/**
 * With Remote Control up, an invalidated Python transport is invisible to
 * requireEditor() — `editorRunning` stays true, so its self-heal never fires and
 * runPython()'s `if (this._status.pythonExec)` gate skips Python forever. These
 * cover the separate re-probe that closes that gap.
 */
describe("ConnectionManager Python transport recovery", () => {
	it("routes back to Python once an invalidated transport recovers", async () => {
		let pythonAlive = true;
		const pythonExecute = vi.fn(async () => {
			if (!pythonAlive) throw new Error("editor closed");
			return "from python";
		});
		const manager = makeManager({
			pythonAvailable: async () => pythonAlive,
			pythonExecute,
			rcAvailable: async () => true,
			rcExecutePython: async () => "from remote control",
		});
		await manager.refreshStatus();

		vi.useFakeTimers();
		try {
			// A connection-level failure knocks Python out; RC covers the call.
			pythonAlive = false;
			expect(await manager.runPython("a")).toBe("from remote control");
			expect(manager.status.pythonExec).toBe(false);

			// Editor comes back, but the cooldown hasn't elapsed yet.
			pythonAlive = true;
			expect(await manager.runPython("b")).toBe("from remote control");
			expect(manager.status.pythonExec).toBe(false);

			await vi.advanceTimersByTimeAsync(15_001);

			expect(await manager.runPython("c")).toBe("from python");
			expect(manager.status.pythonExec).toBe(true);
			expect(manager.status.editorRunning).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not re-probe a transport that was never available", async () => {
		// Remote Execution simply switched off: nothing was ever invalidated, so
		// no call should pay for a discovery probe it has no reason to expect.
		const pythonAvailable = vi.fn(async () => false);
		const manager = makeManager({
			pythonAvailable,
			rcAvailable: async () => true,
			rcExecutePython: async () => "from remote control",
		});
		await manager.refreshStatus();
		pythonAvailable.mockClear();

		vi.useFakeTimers();
		try {
			for (const code of ["a", "b", "c"]) {
				await vi.advanceTimersByTimeAsync(60_000);
				expect(await manager.runPython(code)).toBe("from remote control");
			}
			expect(pythonAvailable).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("rate-limits the re-probe while Python stays down", async () => {
		let pythonAlive = true;
		const pythonAvailable = vi.fn(async () => pythonAlive);
		const manager = makeManager({
			pythonAvailable,
			pythonExecute: async () => {
				if (!pythonAlive) throw new Error("editor closed");
				return "from python";
			},
			rcAvailable: async () => true,
			rcExecutePython: async () => "from remote control",
		});
		await manager.refreshStatus();

		// Reach the invalidated state the way real life does: a connection-level
		// failure on a transport that was believed up.
		pythonAlive = false;
		expect(await manager.runPython("boom")).toBe("from remote control");
		pythonAvailable.mockClear();

		vi.useFakeTimers();
		try {
			// 20 calls spread over 40s, against a 15s cooldown: at most 3 probes.
			for (let i = 0; i < 20; i++) {
				await vi.advanceTimersByTimeAsync(2_000);
				expect(await manager.runPython(`call${i}`)).toBe("from remote control");
			}
			expect(pythonAvailable.mock.calls.length).toBeLessThanOrEqual(3);
			expect(pythonAvailable.mock.calls.length).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
