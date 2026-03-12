// src/data-api-client.ts
// HTTP client for FileMaker Data API (REST)
// Supplements the OData client with features only available via Data API:
// - Setting global fields (PATCH /globals)
// - Running scripts with session context

import type { FMConfig } from "./odata-client.js";

export interface DataAPIScriptResult {
  scriptResult?: string;
  scriptError: string;
}

export interface DataAPIResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export class FileMakerDataAPIClient {
  private baseUrl: string;
  private username: string;
  private password: string;

  constructor(config: FMConfig) {
    this.baseUrl = `${config.host}/fmi/data/vLatest/databases/${encodeURIComponent(config.database)}`;
    this.username = config.username;
    this.password = config.password;
  }

  // --- Session management ----------------------------------------------------

  /** Login: POST /sessions → Bearer Token */
  async login(): Promise<DataAPIResponse<string>> {
    const url = `${this.baseUrl}/sessions`;
    const auth = "Basic " + Buffer.from(`${this.username}:${this.password}`).toString("base64");

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      const raw = await res.text();
      if (!res.ok) {
        return { ok: false, status: res.status, error: raw };
      }

      const parsed = JSON.parse(raw);
      const token = parsed?.response?.token;
      if (!token) {
        return { ok: false, status: res.status, error: "No token in response" };
      }

      return { ok: true, status: res.status, data: token };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Logout: DELETE /sessions/{token} */
  async logout(token: string): Promise<DataAPIResponse<void>> {
    const url = `${this.baseUrl}/sessions/${token}`;
    try {
      const res = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- Globals ---------------------------------------------------------------

  /**
   * Set global fields: PATCH /globals
   * Body: { "globalFields": { "Table::Field_g": "value", ... } }
   */
  async setGlobals(
    token: string,
    globals: Record<string, string>
  ): Promise<DataAPIResponse<void>> {
    const url = `${this.baseUrl}/globals`;
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ globalFields: globals }),
      });

      const raw = await res.text();
      if (!res.ok) {
        return { ok: false, status: res.status, error: raw };
      }
      return { ok: true, status: res.status };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- Script execution ------------------------------------------------------

  /**
   * Run a script via Data API (requires a layout name).
   * GET /layouts/{layout}/script/{scriptName}?script.param={param}
   */
  async runScript(
    token: string,
    layout: string,
    scriptName: string,
    scriptParam?: string
  ): Promise<DataAPIResponse<DataAPIScriptResult>> {
    const encodedLayout = encodeURIComponent(layout);
    const encodedScript = encodeURIComponent(scriptName);
    let url = `${this.baseUrl}/layouts/${encodedLayout}/script/${encodedScript}`;
    if (scriptParam !== undefined) {
      url += `?script.param=${encodeURIComponent(scriptParam)}`;
    }

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      const raw = await res.text();
      if (!res.ok) {
        return { ok: false, status: res.status, error: raw };
      }

      const parsed = JSON.parse(raw);
      const scriptError = String(parsed?.response?.scriptError ?? "");
      const scriptResult = parsed?.response?.scriptResult;

      return {
        ok: true,
        status: res.status,
        data: { scriptError, scriptResult },
      };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- Combined operations ---------------------------------------------------

  /**
   * Set globals + run script in a single session.
   * Login → Set Globals → Run Script → Logout
   */
  async runScriptWithGlobals(
    globals: Record<string, string>,
    layout: string,
    scriptName: string,
    scriptParam?: string
  ): Promise<DataAPIResponse<DataAPIScriptResult & { globalsSet: string[] }>> {
    // 1. Login
    const loginRes = await this.login();
    if (!loginRes.ok || !loginRes.data) {
      return { ok: false, status: loginRes.status, error: `Login failed: ${loginRes.error}` };
    }
    const token = loginRes.data;

    try {
      // 2. Set globals
      const globalsRes = await this.setGlobals(token, globals);
      if (!globalsRes.ok) {
        return { ok: false, status: globalsRes.status, error: `Failed to set globals: ${globalsRes.error}` };
      }

      // 3. Run script
      const scriptRes = await this.runScript(token, layout, scriptName, scriptParam);
      if (!scriptRes.ok) {
        return { ok: false, status: scriptRes.status, error: `Script failed: ${scriptRes.error}` };
      }

      return {
        ok: true,
        status: scriptRes.status,
        data: {
          ...scriptRes.data!,
          globalsSet: Object.keys(globals),
        },
      };
    } finally {
      // 4. Logout (always, even on errors)
      await this.logout(token).catch(() => {});
    }
  }
}
