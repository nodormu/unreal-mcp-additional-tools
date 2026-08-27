import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fake implementation of the `unreal-remote-execution` npm package, faithful to
 * the two behaviors these bugs hinge on:
 *
 *  1. `openCommandConnection()`'s default `autoStopSearching=true` wipes
 *     `remoteNodes` once a command connection opens (the real library's
 *     `stopSearchingForNodes()` does `this.nodes = {}`).
 *  2. Nodes are only ever registered *while a search is active* — the real
 *     `updateRemoteNode()` drops incoming pongs unless `isSearchingForNodes()`.
 *     So `remoteNodes` repopulates on `startSearchingForNodes()` and only if an
 *     editor is actually there to answer.
 */
class FakeRemoteExecution {
	/** Whether a UE editor is currently around to answer discovery pings. */
	editorRunning = true;
	remoteNodes: Array<{ nodeId: string }> = [];
	private _commandConnectionOpen = false;

	async start(): Promise<void> {}
	startSearchingForNodes(): void {
		this.remoteNodes = [];
		if (this.editorRunning) this.remoteNodes.push({ nodeId: "fake-ue-node" });
	}
	stopSearchingForNodes(): void {
		this.remoteNodes = [];
	}
	hasCommandConnection(): boolean {
		return this._commandConnectionOpen;
	}
	async openCommandConnection(_node: unknown, autoStopSearching = true): Promise<void> {
		if (this._commandConnectionOpen) throw new Error("A command connection is already open!");
		this._commandConnectionOpen = true;
		if (autoStopSearching) this.stopSearchingForNodes();
	}
	closeCommandConnection(): void {
		this._commandConnectionOpen = false;
	}
	async runCommand(): Promise<{ success: boolean; output: unknown[]; result: string }> {
		if (!this._commandConnectionOpen) throw new Error("No command channel open!");
		return { success: true, output: [], result: "ok" };
	}
	async stop(): Promise<void> {}
}

vi.mock("unreal-remote-execution", () => ({
	RemoteExecution: FakeRemoteExecution,
	RemoteExecutionConfig: class {},
}));

const { PythonExecClient } = await import("./python-exec.js");

function makeClient(editorRunning = true) {
	const client = new PythonExecClient({ host: "127.0.0.1", port: 6776, timeout: 5000 });
	fakeOf(client).editorRunning = editorRunning;
	return client;
}

function fakeOf(client: unknown): FakeRemoteExecution {
	return (client as { remote: FakeRemoteExecution }).remote;
}

describe("PythonExecClient.isAvailable", () => {
	it("returns false when no editor answers discovery", async () => {
		vi.useFakeTimers();
		try {
			const client = makeClient(false);
			const probe = client.isAvailable();
			// The discovery wait polls every 500ms up to a 5s cap when nothing is
			// found; advance past it instead of eating a real 5s wall-clock wait.
			await vi.advanceTimersByTimeAsync(5001);
			await expect(probe).resolves.toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns true once a node answers discovery pre-connection", async () => {
		// The fake registers its node synchronously on startSearchingForNodes(), so
		// the discovery poll's first check() resolves before any setTimeout — no
		// fake timers needed.
		await expect(makeClient().isAvailable()).resolves.toBe(true);
	});

	it("regression: stays available after execute() opens a command connection, " +
		"even though the underlying library wipes remoteNodes as a side effect " +
		"of stopping discovery (the actual bug this test guards against)", async () => {
		const client = makeClient();
		const fake = fakeOf(client);

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

	it("reports unavailable when the connection closes and the editor is really gone", async () => {
		const client = makeClient();
		const fake = fakeOf(client);
		await client.execute("print(1)");
		expect(fake.hasCommandConnection()).toBe(true);

		// Editor exits: the socket closes and nothing answers discovery any more.
		fake.closeCommandConnection();
		fake.editorRunning = false;

		vi.useFakeTimers();
		try {
			const probe = client.isAvailable();
			await vi.advanceTimersByTimeAsync(5001);
			await expect(probe).resolves.toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("PythonExecClient reconnection", () => {
	// Regression: openCommandConnection() stops the node search and wipes the
	// library's node map, and nothing used to restart the search — so after any
	// connection drop, remoteNodes stayed empty forever, isAvailable() reported
	// false forever, and execute() threw NO_UE_NODES forever. The transport was
	// dead for the life of the process even with a perfectly healthy editor.
	it("recovers availability after a connection drop when the editor is still up", async () => {
		const client = makeClient();
		const fake = fakeOf(client);
		await client.execute("print(1)");
		expect(fake.remoteNodes).toHaveLength(0); // search stopped, map wiped

		fake.closeCommandConnection(); // e.g. editor restarted

		await expect(client.isAvailable()).resolves.toBe(true);
	});

	it("execute() reconnects after a connection drop instead of throwing NO_UE_NODES", async () => {
		const client = makeClient();
		const fake = fakeOf(client);
		await client.execute("print(1)");

		fake.closeCommandConnection();

		await expect(client.execute("print(2)")).resolves.toBe("ok");
		expect(fake.hasCommandConnection()).toBe(true);
	});

	it("still reports NO_UE_NODES when the editor genuinely is not there", async () => {
		const client = makeClient();
		const fake = fakeOf(client);
		await client.execute("print(1)");

		fake.closeCommandConnection();
		fake.editorRunning = false;

		vi.useFakeTimers();
		try {
			// Attach the rejection handler before advancing timers — the promise
			// settles during advanceTimersByTimeAsync(), and an assertion made
			// after that point would see it as an unhandled rejection first.
			const attempt = expect(client.execute("print(2)")).rejects.toThrow(
				/No Unreal Editor nodes found/i,
			);
			await vi.advanceTimersByTimeAsync(5001);
			await attempt;
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops pinging when a discovery round finds nothing", async () => {
		const client = makeClient(false);
		const fake = fakeOf(client);
		const stopSpy = vi.spyOn(fake, "stopSearchingForNodes");

		vi.useFakeTimers();
		try {
			const probe = client.isAvailable();
			await vi.advanceTimersByTimeAsync(5001);
			await probe;
			expect(stopSpy).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
