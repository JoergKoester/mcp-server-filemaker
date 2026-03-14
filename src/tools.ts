// src/tools.ts
// MCP tool definitions with Zod schemas and handler logic

import { z } from "zod";
import { FileMakerODataClient } from "./odata-client.js";
import { FileMakerDataAPIClient } from "./data-api-client.js";

// --- Zod schemas (input validation) ------------------------------------------

export const schemas = {

  // Metadata & Structure
  getMetadata: z.object({}),
  getServiceDocument: z.object({}),

  // Query
  queryRecords: z.object({
    table:   z.string().describe("FileMaker table name (exact name as defined in FM)"),
    filter:  z.string().optional().describe("OData $filter expression, e.g. \"Name eq 'John'\""),
    select:  z.string().optional().describe("Comma-separated field names, e.g. \"ID,Name,Date\""),
    top:     z.number().int().min(1).max(1000).optional().describe("Max number of records to return"),
    skip:    z.number().int().min(0).optional().describe("Number of records to skip (pagination)"),
    orderby: z.string().optional().describe("Sort order, e.g. \"Name asc\""),
    expand:  z.string().optional().describe("Include portals, e.g. \"LineItems\""),
    count:   z.boolean().optional().describe("Include total record count"),
  }),

  getRecord: z.object({
    table: z.string(),
    rowId: z.union([z.string(), z.number()]).describe("ROWID of the record"),
  }),

  // CRUD
  createRecord: z.object({
    table:  z.string(),
    fields: z.record(z.unknown()).describe("Field data as key-value object"),
  }),

  updateRecord: z.object({
    table:  z.string(),
    rowId:  z.union([z.string(), z.number()]),
    fields: z.record(z.unknown()).describe("Fields to update"),
  }),

  deleteRecord: z.object({
    table: z.string(),
    rowId: z.union([z.string(), z.number()]),
  }),

  // Scripts
  runScript: z.object({
    scriptName:  z.string().describe("Exact script name as defined in FileMaker. Spaces and special characters are allowed (URL-encoded automatically)."),
    scriptParam: z.string().optional().describe("Script parameter (JSON string recommended)"),
  }),

  // Schema
  createTable: z.object({
    tableName: z.string().describe("Name of the new table"),
  }),

  addField: z.object({
    table:     z.string(),
    fieldName: z.string(),
    fieldType: z.string().describe("SQL-style field type: VARCHAR(n), INT, NUMERIC, DATE, TIME, TIMESTAMP, BLOB"),
    fieldRepetition: z.number().int().optional().describe("Number of repetitions (optional)"),
  }),

  // Batch
  batch: z.object({
    requests: z.array(z.object({
      method: z.enum(["GET","POST","PATCH","PUT","DELETE"]),
      path:   z.string().describe("Relative path, e.g. /Contacts or /Contacts(123)"),
      body:   z.record(z.unknown()).optional(),
      id:     z.string().optional(),
    })).describe("List of OData requests (write ops require changesets — currently only GET batches are reliable)"),
  }),

  // --- Test & validation tools -----------------------------------------------

  /** Create a structured test record and return its ROWID */
  createTestRecord: z.object({
    table:    z.string(),
    fields:   z.record(z.unknown()),
    tag:      z.string().optional().describe("Marker text for later cleanup, e.g. '__TEST__'"),
    tagField: z.string().describe("Field name for the test marker (must exist as a text field in the FM table)"),
  }),

  /** Delete all records matching a specific test tag */
  cleanupTestData: z.object({
    table:    z.string(),
    tag:      z.string().optional().default("__CLAUDE_TEST__"),
    tagField: z.string().describe("Field name for the test marker (must exist as a text field in the FM table)"),
  }),

  /** Check whether a record has the expected field values */
  assertRecord: z.object({
    table:    z.string(),
    rowId:    z.union([z.string(), z.number()]),
    expected: z.record(z.unknown()).describe("Expected field values"),
  }),

  /** Check whether a query returns the expected number of records */
  assertCount: z.object({
    table:    z.string(),
    filter:   z.string().optional(),
    expected: z.number().int().describe("Expected record count"),
  }),

  /** Run a script and validate its ResultCode */
  runScriptAndAssert: z.object({
    scriptName:         z.string(),
    scriptParam:        z.string().optional(),
    expectedResultCode: z.union([z.string(), z.number()]).optional().default("0"),
  }),

  /** Read DB structure and return tables + fields as overview */
  introspectTable: z.object({
    table: z.string().optional().describe("If empty: list all tables. If set: show fields with types from $metadata."),
  }),

  // --- Data API tools (globals + script with session context) ----------------

  /** Set global fields via Data API */
  setGlobals: z.object({
    globals: z.record(z.string()).describe("Global fields as key-value. Keys must be fully qualified: 'Table::FieldName_g'"),
  }),

  /** Run script with globals set in the same session (Login → Set Globals → Run Script → Logout) */
  runScriptWithGlobals: z.object({
    globals:     z.record(z.string()).describe("Global fields as key-value. Keys: 'Table::FieldName_g'"),
    layout:      z.string().describe("Layout name for Data API script execution (must be based on the correct table)"),
    scriptName:  z.string().describe("Exact script name"),
    scriptParam: z.string().optional().describe("Script parameter (JSON string recommended)"),
  }),
};

// --- Tool definitions --------------------------------------------------------

export const toolDefinitions = [
  {
    name: "fm_get_metadata",
    description: "Reads the full OData $metadata document of the FileMaker database (EDMX/XML). Contains all tables, fields, types and relationships.",
    inputSchema: schemas.getMetadata,
  },
  {
    name: "fm_get_service_document",
    description: "Lists all available EntitySets (tables) of the FileMaker database.",
    inputSchema: schemas.getServiceDocument,
  },
  {
    name: "fm_query",
    description: "Query records from a FileMaker table. Supports OData $filter, $select, $top, $skip, $orderby, $expand, $count.",
    inputSchema: schemas.queryRecords,
  },
  {
    name: "fm_get_record",
    description: "Read a single record by ROWID from FileMaker.",
    inputSchema: schemas.getRecord,
  },
  {
    name: "fm_create_record",
    description: "Create a new record in a FileMaker table.",
    inputSchema: schemas.createRecord,
  },
  {
    name: "fm_update_record",
    description: "Update an existing FileMaker record by ROWID (PATCH).",
    inputSchema: schemas.updateRecord,
  },
  {
    name: "fm_delete_record",
    description: "Delete a FileMaker record by ROWID.",
    inputSchema: schemas.deleteRecord,
  },
  {
    name: "fm_run_script",
    description: "Execute a FileMaker script. Returns scriptResult with code and resultParameter.",
    inputSchema: schemas.runScript,
  },
  {
    name: "fm_create_table",
    description: "Create a new table in the FileMaker database (schema modification via OData).",
    inputSchema: schemas.createTable,
  },
  {
    name: "fm_add_field",
    description: "Add a new field to an existing FileMaker table. Field types in SQL-style: VARCHAR(n), INT, NUMERIC, DATE, TIME, TIMESTAMP, BLOB.",
    inputSchema: schemas.addField,
  },
  {
    name: "fm_batch",
    description: "Execute multiple OData requests in a single HTTP call (batch). Currently only reliable for GET requests — write ops require changesets.",
    inputSchema: schemas.batch,
  },
  // -- Test & Validation --
  {
    name: "fm_create_test_record",
    description: "Creates a test record with a test tag. tagField must be an existing text field in the FM table. Returns ROWID for later validation and cleanup.",
    inputSchema: schemas.createTestRecord,
  },
  {
    name: "fm_cleanup_test_data",
    description: "Deletes all test records marked with a specific tag. tagField must be an existing text field in the FM table.",
    inputSchema: schemas.cleanupTestData,
  },
  {
    name: "fm_assert_record",
    description: "Validates whether a FileMaker record contains the expected field values. Returns PASS/FAIL with diff.",
    inputSchema: schemas.assertRecord,
  },
  {
    name: "fm_assert_count",
    description: "Checks whether a query returns the expected number of records. Useful for validating script results.",
    inputSchema: schemas.assertCount,
  },
  {
    name: "fm_run_script_and_assert",
    description: "Executes a FileMaker script and checks whether the ResultCode matches the expected value.",
    inputSchema: schemas.runScriptAndAssert,
  },
  {
    name: "fm_introspect",
    description: "Analyzes database structure: lists tables or shows all fields of a table with native FM field types from $metadata.",
    inputSchema: schemas.introspectTable,
  },
  // -- Data API Tools --
  {
    name: "fm_set_globals",
    description: "Sets global fields via FileMaker Data API (not OData). Opens a Data API session, sets the globals, and closes the session. Keys must be fully qualified: 'Table::FieldName_g'.",
    inputSchema: schemas.setGlobals,
  },
  {
    name: "fm_run_script_with_globals",
    description: "Sets global fields and runs a script in the SAME Data API session. This enables scripts that depend on global fields as context (e.g. Sessions::UUID_g). Flow: Login → Set Globals → Run Script → Logout.",
    inputSchema: schemas.runScriptWithGlobals,
  },
];

// --- Handler -----------------------------------------------------------------

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: FileMakerODataClient,
  dataApiClient?: FileMakerDataAPIClient
): Promise<{ content: Array<{ type: "text"; text: string }> }> {

  const ok = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });

  const fail = (msg: string) => ({
    content: [{ type: "text" as const, text: `ERROR: ${msg}` }],
  });

  switch (name) {

    // --- Metadata ------------------------------------------------------------

    case "fm_get_metadata": {
      const r = await client.getMetadata();
      if (!r.ok) return fail(r.error ?? "Failed to retrieve metadata");
      return ok({ status: r.status, metadata: r.data });
    }

    case "fm_get_service_document": {
      const r = await client.getServiceDocument();
      if (!r.ok) return fail(r.error ?? "Failed to retrieve service document");
      return ok(r.data);
    }

    case "fm_introspect": {
      const { table } = args as { table?: string };
      if (!table) {
        // List all tables
        const r = await client.getServiceDocument();
        if (!r.ok) return fail(r.error ?? "");
        const tables = (r.data as any)?.value?.map((e: any) => ({
          name: e.name,
          kind: e.kind,
          url: e.url,
        }));
        return ok({ tables, count: tables?.length });
      } else {
        // Read fields of a table from $metadata (native FM types)
        const r = await client.getMetadata();
        if (!r.ok) return fail(r.error ?? "Failed to retrieve metadata");
        const xml = r.data ?? "";

        // 1) Find EntitySet to determine the referenced EntityType name
        const entitySetRegex = new RegExp(
          `<EntitySet\\s+Name="${escapeRegex(table)}"\\s+EntityType="([^"]+)"`,
          "i"
        );
        const setMatch = xml.match(entitySetRegex);

        // EntityType name: from EntitySet reference (e.g. "FM.Contacts") or fallback to table
        let entityTypeName = table;
        if (setMatch) {
          // EntityType may be qualified (Namespace.Name) — extract just the name
          const fullType = setMatch[1];
          entityTypeName = fullType.includes(".") ? fullType.split(".").pop()! : fullType;
        }

        // 2) Find EntityType with the resolved name
        const entityTypeRegex = new RegExp(
          `<EntityType\\s+Name="${escapeRegex(entityTypeName)}"[^>]*>([\\s\\S]*?)</EntityType>`,
          "i"
        );
        const entityMatch = xml.match(entityTypeRegex);
        if (!entityMatch) {
          return fail(`Table "${table}" not found in $metadata (EntityType "${entityTypeName}" does not exist). Check available tables with fm_introspect (without table parameter).`);
        }
        const entityBlock = entityMatch[1];

        // Parse all Property elements
        const propRegex = /<Property\s+([^/]*?)\/>/gi;
        const fields: Array<{ field: string; type: string; nullable: boolean; maxLength?: number }> = [];
        let propMatch;
        while ((propMatch = propRegex.exec(entityBlock)) !== null) {
          const attrs = propMatch[1];
          const nameMatch = attrs.match(/Name="([^"]+)"/);
          const typeMatch = attrs.match(/Type="([^"]+)"/);
          const nullableMatch = attrs.match(/Nullable="([^"]+)"/);
          const maxLenMatch = attrs.match(/MaxLength="([^"]+)"/);
          if (nameMatch && typeMatch) {
            fields.push({
              field: nameMatch[1],
              type: typeMatch[1],
              nullable: nullableMatch ? nullableMatch[1] !== "false" : true,
              maxLength: maxLenMatch ? parseInt(maxLenMatch[1], 10) : undefined,
            });
          }
        }

        // Get total record count via $count
        const countRes = await client.queryRecords(table, { top: 1, select: "ROWID", count: true });
        const totalRecords = countRes.ok ? (countRes.data as any)?.["@odata.count"] : undefined;

        return ok({ table, fields, fieldCount: fields.length, totalRecords });
      }
    }

    // --- Data read -----------------------------------------------------------

    case "fm_query": {
      const { table, ...params } = args as any;
      const r = await client.queryRecords(table, params);
      if (!r.ok) return fail(r.error ?? "");
      return ok({
        table,
        count: r.data?.["@odata.count"] ?? r.data?.value?.length,
        records: r.data?.value,
      });
    }

    case "fm_get_record": {
      const { table, rowId } = args as any;
      const r = await client.getRecord(table, rowId);
      if (!r.ok) return fail(r.error ?? "");
      return ok(r.data);
    }

    // --- Data write ----------------------------------------------------------

    case "fm_create_record": {
      const { table, fields } = args as any;
      const data = { ...(fields ?? {}) };
      const r = await client.createRecord(table, data);
      if (!r.ok) return fail(r.error ?? "");
      return ok({ created: true, record: r.data });
    }

    case "fm_update_record": {
      const { table, rowId, fields } = args as any;
      const r = await client.updateRecord(table, rowId, fields);
      if (!r.ok) return fail(r.error ?? "");
      return ok({ updated: true, rowId });
    }

    case "fm_delete_record": {
      const { table, rowId } = args as any;
      const r = await client.deleteRecord(table, rowId);
      if (!r.ok) return fail(r.error ?? "");
      return ok({ deleted: true, rowId });
    }

    // --- Scripts -------------------------------------------------------------

    case "fm_run_script": {
      const { scriptName, scriptParam } = args as any;
      const r = await client.runScript(scriptName, scriptParam);
      if (!r.ok) return fail(r.error ?? "");
      const result = (r.data as any)?.scriptResult;
      return ok({
        scriptName,
        resultCode: result?.code,
        resultParameter: result?.resultParameter,
      });
    }

    // --- Schema --------------------------------------------------------------

    case "fm_create_table": {
      const { tableName } = args as any;
      const r = await client.createTable(tableName);
      if (!r.ok) return fail(r.error ?? "");
      return ok({ created: true, table: tableName });
    }

    case "fm_add_field": {
      const { table, fieldName, fieldType, fieldRepetition } = args as any;
      const fieldDef: Record<string, unknown> = { fieldName, fieldType };
      if (fieldRepetition !== undefined) {
        fieldDef.fieldRepetition = fieldRepetition;
      }
      const r = await client.addField(table, fieldDef as any);
      if (!r.ok) return fail(r.error ?? "");
      return ok({ added: true, field: fieldName, table });
    }

    // --- Batch ---------------------------------------------------------------

    case "fm_batch": {
      const { requests } = args as any;
      const r = await client.batch(requests);
      if (!r.ok) return fail(r.error ?? "");
      return ok({ batchResult: r.data });
    }

    // --- Test & validation ---------------------------------------------------

    case "fm_create_test_record": {
      const { table, fields, tag = "__CLAUDE_TEST__", tagField } = args as any;
      const data = { ...fields, [tagField]: tag };
      const r = await client.createRecord(table, data);
      if (!r.ok) return fail(r.error ?? "");
      const rowId = (r.data as any)?.ROWID ?? (r.data as any)?.rowId;
      return ok({ created: true, rowId, tag, tagField, table });
    }

    case "fm_cleanup_test_data": {
      const { table, tag = "__CLAUDE_TEST__", tagField } = args as any;
      // Find all test records
      const query = await client.queryRecords(table, {
        filter: `${tagField} eq '${tag}'`,
        select: `ROWID,${tagField}`,
        top: 500,
      });
      if (!query.ok) return fail(query.error ?? "");
      const records = query.data?.value ?? [];
      const deleted: unknown[] = [];
      const errors: unknown[] = [];
      for (const rec of records) {
        const id = (rec as any).ROWID;
        const d = await client.deleteRecord(table, id);
        if (d.ok) deleted.push(id);
        else errors.push({ id, error: d.error });
      }
      return ok({ cleaned: deleted.length, errors, table, tag, tagField });
    }

    case "fm_assert_record": {
      const { table, rowId, expected } = args as any;
      const r = await client.getRecord(table, rowId);
      if (!r.ok) return fail(r.error ?? "");
      const actual = r.data as Record<string, unknown>;
      const diffs: Array<{ field: string; expected: unknown; actual: unknown }> = [];
      for (const [field, expVal] of Object.entries(expected)) {
        const actVal = actual[field];
        if (String(actVal) !== String(expVal)) {
          diffs.push({ field, expected: expVal, actual: actVal });
        }
      }
      const pass = diffs.length === 0;
      return ok({
        result: pass ? "PASS" : "FAIL",
        table, rowId,
        diffs: pass ? [] : diffs,
        actual: pass ? undefined : actual,
      });
    }

    case "fm_assert_count": {
      const { table, filter, expected } = args as any;
      const r = await client.queryRecords(table, { filter, count: true, top: 1, select: "ROWID" });
      if (!r.ok) return fail(r.error ?? "");
      const actual = (r.data as any)?.["@odata.count"] ?? r.data?.value?.length ?? 0;
      const pass = actual === expected;
      return ok({
        result: pass ? "PASS" : "FAIL",
        table,
        filter: filter ?? "(no filter)",
        expected,
        actual,
      });
    }

    case "fm_run_script_and_assert": {
      const { scriptName, scriptParam, expectedResultCode = "0" } = args as any;
      const r = await client.runScript(scriptName, scriptParam);
      if (!r.ok) return fail(r.error ?? "");
      const result = (r.data as any)?.scriptResult;
      const actualCode = String(result?.code ?? "");
      const pass = actualCode === String(expectedResultCode);
      return ok({
        result: pass ? "PASS" : "FAIL",
        scriptName,
        expectedResultCode,
        actualResultCode: actualCode,
        resultParameter: result?.resultParameter,
      });
    }

    // --- Data API tools ------------------------------------------------------

    case "fm_set_globals": {
      if (!dataApiClient) return fail("Data API client not configured. Extended Privilege 'fmrest' required for the API user.");
      const { globals } = args as { globals: Record<string, string> };
      const loginRes = await dataApiClient.login();
      if (!loginRes.ok || !loginRes.data) return fail(`Login failed: ${loginRes.error}`);
      const token = loginRes.data;
      try {
        const r = await dataApiClient.setGlobals(token, globals);
        if (!r.ok) return fail(`Failed to set globals: ${r.error}`);
        return ok({ success: true, globalsSet: Object.keys(globals) });
      } finally {
        await dataApiClient.logout(token).catch(() => {});
      }
    }

    case "fm_run_script_with_globals": {
      if (!dataApiClient) return fail("Data API client not configured. Extended Privilege 'fmrest' required for the API user.");
      const { globals, layout, scriptName, scriptParam } = args as {
        globals: Record<string, string>;
        layout: string;
        scriptName: string;
        scriptParam?: string;
      };
      const r = await dataApiClient.runScriptWithGlobals(globals, layout, scriptName, scriptParam);
      if (!r.ok) return fail(r.error ?? "");
      return ok({
        scriptName,
        scriptError: r.data!.scriptError,
        scriptResult: r.data!.scriptResult,
        globalsSet: r.data!.globalsSet,
        layout,
      });
    }

    default:
      return fail(`Unknown tool: ${name}`);
  }
}

// --- Helper ------------------------------------------------------------------

/** Escape special characters for RegExp */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
