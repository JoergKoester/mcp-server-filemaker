// src/odata-client.ts
// Central HTTP client for all FileMaker OData v4 requests

export interface FMConfig {
  host: string;        // e.g. "https://fms.example.com"
  database: string;    // e.g. "MyDatabase"
  username: string;
  password: string;
  version?: string;    // default "v4"
  timeoutMs?: number;  // default 15000
  retryCount?: number; // default 2 (max retries on 429/503)
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
  private timeoutMs: number;
  private retryCount: number;

  constructor(private config: FMConfig) {
    const ver = config.version ?? "v4";
    this.baseUrl = `${config.host}/fmi/odata/${ver}/${encodeURIComponent(config.database)}`;
    this.authHeader = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
    this.timeoutMs = config.timeoutMs ?? 15000;
    this.retryCount = config.retryCount ?? 2;
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

    const maxAttempts = this.retryCount + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let bodyConsumed = false;
      let resRef: Response | undefined;
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        resRef = res;

        // Clear the timeout right after receiving response headers so that
        // reading the body stream (potentially multiple MB) is not aborted
        // mid-read by the AbortController. Otherwise the keep-alive socket
        // stays half-closed in undici's connection pool and subsequent
        // requests (especially PATCH) fail on the FM server with error 8310.
        clearTimeout(timer);

        const raw = await res.text();
        bodyConsumed = true;
        let data: T | undefined;
        try {
          data = raw ? JSON.parse(raw) : undefined;
        } catch {
          // non-JSON response (e.g. empty DELETE responses or XML metadata)
        }

        // Retry on transient failures (429 Rate Limit, 503 Service Unavailable)
        if ((res.status === 429 || res.status === 503) && attempt < maxAttempts) {
          const backoffMs = 1000 * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        if (!res.ok) {
          return { ok: false, status: res.status, error: raw, raw };
        }
        return { ok: true, status: res.status, data, raw };
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return { ok: false, status: 0, error: `Timeout after ${this.timeoutMs}ms — FM server not responding` };
        }
        return {
          ok: false,
          status: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        clearTimeout(timer);
        // Explicitly discard the body stream if it was not read (error path)
        // to avoid dangling sockets in undici's connection pool.
        if (!bodyConsumed && resRef?.body) {
          resRef.body.cancel().catch(() => {});
        }
      }
    }
    return { ok: false, status: 0, error: "Retry loop ended unexpectedly" };
  }

  // --- METADATA ---------------------------------------------------------------

  /** Full OData $metadata document (EDMX/XML) */
  async getMetadata(): Promise<ODataResponse<string>> {
    const url = `${this.baseUrl}/$metadata`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: this.authHeader,
          Accept: "application/xml",
          "OData-Version": "4.0",
        },
        signal: controller.signal,
      });
      const raw = await res.text();
      return { ok: res.ok, status: res.status, data: raw, raw };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return { ok: false, status: 0, error: `Timeout after ${this.timeoutMs}ms — FM server not responding` };
      }
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Service Document — lists all available tables/EntitySets */
  async getServiceDocument(): Promise<ODataResponse<RecordSet>> {
    return this.request<RecordSet>("GET", "");
  }

  // --- DATA READ --------------------------------------------------------------

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
    // Build query string manually — URLSearchParams mis-encodes OData characters
    // (commas as %2C, quotes as %27, parens as %28/%29)
    const parts: string[] = [];
    if (params.filter)             parts.push(`$filter=${params.filter}`);
    if (params.select)             parts.push(`$select=${params.select}`);
    if (params.top !== undefined)  parts.push(`$top=${params.top}`);
    if (params.skip !== undefined) parts.push(`$skip=${params.skip}`);
    if (params.orderby)            parts.push(`$orderby=${params.orderby}`);
    if (params.expand)             parts.push(`$expand=${params.expand}`);
    if (params.count)              parts.push(`$count=true`);
    const query = parts.length ? `?${parts.join("&")}` : "";
    return this.request<RecordSet>("GET", `/${encodeURIComponent(table)}${query}`);
  }

  /** Read a single record by ROWID */
  async getRecord(table: string, rowId: string | number): Promise<ODataResponse<Record<string, unknown>>> {
    return this.request("GET", `/${encodeURIComponent(table)}(${rowId})`);
  }

  // --- DATA WRITE -------------------------------------------------------------

  /** Create a new record */
  async createRecord(
    table: string,
    data: Record<string, unknown>
  ): Promise<ODataResponse<Record<string, unknown>>> {
    return this.request("POST", `/${encodeURIComponent(table)}`, data);
  }

  /** Update a record (PATCH = partial update) */
  async updateRecord(
    table: string,
    rowId: string | number,
    data: Record<string, unknown>
  ): Promise<ODataResponse<void>> {
    return this.request("PATCH", `/${encodeURIComponent(table)}(${rowId})`, data);
  }

  /** Delete a record */
  async deleteRecord(table: string, rowId: string | number): Promise<ODataResponse<void>> {
    return this.request("DELETE", `/${encodeURIComponent(table)}(${rowId})`);
  }

  // --- SCRIPTS ----------------------------------------------------------------

  /**
   * Run a FileMaker script via OData.
   * POST /Script.{scriptName}
   * Body: { scriptParameterValue: "..." } or empty when no parameter is needed.
   *
   * Note: script names with special characters / spaces are URL-encoded.
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

  // --- SCHEMA MODIFY ----------------------------------------------------------

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

  // --- BATCH ------------------------------------------------------------------

  /**
   * Batch request: multiple operations in a single HTTP call.
   * Returns the raw batch response (multipart/mixed).
   *
   * TODO: write operations require changesets per the Claris docs.
   * Currently only GET batch requests are reliably supported.
   */
  async batch(requests: BatchRequest[]): Promise<ODataResponse<string>> {
    const boundary = `batch_${Date.now()}`;
    const base = new URL(this.baseUrl);
    const body = buildBatchBody(requests, boundary, base.pathname, base.host);
    const url = `${this.baseUrl}/$batch`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": `multipart/mixed;boundary=${boundary}`,
          "OData-Version": "4.0",
        },
        body,
        signal: controller.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        return { ok: false, status: res.status, error: raw || `HTTP ${res.status}`, raw };
      }
      return { ok: true, status: res.status, data: raw, raw };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return { ok: false, status: 0, error: `Timeout after ${this.timeoutMs}ms — FM server not responding` };
      }
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- BATCH HELPER -------------------------------------------------------------

export interface BatchRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;  // relative to DB root, e.g. "/Artists"
  body?: unknown;
  id?: string;
}

function buildBatchBody(requests: BatchRequest[], boundary: string, basePath: string, host: string): string {
  const parts = requests.map((r, i) => {
    const id = r.id ?? `req-${i}`;
    const bodyStr = r.body ? JSON.stringify(r.body) : "";
    const hasBody = ["POST", "PATCH", "PUT"].includes(r.method) && bodyStr;
    // Use relative path + Host header per OData v4 batch spec.
    // FMS OData does not reliably accept absolute URLs in inner requests.
    const relPath = r.path.startsWith("/") ? r.path : `/${r.path}`;
    const lines: string[] = [
      `--${boundary}`,
      `Content-Type: application/http`,
      `Content-Transfer-Encoding: binary`,
      `Content-ID: ${id}`,
      "",
      `${r.method} ${basePath}${relPath} HTTP/1.1`,
      `Host: ${host}`,
      `Accept: application/json`,
    ];
    if (hasBody) {
      lines.push(`Content-Type: application/json`);
      lines.push(`Content-Length: ${Buffer.byteLength(bodyStr, "utf-8")}`);
    }
    lines.push("");        // blank line between inner HTTP headers and inner HTTP body
    if (hasBody) {
      lines.push(bodyStr);
    }
    lines.push("");        // CRLF terminator before batch delimiter (RFC 2046)
    return lines.join("\r\n");
  });
  return [...parts, `--${boundary}--`].join("\r\n");
}
