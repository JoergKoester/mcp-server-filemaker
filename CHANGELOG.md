# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
