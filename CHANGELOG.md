# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-04-04

### Added

- **`FM_TIMEOUT_MS`** environment variable — configurable HTTP timeout (default `15000` ms).
- **`FM_RETRY_COUNT`** environment variable — automatic retries with exponential backoff for transient HTTP 429/503 responses (default `2`, set `0` to disable).
- **`FM_DEBUG`** environment variable — full tool-argument logging to stderr for troubleshooting.
- Startup health check against the FileMaker service document — the server fails fast on misconfiguration.
- Graceful shutdown on `SIGINT`/`SIGTERM`.

### Changed

- **Self-signed certificates are no longer supported.** The `FM_ALLOW_SELF_SIGNED` variable has been removed. Use a valid certificate (Let's Encrypt, commercial CA, or an internal CA trusted by Node.js).
- Tool restrictions via `FM_DISABLED_TOOLS` now apply at both tool-list advertisement **and** execution time (double protection).
- Stricter input validation on all tool arguments via Zod (URL/host format, safe identifiers for table names and field names).

### Fixed

- **Connection-pool corruption** — on large response bodies, the `AbortController` timeout could fire mid-stream, leaving half-closed keep-alive sockets in undici's pool and causing subsequent PATCH requests to fail with FileMaker error 8310. The timeout is now cleared before reading the body, and non-consumed body streams are explicitly cancelled in the request lifecycle.
- **`fm_batch` — empty error messages.** The batch method now propagates FileMaker error bodies on non-2xx responses instead of swallowing them into an empty string.
- **`fm_batch` — absolute URLs in inner requests.** Batch inner-request lines are now relative paths with an explicit `Host:` header and correct CRLF terminators before each boundary, matching the OData v4 / RFC 2046 expectation.
- **Tool handlers — string-encoded object/array arguments.** Some MCP clients serialize object- and array-typed tool arguments as JSON strings. Handlers for `fm_create_record`, `fm_update_record`, `fm_create_test_record`, `fm_assert_record`, `fm_set_globals`, `fm_run_script_with_globals`, and `fm_batch` now accept both shapes transparently.
- **Invalid numeric environment variables.** `FM_TIMEOUT_MS` and `FM_RETRY_COUNT` now fall back to the default and log a warning when not a valid integer, instead of silently disabling the feature.
- Server reports its own version as `1.1.0` instead of the stale `1.0.0` string.

### Known Limitations

- The Data API client (`fm_set_globals`, `fm_run_script_with_globals`) does **not** retry on 429/503 — only the OData client does. Transient failures during login or globals-update surface immediately.
- Startup logs contain the configured username (no password or API keys). Redirect stderr if the username is considered sensitive.

## [1.0.1] - 2026-03-14

### Fixed

- `fm_create_record` ignored the `fields` object on POST — records were created with all fields empty. Root cause: MCP SDK args are not plain objects, so `JSON.stringify` failed to serialize them. Fixed by spreading into a new plain object, matching the pattern already used by `fm_create_test_record`.

## [1.0.0] - 2026-03-12

### Added

- Initial release with OData v4 support for FileMaker databases
- **Query tools:** `fm_query`, `fm_get_record`, `fm_get_metadata`, `fm_get_service_document`, `fm_introspect`
- **Write tools:** `fm_create_record`, `fm_update_record`, `fm_delete_record`
- **Script tools:** `fm_run_script`, `fm_run_script_and_assert`, `fm_run_script_with_globals`, `fm_set_globals`
- **Schema tools:** `fm_create_table`, `fm_add_field`
- **Batch tool:** `fm_batch` for executing multiple operations in sequence
- **Test helpers:** `fm_create_test_record`, `fm_cleanup_test_data`, `fm_assert_record`, `fm_assert_count`
- Multi-database support via `FM_DATABASES` environment variable
- Tool-level security via `FM_DISABLED_TOOLS` environment variable
- Works on-premise with Basic Auth — no cloud dependency
