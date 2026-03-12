// src/index.ts
// FileMaker OData MCP Server — Entry Point

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { FileMakerODataClient, type FMConfig } from "./odata-client.js";
import { FileMakerDataAPIClient } from "./data-api-client.js";
import { toolDefinitions, handleTool } from "./tools.js";
import { zodToJsonSchema } from "zod-to-json-schema";

// --- Configuration from environment variables --------------------------------

function loadConfig(): FMConfig {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) {
      console.error(`ERROR: Missing required environment variable: ${key}`);
      process.exit(1);
    }
    return val;
  };

  // Allow self-signed certificates in dev environments
  if (process.env["FM_ALLOW_SELF_SIGNED"] === "true") {
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
    console.error("WARNING: TLS certificate verification disabled (FM_ALLOW_SELF_SIGNED=true)");
  }

  return {
    host:     required("FM_HOST"),
    database: required("FM_DATABASE"),
    username: required("FM_USERNAME"),
    password: required("FM_PASSWORD"),
    version:  process.env["FM_ODATA_VERSION"] ?? "v4",
  };
}

// --- Server setup ------------------------------------------------------------

async function main() {
  const config = loadConfig();
  const client = new FileMakerODataClient(config);
  const dataApiClient = new FileMakerDataAPIClient(config);

  // Read disabled tools from environment variable
  const disabledTools = new Set(
    (process.env["FM_DISABLED_TOOLS"] ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
  );

  const activeTools = disabledTools.size > 0
    ? toolDefinitions.filter((t) => !disabledTools.has(t.name))
    : toolDefinitions;

  console.error(`FileMaker OData MCP Server`);
  console.error(`  Host:     ${config.host}`);
  console.error(`  Database: ${config.database}`);
  console.error(`  User:     ${config.username}`);
  console.error(`  Tools:    ${activeTools.length}/${toolDefinitions.length}`);
  if (disabledTools.size > 0) {
    console.error(`  Disabled: ${[...disabledTools].join(", ")}`);
  }

  const server = new Server(
    { name: "mcp-server-filemaker", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // Expose tool list (active tools only)
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: activeTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    console.error(`Tool: ${name}`, args ? JSON.stringify(args).slice(0, 120) : "");

    // Block disabled tools
    if (disabledTools.has(name)) {
      return {
        content: [{ type: "text" as const, text: `BLOCKED: Tool "${name}" is disabled for this database (FM_DISABLED_TOOLS).` }],
      };
    }

    try {
      return await handleTool(name, (args ?? {}) as Record<string, unknown>, client, dataApiClient);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`ERROR: Tool ${name} failed:`, msg);
      return {
        content: [{ type: "text" as const, text: `ERROR in ${name}: ${msg}` }],
      };
    }
  });

  // STDIO transport (standard for Claude Code MCP)
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Server ready (stdio)");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
