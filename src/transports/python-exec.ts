import type { Socket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { RemoteExecution, RemoteExecutionConfig } from "unreal-remote-execution";
import { PythonExecutionError, TimeoutError, UnrealMcpError } from "../utils/errors.js";

/**
 * Pick the outbound interface for multicast discovery pings.
 *
 * `unreal-remote-execution` passes the multicast *bind* address ("0.0.0.0") to
 * `setMulticastInterface()`. Binding to 0.0.0.0 is required on Windows to receive
 * multicast at all, but as an interface selector it leaves the choice to the OS —
 * and on machines with extra adapters (Bluetooth PAN, Wi-Fi Direct, an unplugged
 * NIC, WSL, Hyper-V, VPNs) Windows routinely picks a link-local 169.254.* adapter.
 * The ping then leaves on an interface the editor is not listening on and
 * discovery fails with "Could not find a node within the given time".
 *
 * Returns the first real external IPv4, skipping APIPA addresses. Override with
 * UNREAL_MCP_MULTICAST_IFACE when auto-detection picks the wrong adapter.
 */
function resolveMulticastInterface(): string | undefined {
	const override = process.env.UNREAL_MCP_MULTICAST_IFACE;
	if (override) return override;

	for (const addresses of Object.values(networkInterfaces())) {
		for (const addr of addresses ?? []) {
			if (addr.family === "IPv4" && !addr.internal && !addr.address.startsWith("169.254.")) {
				return addr.address;
			}
		}
	}
	return undefined;
}

export interface PythonExecConfig {
	host: string;
	port: number;
	timeout: number;
}

/**
 * Client for Unreal Engine's built-in Python Remote Execution protocol.
 * Uses the `unreal-remote-execution` package which implements the full protocol:
 * - UDP multicast discovery on 239.0.0.1:6766
 * - Inverted TCP model (we are the server, UE connects to us)
 * - Proper message framing with magic "ue_py" and UUIDs
 *
 * Requires "Python Editor Script Plugin" enabled in UE with
 * "Enable Remote Execution" checked in its settings.
 */
export class PythonExecClient {
	private remote: RemoteExecution;
	private timeout: number;
	private _started = false;
	private _commandReady = false;
	private _discoveryFailed = false;
	private _lastDiscoveryAttempt = 0;

	constructor(config: PythonExecConfig) {
		const remoteConfig = new RemoteExecutionConfig(
			0, // multicastTTL: local host only
			["239.0.0.1", 6766], // multicastGroupEndpoint (UE default)
			"0.0.0.0", // multicastBindAddress
			[config.host, config.port], // commandEndpoint
		);
		this.remote = new RemoteExecution(remoteConfig);
		this.timeout = config.timeout;
	}

	async isAvailable(): Promise<boolean> {
		try {
			// If discovery failed recently, skip the slow 5s wait and return false
			// Retry every 30 seconds in case the user enables Remote Execution
			if (this._discoveryFailed && Date.now() - this._lastDiscoveryAttempt < 30_000) {
				return false;
			}
			if (!this._started) {
				await this.ensureStarted();
			}
			const found = this.remote.remoteNodes.length > 0;
			if (!found) {
				this._discoveryFailed = true;
				this._lastDiscoveryAttempt = Date.now();
			} else {
				this._discoveryFailed = false;
			}
			return found;
		} catch {
			this._discoveryFailed = true;
			this._lastDiscoveryAttempt = Date.now();
			return false;
		}
	}

	private async ensureStarted(): Promise<void> {
		if (this._started) return;

		try {
			await this.remote.start();
			this._started = true;

			this.applyMulticastInterface();

			// `start()` only opens the broadcast socket — it does not emit any pings.
			// The library registers discovered nodes exclusively while it is actively
			// searching (see `updateRemoteNode`), so without this call `remoteNodes`
			// stays empty forever and every discovery attempt times out.
			this.remote.startSearchingForNodes();

			// Wait for UE node discovery via UDP multicast
			await new Promise<void>((resolve) => {
				const maxWait = 5000;
				const interval = 500;
				let elapsed = 0;

				const check = () => {
					if (this.remote.remoteNodes.length > 0 || elapsed >= maxWait) {
						resolve();
						return;
					}
					elapsed += interval;
					setTimeout(check, interval);
				};
				check();
			});
		} catch (err) {
			this._started = false;
			throw new UnrealMcpError(
				`Failed to start Python Remote Execution: ${err}`,
				"PYTHON_CONNECTION_FAILED",
			);
		}
	}

	/**
	 * Point outbound multicast at a real interface once the broadcast socket is up.
	 *
	 * The library exposes no option for this, so we reach the socket through its
	 * private field. Best-effort: discovery may still work on single-adapter hosts
	 * if this fails, so never throw. Only the *outbound* interface is changed —
	 * the bind address and group membership must stay on 0.0.0.0 or the pong is
	 * never received.
	 */
	private applyMulticastInterface(): void {
		const iface = resolveMulticastInterface();
		if (!iface) return;

		const socket = (
			this.remote as unknown as {
				broadcastConnection?: { broadcastSocket?: Socket };
			}
		).broadcastConnection?.broadcastSocket;

		try {
			socket?.setMulticastInterface(iface);
		} catch (error) {
			console.error(
				`[unreal-mcp] Could not set multicast interface to ${iface}: ${error}. ` +
					"Discovery may fail if this host has multiple network adapters.",
			);
		}
	}

	private async ensureCommandConnection(): Promise<void> {
		if (this._commandReady && this.remote.hasCommandConnection()) return;

		await this.ensureStarted();

		const nodes = this.remote.remoteNodes;
		if (nodes.length === 0) {
			throw new UnrealMcpError(
				"No Unreal Editor nodes found. Make sure the editor is running with Python Remote Execution enabled.",
				"NO_UE_NODES",
			);
		}

		await this.remote.openCommandConnection(nodes[0]);
		this._commandReady = true;
	}

	/**
	 * Execute Python code in the Unreal Editor's Python environment.
	 * Returns the captured stdout output.
	 */
	async execute(pythonCode: string): Promise<string> {
		await this.ensureCommandConnection();

		try {
			const result = await Promise.race([
				this.remote.runCommand(pythonCode, true),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new TimeoutError("Python execution", this.timeout)),
						this.timeout,
					),
				),
			]);

			if (!result.success) {
				const errorOutput = result.output
					.filter((o: { type: string }) => o.type === "Error")
					.map((o: { output: string }) => o.output)
					.join("\n");
				const errorMsg = errorOutput || result.result || "Unknown Python execution error";
				throw new PythonExecutionError(errorMsg, JSON.stringify(result));
			}

			// Collect stdout (Info-type output)
			const stdout = result.output
				.filter((o: { type: string }) => o.type === "Info")
				.map((o: { output: string }) => o.output)
				.join("")
				.trim();

			return stdout || result.result || "";
		} catch (error) {
			if (error instanceof UnrealMcpError) throw error;
			// Connection may have dropped — reset and let next call reconnect
			this._commandReady = false;
			throw new PythonExecutionError(`Python execution failed: ${error}`, String(error));
		}
	}

	/**
	 * Execute a Python script (already rendered via template engine).
	 */
	async executeScript(renderedScript: string): Promise<string> {
		return this.execute(renderedScript);
	}

	async disconnect(): Promise<void> {
		if (this._commandReady) {
			try {
				this.remote.closeCommandConnection();
			} catch {
				// Ignore
			}
			this._commandReady = false;
		}
		if (this._started) {
			try {
				this.remote.stopSearchingForNodes();
			} catch {
				// Ignore
			}
			try {
				await this.remote.stop();
			} catch {
				// Ignore shutdown errors
			}
			this._started = false;
		}
	}
}
