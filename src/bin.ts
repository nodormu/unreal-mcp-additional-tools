#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./index.js";

async function main() {
	const { server, config } = await createServer();

	const transport = new StdioServerTransport();
	await server.connect(transport);

	// Log startup info to stderr (stdout is reserved for MCP protocol)
	console.error("[unreal-mcp-additional-tools] Server started");
	console.error(`[unreal-mcp-additional-tools] Project: ${config.projectPath || "(not set)"}`);
	console.error(`[unreal-mcp-additional-tools] Engine: ${config.enginePath || "(not set)"}`);
	console.error(`[unreal-mcp-additional-tools] Modules: ${config.enabledModules.join(", ")}`);
}

main().catch((err) => {
	console.error("[unreal-mcp-additional-tools] Fatal error:", err);
	process.exit(1);
});
