import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionManager } from "../transports/connection-manager.js";
import type { UnrealMcpConfig } from "../types.js";
import { inlineScript } from "../utils/template.js";

export function registerMaterialTools(
	server: McpServer,
	manager: ConnectionManager,
	_config: UnrealMcpConfig,
): void {
	server.tool(
		"apply_material",
		"Apply a material to an actor's mesh component.",
		{
			actor_name: z.string().describe("Actor name or label"),
			material_path: z.string().describe("Material asset path"),
			slot_index: z.number().default(0).describe("Material slot index"),
		},
		async ({ actor_name, material_path, slot_index }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
material = unreal.EditorAssetLibrary.load_asset('{{material_path}}')
if not material:
    print(json.dumps({"error": "Material not found: {{material_path}}"}))
else:
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors()
    for a in actors:
        if a.get_name() == '{{actor_name}}' or a.get_actor_label() == '{{actor_name}}':
            comps = a.get_components_by_class(unreal.MeshComponent)
            if comps:
                comps[0].set_material(${slot_index}, material)
                print(json.dumps({"success": True}))
            else:
                print(json.dumps({"error": "No mesh component found"}))
            break
    else:
        print(json.dumps({"error": "Actor not found: {{actor_name}}"}))`,
				{ actor_name, material_path },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);
}
