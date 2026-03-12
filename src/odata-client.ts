// src/odata-client.ts
// Central HTTP client for all FileMaker OData v4 requests

export interface FMConfig {
  host: string;       // e.g. "https://fms.example.com"
  database: string;   // e.g. "MyDatabase"
  username: string;
  password: string;
  version?: string;   // default "v4"
}

export interface ODataResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  raw?: string;
}

export interface RecordSet {
  "@odata.context"?: string;
  "@odata.count"?: number;
  value: Record<string, unknown>[];
}

export interface ScriptResult {
  scriptResult: {
    code: number;
    resultParameter?: string;
  };
}

export class FileMakerODataClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(private config: FMConfig) {
    const ver = config.version ?? "v4";
    this.baseUrl = `${config.host}/fmi/odata/${ver}/${encodeURIComponent(config.database)}`;
    this.authHeader = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    contentType = "application/json"
  ): Promise<ODataResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
      "OData-Version": "4.0",
    };
    if (body !== undefined) {
      headers["Content-Type"] = contentType;
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      const raw = await res.text();
      let data: T | undefined;
      try {
        data = raw ? JSON.parse(raw) : undefined;
      } catch {
        // non-JSON response (e.g. empty DELETE responses or XML metadata)
      }

      if (!res.ok) {
        return { ok: false, status: res.status, error: raw, raw };
      }
      return { ok: true, status: res.status, data, raw };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // --- Metadata ---------------------------------------------------------------

  /** Full OData $metadata document (EDMX/XML) */
  async getMetadata(): Promise<ODataResponse<string>> {
    const url = `${this.baseUrl}/$metadata`;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: this.authHeader,
          Accept: "application/xml",
          "OData-Version": "4.0",
        },
      });
      const raw = await res.text();
      return { ok: res.ok, status: res.status, data: raw, raw };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Service Document — lists all available tables/EntitySets */
  async getServiceDocument(): Promise<ODataResponse<RecordSet>> {
    return this.request<RecordSet>("GET", "");
  }

  // --- Data read --------------------------------------------------------------

  /**
   * Query records with full OData query support:
   * filter, select, top, skip, orderby, expand, count
   */
  async queryRecords(
    table: string,
    params: {
      filter?: string;
      select?: string;
      top?: number;
      skip?: number;
      orderby?: string;
      expand?: string;
      count?: boolean;
    } = {}
  ): Promise<ODataResponse<RecordSet>> {
    // Build query string manually — URLSearchParams encodes OData characters incorrectly
    // (commas as %2C, quotes as %27, parentheses as %28/%29)
    const parts: string[] = [];
    if (params.filter)  parts.push(`$filter=${params.filter}`);
    if (params.select)  parts.push(`$select=${params.select}`);
    if (params.top)     parts.push(`$top=${params.top}`);
    if (params.skip)    parts.push(`$skip=${params.skip}`);
    if (params.orderby) parts.push(`$orderby=${params.orderby}`);
    if (params.expand)  parts.push(`$expand=${params.expand}`);
    if (params.count)   parts.push(`$count=true`);
    const query = parts.length ? `?${parts.join("&")}` : "";
    return this.request<RecordSet>("GET", `/${table}${query}`);
  }

  /** Read a single record by ROWID */
  async getRecord(table: string, rowId: string | number): Promise<ODataResponse<Record<string, unknown>>> {
    return this.request("GET", `/${table}(${rowId})`);
  }

  // --- Data write -------------------------------------------------------------

  /** Create a new record */
  async createRecord(
    table: string,
    data: Record<string, unknown>
  ): Promise<ODataResponse<Record<string, unknown>>> {
    return this.request("POST", `/${table}`, data);
  }

  /** Update a record (PATCH = partial update) */
  async updateRecord(
    table: string,
    rowId: string | number,
    data: Record<string, unknown>
  ): Promise<ODataResponse<void>> {
    return this.request("PATCH", `/${table}(${rowId})`, data);
  }

  /** Delete a record */
  async deleteRecord(table: string, rowId: string | number): Promise<ODataResponse<void>> {
    return this.request("DELETE", `/${table}(${rowId})`);
  }

  // --- Scripts ----------------------------------------------------------------

  /**
   * Execute a FileMaker script via OData.
   * POST /Script.{scriptName}
   * Body: { scriptParameterValue: "..." } or empty if no parameter.
   *
   * Note: Script names with special characters/spaces are URL-encoded.
   * Response: { scriptResult: { code: 0, resultParameter: "..." } }
   */
  async runScript(
    scriptName: string,
    scriptParam?: string
  ): Promise<ODataResponse<ScriptResult>> {
    const encodedName = encodeURIComponent(scriptName);
    const path = `/Script.${encodedName}`;
    const body = scriptParam !== undefined ? { scriptParameterValue: scriptParam } : undefined;
    return this.request<ScriptResult>("POST", path, body);
  }

  // --- Schema modification ----------------------------------------------------

  /**
   * Create a new table.
   * POST /FileMaker_Tables
   * Body: { tableName: "NewTable" }
   */
  async createTable(tableName: string): Promise<ODataResponse<unknown>> {
    return this.request("POST", "/FileMaker_Tables", { tableName });
  }

  /**
   * Add a field to a table.
   * PATCH /FileMaker_Tables/{tableName}
   * Body: { fieldName: "...", fieldType: "VARCHAR(100)" }
   *
   * Field types (SQL-style): VARCHAR(n), INT, NUMERIC, DATE, TIME, TIMESTAMP, BLOB
   */
  async addField(
    tableName: string,
    field: {
      fieldName: string;
      fieldType: string;  // SQL-style: "VARCHAR(100)", "INT", "NUMERIC", "DATE", etc.
      fieldRepetition?: number;
    }
  ): Promise<ODataResponse<unknown>> {
    return this.request("PATCH", `/FileMaker_Tables/${encodeURIComponent(tableName)}`, field);
  }

  // --- Batch ------------------------------------------------------------------

  /**
   * Batch request: multiple operations in a single HTTP call.
   * Returns the raw batch response (multipart/mixed).
   *
   * Note: Write operations require changesets per the OData spec.
   * Currently only reliable for GET batch requests.
   */
  async batch(requests: BatchRequest[]): Promise<ODataResponse<string>> {
    const boundary = `batch_${Date.now()}`;
    const body = buildBatchBody(requests, boundary, this.baseUrl);
    const url = `${this.baseUrl}/$batch`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": `multipart/mixed;boundary=${boundary}`,
        "OData-Version": "4.0",
      },
      body,
    });
    const raw = await res.text();
    return { ok: res.ok, status: res.status, data: raw, raw };
  }
}

// --- Batch helper -------------------------------------------------------------

export interface BatchRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;  // relative to DB root, e.g. "/Contacts" or "/Contacts(123)"
  body?: unknown;
  id?: string;
}

function buildBatchBody(requests: BatchRequest[], boundary: string, baseUrl: string): string {
  const parts = requests.map((r, i) => {
    const id = r.id ?? `req-${i}`;
    const bodyStr = r.body ? JSON.stringify(r.body) : "";
    const hasBody = ["POST", "PATCH", "PUT"].includes(r.method) && bodyStr;
    const lines: string[] = [
      `--${boundary}`,
      `Content-Type: application/http`,
      `Content-Transfer-Encoding: binary`,
      `Content-ID: ${id}`,
      "",
      `${r.method} ${baseUrl}${r.path} HTTP/1.1`,
      `Accept: application/json`,
    ];
    if (hasBody) {
      lines.push(`Content-Type: application/json`);
      lines.push(`Content-Length: ${Buffer.byteLength(bodyStr, "utf-8")}`);
    }
    lines.push("");
    if (hasBody) {
      lines.push(bodyStr);
    }
    return lines.join("\r\n");
  });
  return [...parts, `--${boundary}--`].join("\r\n");
}
