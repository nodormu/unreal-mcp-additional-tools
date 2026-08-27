import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fake implementation of the `unreal-remote-execution` npm package, faithful
 * to the one behavior this bug hinges on: `openCommandConnection()`'s default
 * `autoStopSearching=true` wipes `remoteNodes` once a command connection opens
 * (mirrors the real library's `stopSearchingForNodes()` -> `this.nodes = {}`).
 */
class FakeRemoteExecution {
	remoteNodes: Array<{ nodeId: string }> = [];
	private _commandConnectionOpen = false;

	async start(): Promise<void> {}
	startSearchingForNodes(): void {}
	stopSearchingForNodes(): void {
		this.remoteNodes = [];
	}
	hasCommandConnection(): boolean {
		return this._commandConnectionOpen;
	}
	async openCommandConnection(_node: unknown, autoStopSearching = true): Promise<void> {
		this._commandConnectionOpen = true;
		if (autoStopSearching) this.stopSearchingForNodes();
	}
	closeCommandConnection(): void {
		this._commandConnectionOpen = false;
	}
	async runCommand(): Promise<{ success: boolean; output: unknown[]; result: string }> {
		return { success: true, output: [], result: "ok" };
	}
	async stop(): Promise<void> {}
}

vi.mock("unreal-remote-execution", () => ({
	RemoteExecution: FakeRemoteExecution,
	RemoteExecutionConfig: class {},
}));

const { PythonExecClient } = await import("./python-exec.js");

function makeClient() {
	return new PythonExecClient({ host: "127.0.0.1", port: 6776, timeout: 5000 });
}

describe("PythonExecClient.isAvailable", () => {
	it("returns false when nothing has been discovered yet", async () => {
		vi.useFakeTimers();
		try {
			const client = makeClient();
			const probe = client.isAvailable();
			// ensureStarted()'s discovery wait polls every 500ms up to a 5s cap
			// when nothing is found; advance past it instead of eating a real 5s
			// wall-clock timeout in the test run.
			await vi.advanceTimersByTimeAsync(5001);
			await expect(probe).resolves.toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns true once a node has been discovered pre-connection", async () => {
		const client = makeClient();
		// Reach into the fake to simulate a discovered node before the first probe,
		// so ensureStarted()'s discovery wait resolves immediately (no fake timers
		// needed - its internal check() runs synchronously before any setTimeout).
		(client as unknown as { remote: FakeRemoteExecution }).remote.remoteNodes.push({
			nodeId: "fake-ue-node",
		});

		await expect(client.isAvailable()).resolves.toBe(true);
	});

	it("regression: stays available after execute() opens a command connection, " +
		"even though the underlying library wipes remoteNodes as a side effect " +
		"of stopping discovery (the actual bug this test guards against)", async () => {
		const client = makeClient();
		const fake = (client as unknown as { remote: FakeRemoteExecution }).remote;
		fake.remoteNodes.push({ nodeId: "fake-ue-node" });

		// Establish the command connection the way a real execute_python call would.
		await client.execute("print(1)");

		// Sanity-check the fake actually reproduces the library's real behavior:
		// remoteNodes must now be empty (this is what caused the original bug).
		expect(fake.remoteNodes).toHaveLength(0);
		expect(fake.hasCommandConnection()).toBe(true);

		// Before the fix, isAvailable() only checked remoteNodes.length > 0 here
		// and would incorrectly return false forever from this point on.
		await expect(client.isAvailable()).resolves.toBe(true);
	});

	it("falls back to real discovery once the command connection actually closes", async () => {
		const client = makeClient();
		const fake = (client as unknown as { remote: FakeRemoteExecution }).remote;
		fake.remoteNodes.push({ nodeId: "fake-ue-node" });
		await client.execute("print(1)");
		expect(fake.hasCommandConnection()).toBe(true);

		// Connection drops for real.
		fake.closeCommandConnection();
		// No fresh discovery has happened, so remoteNodes is (still) empty and
		// hasCommandConnection() is now false - isAvailable() must not keep
		// reporting true just because it once was.
		await expect(client.isAvailable()).resolves.toBe(false);
	});
});
