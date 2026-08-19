import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionManager } from "../transports/connection-manager.js";
import type { UnrealMcpConfig } from "../types.js";
import { inlineScript } from "../utils/template.js";

export function registerAssetTools(
	server: McpServer,
	manager: ConnectionManager,
	config: UnrealMcpConfig,
): void {
	server.tool(
		"import_asset",
		"Import an external file (FBX, PNG, WAV, etc.) into the project.",
		{
			source_file: z.string().describe("Path to the file on disk to import"),
			destination_path: z
				.string()
				.describe("Content directory to import into (e.g., /Game/Meshes)"),
		},
		async ({ source_file, destination_path }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
tasks = [unreal.AssetImportTask()]
tasks[0].filename = '{{source_file}}'
tasks[0].destination_path = '{{destination_path}}'
tasks[0].automated = True
tasks[0].save = True
tasks[0].replace_existing = True
unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks(tasks)
if tasks[0].imported_object_paths:
    print(json.dumps({"success": True, "imported": [str(p) for p in tasks[0].imported_object_paths]}))
else:
    print(json.dumps({"success": False, "error": "Import failed"}))`,
				{ source_file, destination_path },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"export_asset",
		"Export an asset to an external file format.",
		{
			asset_path: z.string().describe("Asset to export"),
			output_path: z.string().describe("Output file path on disk"),
		},
		async ({ asset_path, output_path }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
task = unreal.AssetExportTask()
task.object = unreal.EditorAssetLibrary.load_asset('{{asset_path}}')
task.filename = '{{output_path}}'
task.automated = True
task.prompt = False
success = unreal.Exporter.run_asset_export_task(task)
print(json.dumps({"success": success, "output": '{{output_path}}'}))`,
				{ asset_path, output_path },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"validate_assets",
		"Run data validation on assets in a directory and return the actual results " +
			"(pass/fail counts and a per-validator breakdown), not just a completion flag.",
		{
			directory: z.string().default("/Game").describe("Content directory to validate"),
			limit: z
				.number()
				.int()
				.positive()
				.default(50)
				.describe("Maximum number of assets to validate in one call (safety cap)"),
		},
		async ({ directory, limit }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
subsys = unreal.get_editor_subsystem(unreal.EditorValidatorSubsystem)
registry = unreal.AssetRegistryHelpers.get_asset_registry()
assets = registry.get_assets_by_path('{{directory}}', True) or []
asset_list = [a for a in assets[:{{limit}}]]
# validate_assets_with_settings returns (return_code, ValidateAssetsResults) - it does
# NOT accept a pre-built results object as a third argument. Signature confirmed
# against UE 5.81; re-check this call if targeting an older engine.
_, results = subsys.validate_assets_with_settings(asset_list, unreal.ValidateAssetsSettings())
validator_breakdown = {}
for key in results.validator_statistics.keys():
    stats = results.validator_statistics[key]
    validated = stats.get_editor_property('assets_validated')
    if validated:
        validator_breakdown[str(key.asset_name)] = validated
print(json.dumps({
    "directory": '{{directory}}',
    "num_requested": results.num_requested,
    "num_checked": results.num_checked,
    "num_valid": results.num_valid,
    "num_invalid": results.num_invalid,
    "num_warnings": results.num_warnings,
    "num_skipped": results.num_skipped,
    "num_unable_to_validate": results.num_unable_to_validate,
    "asset_limit_reached": results.asset_limit_reached,
    "validators_that_ran": validator_breakdown,
}))`,
				{ directory, limit },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"fix_redirectors",
		"Clean up asset redirectors in the project (runs FixUpRedirects commandlet).",
		{},
		async () => {
			const result = await manager.subprocess.runCommandlet("FixupRedirects", ["-autocheckout"]);
			return {
				content: [
					{
						type: "text",
						text:
							result.exitCode === 0
								? "Redirectors fixed successfully."
								: `Failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
					},
				],
			};
		},
	);

	server.tool(
		"resave_packages",
		"Bulk resave all packages in the project (runs ResavePackages commandlet).",
		{
			directory: z.string().optional().describe("Limit to a specific content directory"),
		},
		async ({ directory }) => {
			const args: string[] = [];
			if (directory) args.push(`-packagefolder=${directory}`);
			const result = await manager.subprocess.runCommandlet("ResavePackages", args);
			return {
				content: [
					{
						type: "text",
						text:
							result.exitCode === 0
								? "Packages resaved successfully."
								: `Failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
					},
				],
			};
		},
	);

	server.tool(
		"content_audit",
		"Run content audit to find costly or problematic assets (runs ContentAudit commandlet).",
		{},
		async () => {
			const result = await manager.subprocess.runCommandlet("ContentAudit");
			return {
				content: [
					{
						type: "text",
						text:
							result.exitCode === 0
								? `Audit complete:\n${result.stdout}`
								: `Failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
					},
				],
			};
		},
	);

	server.tool(
		"consolidate_assets",
		"Consolidate duplicate assets — replace references from source assets to a target asset.",
		{
			target_path: z.string().describe("Target asset path to keep"),
			source_paths: z.array(z.string()).describe("Source asset paths to consolidate into target"),
		},
		async ({ target_path, source_paths }) => {
			manager.requireEditor();
			const sourcePathsJson = JSON.stringify(source_paths);
			const script = inlineScript(
				`import unreal
import json
target = unreal.EditorAssetLibrary.load_asset('{{target_path}}')
source_paths = json.loads('{{source_paths_json}}')
sources = [unreal.EditorAssetLibrary.load_asset(p) for p in source_paths]
sources = [s for s in sources if s is not None]
if target and sources:
    unreal.get_editor_subsystem(unreal.EditorAssetSubsystem).consolidate_assets(target, sources)
    print(json.dumps({"success": True, "consolidated": len(sources)}))
else:
    print(json.dumps({"error": "Could not load target or source assets"}))`,
				{ target_path, source_paths_json: sourcePathsJson },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);
}
