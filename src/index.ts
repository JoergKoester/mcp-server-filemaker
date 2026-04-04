// src/index.ts
// FileMaker OData MCP Server -- Entry Point

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

// --- CONFIGURATION from environment variables --------------------------------

function loadConfig(): FMConfig {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) {
      console.error(`ERROR: Environment variable ${key} is missing!`);
      process.exit(1);
    }
    return val;
  };

  const parseIntEnv = (key: string): number | undefined => {
    const raw = process.env[key];
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    if (isNaN(n)) {
      console.error(`WARNING: ${key}="${raw}" is not a valid number; falling back to default.`);
      return undefined;
    }
    return n;
  };
  return {
    host:       required("FM_HOST"),      // e.g. https://fms.example.com
    database:   required("FM_DATABASE"),  // e.g. MyDatabase
    username:   required("FM_USERNAME"),
    password:   required("FM_PASSWORD"),
    version:    process.env["FM_ODATA_VERSION"] ?? "v4",
    timeoutMs:  parseIntEnv("FM_TIMEOUT_MS"),
    retryCount: parseIntEnv("FM_RETRY_COUNT"),
  };
}

// --- SERVER SETUP ------------------------------------------------------------

async function main() {
  const config = loadConfig();
  const client = new FileMakerODataClient(config);
  const dataApiClient = new FileMakerDataAPIClient(config);
  const debug = process.env["FM_DEBUG"] === "true";

  // Read disabled tools from environment variable
  const disabledTools = new Set(
    (process.env["FM_DISABLED_TOOLS"] ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
  );

  const isDisabled = (name: string) => disabledTools.has(name.toLowerCase());

  const activeTools = disabledTools.size > 0
    ? toolDefinitions.filter((t) => !isDisabled(t.name))
    : toolDefinitions;

  console.error(`FileMaker OData MCP Server`);
  console.error(`  Host:     ${config.host}`);
  console.error(`  Database: ${config.database}`);
  console.error(`  User:     ${config.username}`);
  console.error(`  Timeout:  ${config.timeoutMs ?? 15000}ms`);
  console.error(`  Retries:  ${config.retryCount ?? 2} (on 429/503)`);
  console.error(`  Tools:    ${activeTools.length}/${toolDefinitions.length}`);
  if (disabledTools.size > 0) {
    console.error(`  Disabled: ${[...disabledTools].join(", ")}`);
  }
  if (debug) {
    console.error(`  Debug:    ON (full argument logging)`);
  }

  const server = new Server(
    { name: "filemaker-odata-mcp", version: "1.1.0" },
    { capabilities: { tools: {} } }
  );

  // Expose tool list (only active tools)
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
    const argStr = args ? JSON.stringify(args) : "";
    console.error(`Tool: ${name}`, debug ? argStr : argStr.slice(0, 120));

    // Block disabled tools
    if (isDisabled(name)) {
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

  // Connectivity check before starting transport (non-fatal)
  const healthCheck = await client.getServiceDocument();
  if (healthCheck.ok) {
    console.error(`  Health:   OK (FM server reachable)`);
  } else {
    console.error(`  Health:   WARNING — FM server not reachable: ${healthCheck.error ?? healthCheck.status}`);
  }

  // STDIO transport (standard for MCP clients)
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server ready (stdio)");

  // Graceful shutdown on SIGTERM/SIGINT
  const shutdown = async (signal: string) => {
    console.error(`${signal} received, shutting down...`);
    try {
      await server.close();
    } catch (err) {
      console.error("Error while closing:", err);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
