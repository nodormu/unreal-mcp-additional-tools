import { describe, expect, it } from "vitest";
import { UnrealMcpError } from "../utils/errors.js";
import { resolveInvocation } from "./subprocess.js";

const UAT = "C:\\UE_5.4\\Engine\\Build\\BatchFiles\\RunUAT.bat";

describe("resolveInvocation", () => {
	it("spawns a plain executable directly, with no shell and no re-quoting", () => {
		const inv = resolveInvocation(
			"/opt/UE/Engine/Binaries/Linux/UnrealEditor",
			["-run=Cook"],
			"linux",
		);
		expect(inv).toEqual({
			file: "/opt/UE/Engine/Binaries/Linux/UnrealEditor",
			args: ["-run=Cook"],
			windowsVerbatimArguments: false,
		});
	});

	it("treats RunUAT.sh as a normal executable — only Windows needs an interpreter", () => {
		const inv = resolveInvocation(
			"/opt/UE/Engine/Build/BatchFiles/RunUAT.sh",
			["BuildCookRun"],
			"linux",
		);
		expect(inv.file).toBe("/opt/UE/Engine/Build/BatchFiles/RunUAT.sh");
		expect(inv.windowsVerbatimArguments).toBe(false);
	});

	it("does not treat a .bat path as a batch file on a non-Windows platform", () => {
		const inv = resolveInvocation(UAT, ["BuildCookRun"], "linux");
		expect(inv.file).toBe(UAT);
		expect(inv.args).toEqual(["BuildCookRun"]);
	});

	// Regression: spawning a .bat directly fails with EINVAL on Node >=18.20.2 /
	// >=20.12.2 (the CVE-2024-27980 fix), which is the floor in package.json
	// engines. Every UAT-backed tool on Windows goes through RunUAT.bat.
	it("routes a Windows .bat through cmd.exe instead of spawning it directly", () => {
		const inv = resolveInvocation(UAT, ["BuildCookRun"], "win32");
		expect(inv.file).toMatch(/cmd\.exe$/i);
		expect(inv.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
		expect(inv.windowsVerbatimArguments).toBe(true);
	});

	it("routes a Windows .cmd through cmd.exe too, case-insensitively", () => {
		expect(resolveInvocation("C:\\x\\Foo.CMD", [], "win32").file).toMatch(/cmd\.exe$/i);
		expect(resolveInvocation("C:\\x\\Foo.BAT", [], "win32").file).toMatch(/cmd\.exe$/i);
	});

	// The reason this doesn't just use `shell: true`: Node space-joins argv
	// without quoting under a shell, so any argument with a space is corrupted —
	// and -project=<path> routinely has one.
	it("quotes every token individually so paths with spaces survive", () => {
		const inv = resolveInvocation(
			UAT,
			[
				"BuildCookRun",
				"-project=C:\\Users\\Jo Bloggs\\My Project\\My Project.uproject",
				"-platform=Win64",
			],
			"win32",
		);
		const line = inv.args[3];
		expect(line).toBe(
			`""${UAT}" "BuildCookRun" "-project=C:\\Users\\Jo Bloggs\\My Project\\My Project.uproject" "-platform=Win64""`,
		);
	});

	// `cmd /s /c` strips exactly the outermost quote pair before parsing, so the
	// whole line needs one extra wrapping pair on top of the per-token quotes.
	it("wraps the whole command line in the extra quote pair that /s strips", () => {
		const line = resolveInvocation(UAT, ["Foo"], "win32").args[3];
		expect(line.startsWith('""')).toBe(true);
		expect(line.endsWith('""')).toBe(true);
		expect(line.slice(1, -1)).toBe(`"${UAT}" "Foo"`);
	});

	it("rejects tokens cmd.exe cannot safely quote", () => {
		expect(() => resolveInvocation(UAT, ["-project=%APPDATA%\\x.uproject"], "win32")).toThrow(
			UnrealMcpError,
		);
		expect(() => resolveInvocation(UAT, ['-project="quoted"'], "win32")).toThrow(UnrealMcpError);
		expect(() => resolveInvocation("C:\\100%\\RunUAT.bat", [], "win32")).toThrow(UnrealMcpError);
	});

	it("allows those same characters when no interpreter is involved", () => {
		expect(() => resolveInvocation("/opt/UE/RunUAT.sh", ["-x=100%"], "linux")).not.toThrow();
	});
});
