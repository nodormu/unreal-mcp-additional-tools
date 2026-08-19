import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionManager } from "../transports/connection-manager.js";
import type { UnrealMcpConfig } from "../types.js";
import { inlineScript } from "../utils/template.js";

export function registerConsoleTools(
	server: McpServer,
	manager: ConnectionManager,
	_config: UnrealMcpConfig,
): void {
	server.tool(
		"execute_python",
		"Execute arbitrary Python code in the Unreal Editor's Python environment. Has access to the full `unreal` module.",
		{ code: z.string().describe("Python code to execute in the editor") },
		async ({ code }) => {
			manager.requireEditor();
			const result = await manager.runPython(code);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"execute_console_command",
		"Run a console command in the Unreal Editor (e.g., 'stat fps', 'stat unit', 'r.SetRes 1920x1080').",
		{ command: z.string().describe("Console command to execute") },
		async ({ command }) => {
			manager.requireEditor();
			// Execute console command via Python
			const script = inlineScript(
				`import unreal\nunreal.SystemLibrary.execute_console_command(None, '{{command}}')`,
				{ command },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result || `Executed: ${command}` }] };
		},
	);

	server.tool(
		"get_connection_status",
		"Check which Unreal Engine transports are currently connected (Remote Control, Python, Plugin Bridge).",
		{},
		async () => {
			const status = await manager.refreshStatus();
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(status, null, 2),
					},
				],
			};
		},
	);
}
