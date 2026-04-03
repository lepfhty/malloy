# ClickHouse Dialect

ClickHouse dialect for Malloy. Targets ClickHouse 25.3+.

Test status: 646 / 737 passing (88%), 47 skipped, 43 failing. 11 of 18 test suites fully green.

## Connection Settings

All SQL compatibility settings are applied per-connection via the `@clickhouse/client` constructor (`clickhouse_connection.ts`), not per-query. Users with `readonly=1` cannot change settings; `readonly=2` is required.

### Enabled settings

| Setting | Why |
|---|---|
| `join_use_nulls=1` | LEFT/RIGHT JOINs fill with NULL instead of type defaults (standard SQL). |
| `group_by_use_nulls=1` | GROUPING SETS fill missing keys with NULL instead of type defaults. `LowCardinality` columns have a [known bug](https://github.com/ClickHouse/ClickHouse/issues/95299) — use CAST to remove the wrapper as a workaround. |
| `cast_keep_nullable=1` | CAST preserves the Nullable wrapper instead of stripping it. |
| `output_format_json_named_tuples_as_objects=1` | Named tuples serialize as `{"field": value}` in JSONEachRow, which Malloy needs for nested query results. |

### Settings we evaluated but do NOT enable

| Setting | Why not |
|---|---|
| `prefer_column_name_to_alias` | Breaks CAST+`groupArrayIf` on ClickHouse 25+ — named tuples come back as all nulls. |
| `enable_named_columns_in_function_tuple` | Available 24.7+. Creates named tuples via `tuple(expr AS name)` without CAST. Two problems: (1) the `AS` names leak as column aliases causing collisions, (2) even with bare-paren CAST `(expr1, expr2)` instead of `tuple(expr1, expr2)`, the setting breaks `groupArrayIf` inside CTEs — tuples come back as all nulls. This is a ClickHouse bug. |
| `aggregate_functions_null_for_empty` | Rewrites ALL aggregates to add `-OrNull` suffix. Causes `groupArrayIf` → `groupArrayIfOrNull`, returning NULL instead of `[]`, breaking nesting. -54 tests. |

### Other relevant settings (not currently set)

| Setting | Default | What it does |
|---|---|---|
| `join_default_strictness` | `ALL` | Already defaults to standard SQL behavior (Cartesian product of matching rows). |
| `external_table_functions_use_nulls` | `1` | Already defaults to standard behavior (Nullable columns). |

## Nesting

Malloy's nested queries produce arrays of structs. ClickHouse represents these as `Array(Tuple(...))`.

### Tuple creation

Named tuples are built with `CAST((expr1, expr2) AS Tuple(name1 Type1, name2 Type2))`. Uses **bare parentheses** (not the `tuple()` function) because `enable_named_columns_in_function_tuple` changes `tuple()` behavior and breaks `groupArrayIf`. Bare parens are unaffected.

Field names go in the Tuple *type metadata* rather than creating column aliases. The inline syntax `tuple(expr AS name)` was rejected because AS names leak into the enclosing SELECT scope and collide with other columns.

### Nullable wrapping

ClickHouse does not allow `Nullable(Tuple(...))` or `Nullable(Array(...))` — only scalar types can be Nullable. In the CAST type spec, scalar fields are wrapped in `Nullable()` but complex fields (Array, Tuple) are not. The `nullableSQLType()` helper handles this recursively.

This also means `CASE WHEN ... THEN tuple_expr END` is illegal (it produces `Nullable(Tuple(...))`). We use `anyIf(tuple_expr, condition)` and `groupArrayIf(tuple_expr, condition)` instead. The same applies to `sqlAnyValue` — it uses `anyIf(field, group_set=N)` to avoid `Nullable(Array/Tuple)` type mismatches.

**Compiler limitation**: Malloy's compiler generates `CASE WHEN group_set=N THEN field END` in stage expressions (outside the dialect's control). When `field` is an Array or Tuple, ClickHouse rejects the `Nullable(Array/Tuple)` result type. This causes ~6 test failures in compound-atomic tests.

### Aggregation

- **Array**: `groupArrayIf(CAST((...) AS Tuple(...)), group_set=N)`
- **Single value**: `anyIf(CAST((...) AS Tuple(...)), group_set=N)`
- **Coalesce measures**: `anyIf(...)` — no COALESCE wrapper needed

### Ordering within nested results

ClickHouse's `arraySort` uses a key-extraction lambda with **positional** tuple access:

```sql
arraySort(x -> (x.1, x.2), arr)           -- ASC by fields 1 and 2
arrayReverseSort(x -> (x.1, x.2), arr)    -- DESC by fields 1 and 2
arraySort(x -> (x.1, negate(x.2)), arr)   -- ASC by field 1, DESC by numeric field 2
```

Limitations:
- Named field access (`.fieldname`) does NOT work inside lambdas — must use positional `.1`, `.2`, etc.
- Two-argument comparator lambdas `(l, r) -> ...` are NOT supported (unlike Spark/Databricks ARRAY_SORT)
- `arraySort` is NOT stable, so chaining sorts for mixed ASC/DESC doesn't work
- DESC on string fields has no clean solution (negate only works on numbers)

## Record Literals

`sqlLiteralRecord` produces named tuples via `CAST((val1, val2) AS Tuple(name1 Type1, name2 Type2))`. This ensures record literals serialize as JSON objects (not positional arrays) and support property access.

## Unnesting

Uses `LEFT ARRAY JOIN` (not `ARRAY JOIN`) so rows with empty arrays are preserved (left join semantics). `ARRAY JOIN` drops rows with empty arrays.

For scalar arrays, `LEFT ARRAY JOIN arr AS alias` makes `alias` the element directly — there is no `.value` sub-property. `sqlFieldReference` returns just `parentAlias` for `array[scalar]` parent type. `__row_id` is handled via `arrayEnumerate(source)` aliased to `__row_id_from_{alias}`.

## Arithmetic

- Integer division returns `Float64` (not integer). `divisionIsInteger = false`.
- Explicit integer division uses `intDiv()` via the `div` function override.
- `sumDistinct` uses `cityHash64` and `toDecimal128` for the hash-based symmetric aggregate trick. The scale factor is 100000000. Known issue: `toDecimal128(..., 0)` truncates fractional values — needs a non-zero scale parameter.

## Window Functions

ClickHouse lacks standard `LAG`/`LEAD`. We use `lagInFrame`/`leadInFrame` with three adjustments:

1. **Frame**: `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` — without this, the default frame is too narrow and the function silently returns the type default instead of looking at all rows.
2. **Nullable input**: `lagInFrame(toNullable(value))` — without `toNullable()`, out-of-range positions return the type default (0, empty string) instead of NULL.
3. **`needsWindowOrderBy: true`**: Must be explicitly set in the override because the `impl` replacement drops the base definition's `needsWindowOrderBy`. Without this, no ORDER BY is generated and lag/lead operate over arbitrary row order.

Override template: `lagInFrame(toNullable(${value}))` with `needsWindowOrderBy: true` and `between: {preceding: -1, following: -1}` (in Malloy's function system, -1 means UNBOUNDED).

## Type System

### Scalar type mapping

ClickHouse has a rich integer type hierarchy (Int8–Int256, UInt8–UInt256). All map to Malloy `number(integer)` or `number(bigint)`. Float32/Float64 and Decimal variants map to `number(float)`.

### Boolean

ClickHouse comparisons (`=`, `<`, etc.) return `UInt8` (0/1), not `Bool`. `booleanType` is set to `'number'` so `resultBoolean` returns 0/1 to match.

### Complex type mapping

`malloyTypeToSQLType` handles recursive types:
- `record` → `Tuple(field1 Type1, field2 Type2, ...)`
- `array` of records → `Array(Tuple(...))`
- `array` of scalars → `Array(Type)`

`supportsArraysInData = true` — ClickHouse natively supports arrays and tuples as column types.

### AggregateFunction columns

`DESCRIBE TABLE` returns `AggregateFunction(func, Type)` for AggregatingMergeTree columns. These are stored as `{type: 'sql native', rawType: 'AggregateFunction(sum, Float64)'}`. Future work: SQL generation should automatically use `-Merge` combinators (e.g., `sumMerge(col)` instead of `sum(col)`).

### Count distinct

ClickHouse offers `uniq`, `uniqCombined`, `uniqMerge`, `uniqCombinedMerge` — future work could map Malloy's count distinct to these based on data type and user preference.

## Time Functions

- **Day of week**: `toDayOfWeek(expr, 3)` — mode 3 gives Sunday=1, Saturday=7, matching Malloy's convention. Default is ISO 8601 (Monday=1).
- **Week extraction**: `toWeek(expr)` — `EXTRACT(WEEK FROM ...)` is not supported in ClickHouse.
- **Week truncation**: `toStartOfWeek(expr, 0)` — mode 0 for Sunday-based weeks.
- **Timezone-aware truncation**: `dateTrunc('unit', expr, 'timezone')` when a timezone is specified. `toStartOfDay` and other `toStartOf*` functions don't accept a timezone argument. Results are cast to `DateTime64(3, tz)` because `dateTrunc` returns `Date` for day/week/month/quarter/year units, and `Date` can't be passed to `toTimeZone`.

## Function Overrides

| Function | ClickHouse implementation | Notes |
|---|---|---|
| `lag`/`lead` | `lagInFrame(toNullable(value))` / `leadInFrame(toNullable(value))` | With UNBOUNDED frame and `needsWindowOrderBy` |
| `div` | `intDiv(a, b)` | |
| `strpos` | `positionUTF8(str, substr)` | |
| `log` | `log(value) / log(base)` | Change of base |
| `replace` (regex) | `replaceRegexpAll(value, pattern, replacement)` | |
| `regexp_extract` | `extractAll(value, pattern)[1]` | |
| `starts_with` | `COALESCE(startsWith(value, prefix), 0)` | Returns 0 for NULL inputs |
| `ends_with` | `COALESCE(endsWith(value, suffix), 0)` | Returns 0 for NULL inputs |
| `greatest`/`least` | `CASE WHEN countEqual([values], NULL) > 0 THEN NULL ELSE greatest(values) END` | ClickHouse skips NULLs; Malloy expects NULL propagation |
| `is_inf`/`is_nan` | `if(value IS NULL, 0, isInfinite(value))` | Returns 0 (not NULL) for NULL input |
| `stddev` | `stddevSamp` | |
| `string_agg` | `arrayStringConcat(arraySort(groupArray(value)), sep)` | Sorts ascending by value. External ORDER BY, DESC, and companion-array sorting not yet supported. |

## Identifiers

Backtick-quoted: `` `identifier` ``. ClickHouse is **case-sensitive** — `GROUP_SET` ≠ `group_set`. (A bug in Malloy's `query_query.ts` used uppercase `GROUP_SET` in two places; fixed.)

## Test Data

Test tables use `MergeTree()` with proper `ORDER BY` clauses (not `tuple()`). Tables `airports` and `flights` include `SAMPLE BY cityHash64(key)` to support percentage-based sampling. See `test/clickhouse/clickhouse_start.sh`.

## Version-Dependent Features

The dialect currently targets ClickHouse 25.3+. Some features are available in newer versions:

| Feature | Min Version | Use |
|---|---|---|
| `enable_named_columns_in_function_tuple` | 24.7 | Named tuple syntax `tuple(val AS name)`. Currently unusable due to a bug that breaks `groupArrayIf` in CTEs. |
| `system.unicode` table | 25.12 | Could implement `unicode()` function override via `SELECT code_point_value FROM system.unicode WHERE char = substring(value, 1, 1)`. |

The dialect class doesn't currently have access to the server version at SQL generation time. The `QueryInfo` interface has a comment anticipating this (`"e.g. version number of db"`), but it's not wired up. To support version-dependent behavior:
1. Query `SELECT version()` at connection init
2. Store on the connection
3. Pass through to dialect via `QueryInfo` or dialect constructor

For now, target a minimum version and document version-dependent features here.

## Remaining Test Failures (43)

| Category | Count | Root cause | Status |
|---|---|---|---|
| Timezone semantics | ~11 | Timezone offset calculations, literal timezone handling, `Date` vs `DateTime64` type mismatches in truncation. | Partially fixable |
| JOIN ON restrictions | ~8 | ClickHouse requires at least one equality predicate in JOIN ON. Joins with `ON 1=1`, cross joins, or complex expressions fail. Includes composite_sources and cross join tests. | ClickHouse limitation |
| string_agg ordering/fanout | ~7 | `groupArray` has no ORDER BY. DESC needs `arrayReverseSort` but template is static. Expression-based ordering needs companion-array `arraySort((x,y)->y, vals, keys)` but requires expression compiler to expose order-by parts separately. | Needs expression compiler changes |
| `sqlAggDistinct` not implemented | ~6 | Generalized distinct aggregate (fanout). DuckDB uses correlated subquery with UNNEST — ClickHouse can't handle correlated subqueries. Inline `arrayReduce`+`arrayMap` fails because `func` callback generates standard aggregate calls that can't accept array arguments, and `groupArray` can't nest inside another aggregate. | Blocked: needs new approach |
| Compiler CASE WHEN with complex types | ~5 | Malloy compiler generates `CASE WHEN group_set=N THEN array_col END` which produces `Nullable(Array)` — illegal in ClickHouse. Outside dialect control. | Needs compiler change |
| Minor function differences | ~4 | `concat`: DateTime64(3) renders `.000` milliseconds. `chr`/`unicode`: no codepoint function (25.12 adds `system.unicode`). `rand()`: deterministic per-row, so `rand()=rand()` is always true. | Version-dependent / ClickHouse behavior |
| Misc record/array edge cases | ~3 | Special chars in field names, nested property access through joins. | Case-by-case |

### Resolved
- **CAST NULL to compound types**: `sqlCast` returns `CAST([] AS ...)` for NULL-to-Array casts. NULL-to-Tuple casts are skipped (ClickHouse can't produce null records — `tuple()` has wrong element count). Tests use `emptyOn` / `skip` for ClickHouse.
- **`x.*` in distinct_key subquery**: ClickHouse can't resolve alias-qualified `x.*` columns inside aggregates in the outer query. Changed to unqualified `*` in `query_query.ts`. Verified no regression on DuckDB (717/737, 18/18 suites).
- **Double nesting**: Fixed by setting `hasLateralColumnAliasInSelect = true` — compiler now uses `__remapped_group_set` to avoid shadowing the `group_set` column that `groupArrayIf` filters on.
- **Symmetric aggregate precision**: `toDecimal128(..., 8)` preserves fractional values (was `0`, truncating decimals).
