import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SubprocessResult } from "../types.js";
import { BuildError, TimeoutError, UnrealMcpError } from "../utils/errors.js";
import { parseBuildOutput } from "../utils/output-parser.js";

export interface SubprocessConfig {
	enginePath?: string;
	projectPath: string;
	platform: string;
	configuration: string;
	timeouts: {
		build: number;
		cook: number;
	};
}

// Defense-in-depth: even without a shell, reject characters that have caused
// argument-escaping bugs in platform process launchers (e.g. Windows .bat/.cmd
// invocation, which necessarily goes through cmd.exe — see resolveInvocation).
// No legitimate build argument (paths, target names, platform names) needs
// these characters.
const UNSAFE_ARG_PATTERN = /[;&|`$<>\n\r]/;

// Stricter rule for tokens routed through cmd.exe. Neither of these can be
// neutralized by the double-quoting resolveInvocation() applies: cmd.exe
// expands %VAR% even inside double quotes (with no in-quote escape available),
// and an embedded double quote closes the quoting early. Neither appears in a
// legitimate engine path or UAT argument, so reject rather than mangle.
const CMD_UNSAFE_ARG_PATTERN = /[%"]/;

function assertSafeArg(arg: string): void {
	if (UNSAFE_ARG_PATTERN.test(arg)) {
		throw new UnrealMcpError(
			`Rejected unsafe subprocess argument (contains shell metacharacters): ${arg}`,
			"UNSAFE_ARGUMENT",
			{ arg },
		);
	}
}

export interface SpawnInvocation {
	file: string;
	args: string[];
	windowsVerbatimArguments: boolean;
}

/**
 * Decide what to actually hand to `child_process.spawn()`.
 *
 * Everything except a Windows batch file is spawned directly with no shell, so
 * arguments reach the OS as a verbatim argv array and shell metacharacters are
 * never interpreted.
 *
 * Windows .bat/.cmd files are the exception, and they cannot simply be spawned:
 * `CreateProcess` has no notion of batch files, so they only run via a command
 * interpreter. Node used to hide that, but since the CVE-2024-27980 fix
 * (v18.20.2 / v20.12.2 — the floor in package.json `engines`) `spawn()` refuses
 * a .bat/.cmd outright with `EINVAL` unless the caller opts into a shell. This
 * matters here because `getUATPath()` resolves `RunUAT.bat` on Windows, so
 * every UAT-backed tool (build, cook, package, BuildCookRun, BuildGraph,
 * GenerateProjectFiles, Gauntlet) goes down this path.
 *
 * `shell: true` would clear the EINVAL, but Node then space-joins the argv
 * without quoting anything, which corrupts any argument containing a space —
 * and `-project=<path>` routinely contains one. So invoke the interpreter
 * explicitly and own the quoting instead: `cmd.exe /d /s /c`, each token
 * individually double-quoted, the whole line wrapped in one more pair of quotes
 * that `/s` strips before parsing, and `windowsVerbatimArguments` so Node
 * doesn't re-quote on top. That is the same shape as Node's own `shell: true`
 * path, minus its missing per-argument quoting.
 */
export function resolveInvocation(
	command: string,
	args: string[],
	platform: string = process.platform,
): SpawnInvocation {
	const lower = command.toLowerCase();
	const isBatchFile = platform === "win32" && (lower.endsWith(".bat") || lower.endsWith(".cmd"));

	if (!isBatchFile) {
		return { file: command, args, windowsVerbatimArguments: false };
	}

	const tokens = [command, ...args];
	for (const token of tokens) {
		if (CMD_UNSAFE_ARG_PATTERN.test(token)) {
			throw new UnrealMcpError(
				`Rejected unsafe subprocess token (cmd.exe cannot safely quote '%' or '"'): ${token}`,
				"UNSAFE_ARGUMENT",
				{ arg: token },
			);
		}
	}

	const commandLine = tokens.map((token) => `"${token}"`).join(" ");
	return {
		file: process.env.comspec || "cmd.exe",
		args: ["/d", "/s", "/c", `"${commandLine}"`],
		windowsVerbatimArguments: true,
	};
}

/**
 * Runs UAT, UBT, and commandlets as child processes.
 * These don't require the editor to be running.
 */
export class SubprocessRunner {
	private config: SubprocessConfig;

	constructor(config: SubprocessConfig) {
		this.config = config;
	}

	/**
	 * Run UAT (Unreal Automation Tool) with the given command and args.
	 */
	async runUAT(command: string, args: string[] = [], timeout?: number): Promise<SubprocessResult> {
		const uatPath = this.getUATPath();
		if (!uatPath) {
			throw new UnrealMcpError(
				"Cannot find RunUAT. Set enginePath in config or UNREAL_MCP_ENGINE_PATH env var.",
				"UAT_NOT_FOUND",
			);
		}

		const fullArgs = [command, ...args];
		return this.spawn(uatPath, fullArgs, timeout || this.config.timeouts.build);
	}

	/**
	 * Run BuildCookRun — the main build pipeline command.
	 */
	async buildCookRun(options: {
		build?: boolean;
		cook?: boolean;
		stage?: boolean;
		package?: boolean;
		archive?: boolean;
		deploy?: boolean;
		run?: boolean;
		iterate?: boolean;
		compressed?: boolean;
		platform?: string;
		configuration?: string;
		additionalArgs?: string[];
	}): Promise<SubprocessResult> {
		const args: string[] = [];

		args.push(`-project=${this.config.projectPath}`);
		args.push(`-platform=${options.platform || this.config.platform}`);
		args.push(`-clientconfig=${options.configuration || this.config.configuration}`);

		if (options.build) args.push("-build");
		if (options.cook) args.push("-cook");
		if (options.stage) args.push("-stage");
		if (options.package) args.push("-package");
		if (options.archive) args.push("-archive");
		if (options.deploy) args.push("-deploy");
		if (options.run) args.push("-run");
		if (options.iterate) args.push("-iterate");
		if (options.compressed) args.push("-compressed");

		if (options.additionalArgs) {
			args.push(...options.additionalArgs);
		}

		return this.runUAT("BuildCookRun", args, this.config.timeouts.cook);
	}

	/**
	 * Run UBT (UnrealBuildTool) to compile C++ code.
	 */
	async runUBT(args: string[], timeout?: number): Promise<SubprocessResult> {
		const ubtPath = this.getUBTPath();
		if (!ubtPath) {
			throw new UnrealMcpError(
				"Cannot find UnrealBuildTool. Set enginePath in config or UNREAL_MCP_ENGINE_PATH env var.",
				"UBT_NOT_FOUND",
			);
		}

		return this.spawn(ubtPath, args, timeout || this.config.timeouts.build);
	}

	/**
	 * Run a UE commandlet (headless batch operation).
	 */
	async runCommandlet(
		commandletName: string,
		args: string[] = [],
		timeout?: number,
	): Promise<SubprocessResult> {
		const editorPath = this.getEditorPath();
		if (!editorPath) {
			throw new UnrealMcpError(
				"Cannot find UnrealEditor. Set enginePath in config.",
				"EDITOR_NOT_FOUND",
			);
		}

		const fullArgs = [this.config.projectPath, `-run=${commandletName}`, ...args];
		return this.spawn(editorPath, fullArgs, timeout || this.config.timeouts.build);
	}

	/**
	 * Generate project files (VS/Xcode/Rider).
	 */
	async generateProjectFiles(): Promise<SubprocessResult> {
		return this.runUAT("GenerateProjectFiles", [`-project=${this.config.projectPath}`]);
	}

	private getUATPath(): string | null {
		if (!this.config.enginePath) return null;

		const candidates = [
			join(this.config.enginePath, "Engine", "Build", "BatchFiles", "RunUAT.bat"),
			join(this.config.enginePath, "Engine", "Build", "BatchFiles", "RunUAT.sh"),
		];

		for (const candidate of candidates) {
			if (existsSync(candidate)) return candidate;
		}
		return null;
	}

	private getUBTPath(): string | null {
		if (!this.config.enginePath) return null;

		const candidates = [
			join(
				this.config.enginePath,
				"Engine",
				"Binaries",
				"DotNET",
				"UnrealBuildTool",
				"UnrealBuildTool.exe",
			),
			join(
				this.config.enginePath,
				"Engine",
				"Binaries",
				"DotNET",
				"UnrealBuildTool",
				"UnrealBuildTool",
			),
		];

		for (const candidate of candidates) {
			if (existsSync(candidate)) return candidate;
		}
		return null;
	}

	private getEditorPath(): string | null {
		if (!this.config.enginePath) return null;

		const candidates = [
			join(this.config.enginePath, "Engine", "Binaries", "Win64", "UnrealEditor.exe"),
			join(this.config.enginePath, "Engine", "Binaries", "Win64", "UnrealEditor-Cmd.exe"),
			join(this.config.enginePath, "Engine", "Binaries", "Linux", "UnrealEditor"),
			join(this.config.enginePath, "Engine", "Binaries", "Mac", "UnrealEditor"),
		];

		for (const candidate of candidates) {
			if (existsSync(candidate)) return candidate;
		}
		return null;
	}

	private async spawn(command: string, args: string[], timeout: number): Promise<SubprocessResult> {
		for (const arg of args) {
			assertSafeArg(arg);
		}

		// Never `shell: true` — see resolveInvocation() for how Windows .bat/.cmd
		// (i.e. RunUAT.bat) is handled without one.
		const invocation = resolveInvocation(command, args);

		return new Promise<SubprocessResult>((resolve, reject) => {
			const startTime = Date.now();
			const stdoutChunks: string[] = [];
			const stderrChunks: string[] = [];

			const child = spawn(invocation.file, invocation.args, {
				stdio: ["pipe", "pipe", "pipe"],
				windowsVerbatimArguments: invocation.windowsVerbatimArguments,
			});

			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				reject(new TimeoutError(`${command} ${args[0] || ""}`, timeout));
			}, timeout);

			child.stdout?.on("data", (data: Buffer) => {
				stdoutChunks.push(data.toString());
			});

			child.stderr?.on("data", (data: Buffer) => {
				stderrChunks.push(data.toString());
			});

			child.on("close", (exitCode) => {
				clearTimeout(timer);
				const stdout = stdoutChunks.join("");
				const stderr = stderrChunks.join("");
				const duration = Date.now() - startTime;
				const parsed = parseBuildOutput(`${stdout}\n${stderr}`);

				resolve({
					exitCode: exitCode ?? 1,
					stdout,
					stderr,
					duration,
					parsed,
				});
			});

			child.on("error", (err) => {
				clearTimeout(timer);
				reject(
					new UnrealMcpError(`Failed to spawn process: ${err.message}`, "SPAWN_FAILED", {
						command,
						args,
					}),
				);
			});
		});
	}
}
