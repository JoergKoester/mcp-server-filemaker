# mcp-server-filemaker

[MCP](https://modelcontextprotocol.io/) server that gives AI assistants direct access to FileMaker databases via OData v4 API.

Works with any MCP-compatible client: **Claude Code**, **Claude Desktop**, **Cursor**, **Windsurf**, **Continue.dev**, **Zed**, and others.

Runs **on-premise** — no cloud proxy, no Claris ID required.

```
MCP Client  ──stdio──▶  MCP Server (Node.js)  ──OData v4 / HTTPS──▶  FileMaker Server
```

## Features

- **20 tools** — CRUD, scripts, schema introspection, batch requests, test & validation
- **OData v4** — direct table access (not layout-based like the Data API)
- **Data API bridge** — set global fields and run scripts with session context
- **Tool restrictions** — disable dangerous tools per database via `FM_DISABLED_TOOLS`
- **Zero dependencies** beyond the MCP SDK and Zod

## Prerequisites

1. **FileMaker Server** with OData access enabled (Admin Console → Connectors → OData)
2. A dedicated **API user** with Extended Privilege `fmodata`
3. For Data API tools (`fm_set_globals`, `fm_run_script_with_globals`): also `fmrest`
4. **HTTPS** — required for production; self-signed certs supported for development

## Installation

```bash
git clone https://github.com/JoergKoester/mcp-server-filemaker.git
cd mcp-server-filemaker
npm install
npm run build
```

## Configuration

Add the server to your MCP client config. For Claude Code and Claude Desktop, edit `~/.mcp.json`:

```json
{
  "mcpServers": {
    "filemaker": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-filemaker/dist/index.js"],
      "env": {
        "FM_HOST": "https://your-filemaker-server.example.com",
        "FM_DATABASE": "YourDatabase",
        "FM_USERNAME": "api_user",
        "FM_PASSWORD": "your_password",
        "FM_ODATA_VERSION": "v4",
        "FM_ALLOW_SELF_SIGNED": "false",
        "FM_DISABLED_TOOLS": ""
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FM_HOST` | Yes | FileMaker Server URL with protocol, e.g. `https://fms.example.com` |
| `FM_DATABASE` | Yes | Database name |
| `FM_USERNAME` | Yes | API user (needs Extended Privilege `fmodata`) |
| `FM_PASSWORD` | Yes | Password |
| `FM_ODATA_VERSION` | No | OData version, default `v4` |
| `FM_ALLOW_SELF_SIGNED` | No | `true` to accept self-signed certificates (dev only!) |
| `FM_DISABLED_TOOLS` | No | Comma-separated tool names to disable |

### Multiple Databases

Run one server instance per database:

```json
{
  "mcpServers": {
    "filemaker-app": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "FM_HOST": "https://fms.example.com",
        "FM_DATABASE": "MyApp",
        "FM_USERNAME": "api_user",
        "FM_PASSWORD": "secret",
        "FM_DISABLED_TOOLS": "fm_create_table,fm_add_field"
      }
    },
    "filemaker-data": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "FM_HOST": "https://fms.example.com",
        "FM_DATABASE": "MyData",
        "FM_USERNAME": "api_user",
        "FM_PASSWORD": "secret",
        "FM_DISABLED_TOOLS": "fm_create_table,fm_add_field,fm_delete_record"
      }
    }
  }
}
```

## Tools

### Structure & Metadata
| Tool | Description |
|------|-------------|
| `fm_get_service_document` | List all tables |
| `fm_get_metadata` | Full EDMX schema (fields, types, relationships) |
| `fm_introspect` | Tables overview or field details with native FM types |

### Data Access
| Tool | Description |
|------|-------------|
| `fm_query` | Query records with `$filter`, `$select`, `$top`, `$orderby`, `$expand`, `$count` |
| `fm_get_record` | Single record by ROWID |
| `fm_create_record` | Create a new record |
| `fm_update_record` | Update record (PATCH) |
| `fm_delete_record` | Delete record by ROWID |

### Scripts & Schema
| Tool | Description |
|------|-------------|
| `fm_run_script` | Execute a FileMaker script |
| `fm_create_table` | Create a new table |
| `fm_add_field` | Add a field (SQL-style types: `VARCHAR(n)`, `INT`, `NUMERIC`, `DATE`, etc.) |
| `fm_batch` | Batch multiple OData requests in one HTTP call |

### Data API (Session Context)
| Tool | Description |
|------|-------------|
| `fm_set_globals` | Set global fields (Login → PATCH /globals → Logout) |
| `fm_run_script_with_globals` | Set globals + run script in one session |

### Test & Validation
| Tool | Description |
|------|-------------|
| `fm_create_test_record` | Create a tagged test record |
| `fm_cleanup_test_data` | Delete all records matching a test tag |
| `fm_assert_record` | Validate field values (PASS/FAIL with diff) |
| `fm_assert_count` | Assert record count for a query |
| `fm_run_script_and_assert` | Run script and check result code |

## Tool Restrictions

Disable tools per database instance via `FM_DISABLED_TOOLS`:

```
FM_DISABLED_TOOLS=fm_create_table,fm_add_field,fm_delete_record
```

- Disabled tools are hidden from the tool list **and** blocked at execution (double protection)
- Server startup shows `Tools: 17/20` and lists disabled tools
- Recommended: always disable `fm_create_table` and `fm_add_field` on production databases

## Architecture

4 files in `src/`:

| File | Responsibility |
|------|---------------|
| `index.ts` | Entry point, env config, STDIO transport, tool routing |
| `odata-client.ts` | HTTP client for all OData v4 requests (CRUD, scripts, schema, batch) |
| `data-api-client.ts` | HTTP client for FileMaker Data API (globals, session-scoped scripts) |
| `tools.ts` | MCP tool definitions (Zod schemas), handler logic, test tools |

The server is a **thin proxy** — no caching, no connection pooling. Each OData request uses Basic Auth; Data API tools manage their own session (login → action → logout).

## Development

```bash
npm run dev      # Run with tsx (no build needed)
npm run watch    # Watch mode
npm run build    # Compile TypeScript → dist/
npm start        # Run compiled version
```

## OData API Reference

| Operation | Method | Endpoint |
|-----------|--------|----------|
| Service Document | GET | `/fmi/odata/v4/{db}` |
| Metadata (EDMX) | GET | `/fmi/odata/v4/{db}/$metadata` |
| Read records | GET | `/fmi/odata/v4/{db}/{table}?$filter=...` |
| Create record | POST | `/fmi/odata/v4/{db}/{table}` |
| Update record | PATCH | `/fmi/odata/v4/{db}/{table}({rowId})` |
| Delete record | DELETE | `/fmi/odata/v4/{db}/{table}({rowId})` |
| Run script | POST | `/fmi/odata/v4/{db}/Script.{scriptName}` |
| Create table | POST | `/fmi/odata/v4/{db}/FileMaker_Tables` |
| Add field | PATCH | `/fmi/odata/v4/{db}/FileMaker_Tables/{table}` |
| Batch | POST | `/fmi/odata/v4/{db}/$batch` |

## AI-generated experimental project

This MCP server was generated almost entirely with the assistance of a generative AI system and has only undergone limited human review so far. It is provided **as is**, without any guarantees of correctness, security, or fitness for a particular purpose. Use it at your own risk and always review and test the code thoroughly before using it in production.

The code in this repository is licensed under the MIT License. By using it, you agree that the authors and copyright holders are not liable for any claim, damages, or other liability arising from its use, as stated in the license.

## License

MIT
