# ClickHouse Dialect

ClickHouse dialect for Malloy. Targets ClickHouse 25.3+.

Test status: 654 / 737 passing (89%), 47 skipped, 35 failing. 12 of 18 test suites fully green.

## Connection Settings

Settings are applied per-connection via the `@clickhouse/client` constructor in `clickhouse_connection.ts`. ClickHouse users with `readonly=1` cannot change settings; `readonly=2` is required.

### Enabled

| Setting | Why |
|---|---|
| `join_use_nulls=1` | Without this, LEFT/RIGHT JOINs fill non-matching cells with type defaults (0, empty string) instead of NULL. |
| `group_by_use_nulls=1` | Without this, ROLLUP/CUBE/GROUPING SETS fill missing keys with type defaults instead of NULL. Note: `LowCardinality` columns have a [known ClickHouse bug](https://github.com/ClickHouse/ClickHouse/issues/95299) where NULL is not produced even with this setting. |
| `cast_keep_nullable=1` | Without this, CAST strips the Nullable wrapper from its argument. |
| `output_format_json_named_tuples_as_objects=1` | Without this, named tuples serialize as positional arrays (`[1, "a"]`) instead of objects (`{"id": 1, "name": "a"}`) in JSONEachRow format. Malloy needs objects for nested query results. |
| `date_time_output_format='iso'` | Without this, datetimes output as `2020-02-20 00:00:00.000` (civil time, no timezone indicator). The JS client parses this as UTC, producing wrong values for timezone-aware queries. With `'iso'`, output is `2020-02-20T06:00:00.000Z` (always UTC). |

### Evaluated but NOT enabled

| Setting | Why not |
|---|---|
| `prefer_column_name_to_alias` | On ClickHouse 25+, this causes `groupArrayIf` with CAST named tuples to return all-null values inside CTEs. |
| `enable_named_columns_in_function_tuple` | Available in 24.7+. Allows `tuple(expr AS name)` syntax without CAST. However: (1) the AS names become column aliases in the enclosing SELECT, causing collisions when field names like `airport_count` appear in both the outer query and the tuple; (2) the setting also breaks CAST-based `groupArrayIf` inside CTEs even when using bare parentheses instead of `tuple()`. This appears to be a ClickHouse bug. |
| `aggregate_functions_null_for_empty` | Rewrites all aggregate functions by appending `-OrNull`, so `groupArrayIf` becomes `groupArrayIfOrNull` and returns NULL instead of `[]` for empty results. This breaks nesting. |

### Not set (defaults are fine)

| Setting | Default | Notes |
|---|---|---|
| `join_default_strictness` | `ALL` | Standard SQL behavior (all matching row combinations). |
| `external_table_functions_use_nulls` | `1` | Standard behavior (Nullable columns from external table functions). |

## Nesting

Malloy nested queries produce arrays of structs. In ClickHouse these are `Array(Tuple(...))`.

### How tuples are created

Named tuples use `CAST((expr1, expr2) AS Tuple(name1 Type1, name2 Type2))`. The field names are part of the Tuple type metadata, not column aliases.

**Why bare parentheses**: The CAST uses `(expr1, expr2)` rather than `tuple(expr1, expr2)`. The `tuple()` function changes behavior when `enable_named_columns_in_function_tuple` is enabled (even though we don't enable it — a connected client might). Bare parentheses are immune to this setting.

**Why not inline AS syntax**: `tuple(expr AS name)` leaks the AS names as column aliases into the enclosing SELECT statement. When Malloy generates queries with group sets, the same logical field name (e.g., `airport_count`) appears in multiple places, causing alias collisions.

**Single-element tuples**: `CAST((expr) AS Tuple(name Type))` doesn't work because `(expr)` is just a parenthesized expression, not a one-element tuple. Single-element tuples use `CAST(tuple(expr) AS Tuple(name Type))` instead.

### Nullable restrictions

ClickHouse does not allow `Nullable(Tuple(...))` or `Nullable(Array(...))`. Only scalar types can be Nullable. This affects nesting in two ways:

1. **In the CAST type spec**: Scalar fields are wrapped in `Nullable()`, but Array and Tuple fields are left unwrapped. The `nullableSQLType()` helper method handles this recursively.

2. **Conditional expressions**: `CASE WHEN condition THEN tuple_value END` produces `Nullable(Tuple(...))`, which ClickHouse rejects. The dialect uses `anyIf(tuple_value, condition)` and `groupArrayIf(tuple_value, condition)` instead.

**Compiler limitation**: Malloy's query compiler generates `CASE WHEN group_set=N THEN field END` in certain stage expressions. When the field is an Array or Tuple type, ClickHouse rejects the resulting `Nullable(Array/Tuple)`. This is outside the dialect's control and causes ~5 test failures.

### Aggregation patterns

| Use case | SQL pattern |
|---|---|
| Collect into array | `groupArrayIf(CAST((...) AS Tuple(...)), group_set=N)` |
| Pick single value | `anyIf(CAST((...) AS Tuple(...)), group_set=N)` |
| Coalesce measures | `anyIf(...)` (no COALESCE wrapper needed) |
| Any-value for scalars | `anyIf(field, group_set=N)` (not `any(CASE WHEN ...)` to avoid Nullable issues with complex types) |

### Ordering within nested results

ClickHouse's `arraySort` takes a key-extraction lambda with **positional** tuple access (`.1`, `.2`, etc.):

```sql
arraySort(x -> (x.1, x.2), arr)           -- ASC by fields 1 and 2
arrayReverseSort(x -> (x.1, x.2), arr)    -- DESC by fields 1 and 2
arraySort(x -> (x.1, negate(x.2)), arr)   -- ASC by field 1, DESC by numeric field 2
```

Limitations:
- Named field access (`.fieldname`) does not work inside lambdas
- Two-argument comparator lambdas `(l, r) -> expr` are not supported (unlike Spark/Databricks `ARRAY_SORT`)
- `arraySort` is not stable, so chaining multiple sorts for mixed ASC/DESC does not work
- DESC on string fields has no clean solution (`negate()` only works on numbers)

### Group-set remapping

ClickHouse supports lateral column aliases in SELECT (`SELECT 1 AS a, a + 1 AS b`). The dialect sets `hasLateralColumnAliasInSelect = true`, which tells the Malloy compiler to rename remapped group-set columns to `__remapped_group_set` instead of `group_set`. Without this, the remapped value shadows the original `group_set` column, and `groupArrayIf(..., group_set=N)` filters never match.

## Record Literals

`sqlLiteralRecord` produces `CAST((val1, val2) AS Tuple(name1 Type1, name2 Type2))`. This ensures record literals serialize as JSON objects and support named property access (e.g., `record.field`).

## Unnesting

Uses `LEFT ARRAY JOIN` (not `ARRAY JOIN`) to preserve rows where the array is empty (left join semantics). Plain `ARRAY JOIN` drops such rows.

For scalar arrays, `LEFT ARRAY JOIN arr AS alias` makes `alias` the element value directly. There is no `.value` sub-property — `sqlFieldReference` returns just `parentAlias` when `parentType` is `array[scalar]`.

Row IDs for distinct keys use `arrayEnumerate(source)`, aliased to `__row_id_from_{alias}`.

## Arithmetic

- Integer division returns `Float64`, not an integer. The dialect sets `divisionIsInteger = false`.
- For explicit integer division, the `div` function override uses `intDiv()`.
- Symmetric aggregates (`sumDistinct`) use `cityHash64` hashing with `toDecimal128` arithmetic. The scale factor is 100000000, and `toDecimal128(..., 8)` preserves 8 decimal places of precision.

## Window Functions

ClickHouse does not have standard SQL `LAG`/`LEAD` functions. The dialect uses `lagInFrame`/`leadInFrame` with three adjustments:

1. **Frame specification**: `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`. Without this, the default frame only includes rows up to the current row, and the function returns the column's type default (0 for numbers, empty string for strings) instead of looking ahead/behind.

2. **Nullable wrapping**: `lagInFrame(toNullable(value))`. Without `toNullable()`, positions beyond the frame boundary return the type default instead of NULL.

3. **Window ordering**: The override must include `needsWindowOrderBy: true`. When overriding a function's `impl`, all properties from the base definition are replaced — including `needsWindowOrderBy`. Without it, no ORDER BY is generated and the window function operates over arbitrary row order.

## Type System

### Scalar types

ClickHouse's integer hierarchy (Int8–Int256, UInt8–UInt256) maps to Malloy `number(integer)` or `number(bigint)`. Float32, Float64, and all Decimal variants map to `number(float)`.

### Boolean

ClickHouse has a native `Bool` type, but comparison operators (`=`, `<`, etc.) return `UInt8` (0/1). The dialect sets `booleanType = 'simulated'`, meaning Malloy treats booleans as 0/1 integers and `resultBoolean()` returns numeric values.

### Complex types

`malloyTypeToSQLType` recursively maps Malloy types to ClickHouse types:
- `record` → `Tuple(field1 Type1, field2 Type2, ...)`
- `array` of records → `Array(Tuple(...))`
- `array` of scalars → `Array(Type)`

`supportsArraysInData = true` — ClickHouse natively supports Array and Tuple column types.

### NULL casts to compound types

ClickHouse cannot `CAST(NULL AS Array(...))` or `CAST(NULL AS Tuple(...))`. For NULL-to-Array casts, `sqlCast` returns `CAST([] AS ...)` (empty array) instead. NULL-to-Tuple casts cannot be represented — the relevant tests are skipped.

### AggregateFunction columns

For tables using the AggregatingMergeTree engine, `DESCRIBE TABLE` returns column types like `AggregateFunction(sum, Float64)`. The connection stores these as `{type: 'sql native', rawType: 'AggregateFunction(sum, Float64)'}`. Future work: SQL generation should use `-Merge` combinators automatically (e.g., `sumMerge(col)` instead of `sum(col)`).

### Count distinct

ClickHouse offers `uniq`, `uniqCombined`, `uniqMerge`, and `uniqCombinedMerge` as alternatives to `COUNT(DISTINCT ...)`. Future work could map Malloy's count distinct to these based on data type or user preference.

## Time Functions

- **Day of week**: `toDayOfWeek(expr, 3)` — mode 3 produces Sunday=1 through Saturday=7, matching Malloy's convention. The default mode uses ISO 8601 (Monday=1).
- **Week extraction**: `toWeek(expr)` — ClickHouse does not support `EXTRACT(WEEK FROM ...)`.
- **Week truncation**: `toStartOfWeek(expr, 0)` — mode 0 starts weeks on Sunday.
- **Timezone-aware truncation**: Uses `dateTrunc('unit', expr, 'timezone')` when a query timezone is set. The `toStartOf*` family of functions does not accept a timezone argument. For week truncation with timezone, the expression is converted first: `toStartOfWeek(toTimeZone(expr, tz), 0)`. Results from `dateTrunc` are cast to `DateTime64(3, tz)` because `dateTrunc` returns `Date` for day/week/month/quarter/year units, and `Date` cannot be passed to `toTimeZone`.
- **Timestamp literals with timezone**: `toDateTime64('2020-02-20 00:00:00', 3, 'America/Mexico_City')` — the third argument tells ClickHouse to parse the string as local time in that timezone. This is distinct from `toTimeZone(toDateTime64('...', 3), 'tz')`, which reinterprets an existing UTC value in a different timezone.

## Function Overrides

| Function | ClickHouse SQL | Notes |
|---|---|---|
| `lag`/`lead` | `lagInFrame(toNullable(value))` / `leadInFrame(toNullable(value))` | With UNBOUNDED frame and `needsWindowOrderBy` |
| `div` | `intDiv(a, b)` | |
| `strpos` | `positionUTF8(str, substr)` | |
| `log` | `log(value) / log(base)` | ClickHouse `log()` is natural log only; change-of-base formula |
| `replace` (regex) | `replaceRegexpAll(value, pattern, replacement)` | |
| `regexp_extract` | `extractAll(value, pattern)[1]` | Returns first match |
| `starts_with` | `COALESCE(startsWith(value, prefix), 0)` | COALESCE needed because `startsWith(NULL, ...)` returns NULL; Malloy expects false (0) |
| `ends_with` | `COALESCE(endsWith(value, suffix), 0)` | Same NULL handling as `starts_with` |
| `greatest`/`least` | `CASE WHEN countEqual([values], NULL) > 0 THEN NULL ELSE greatest(values) END` | ClickHouse `greatest()` skips NULLs; Malloy expects SQL-standard NULL propagation |
| `is_inf`/`is_nan` | `if(value IS NULL, 0, isInfinite(value))` | Returns 0 for NULL input; Malloy expects false, not NULL |
| `stddev` | `stddevSamp` | |
| `string_agg` | `arrayStringConcat(arraySort(groupArray(value)), sep)` | Collects values, sorts ascending, joins. Does not support ORDER BY on a different expression, DESC ordering, or companion-array sorting. |

## Identifiers

Backtick-quoted: `` `identifier` ``. ClickHouse is case-sensitive for identifiers — `GROUP_SET` and `group_set` are different names.

## Test Data

Test tables are created by `test/clickhouse/clickhouse_start.sh` using `MergeTree()` with per-table `ORDER BY` clauses. The `airports` and `flights` tables include `SAMPLE BY cityHash64(key)` to support ClickHouse's percentage-based sampling (`SAMPLE 0.1`). Tables without a suitable key (e.g., `alltypes`) use `ORDER BY tuple()`.

## Version-Dependent Features

The dialect targets ClickHouse 25.3+. Some features require newer versions:

| Feature | Min Version | Potential Use |
|---|---|---|
| `enable_named_columns_in_function_tuple` | 24.7 | Would simplify named tuple creation, but currently broken with `groupArrayIf` in CTEs. |
| `system.unicode` table | 25.12 | Could implement the `unicode()` function override to return Unicode codepoints. Currently no clean way to extract codepoints from multi-byte UTF-8 characters. |

The dialect does not currently have access to the server version at SQL generation time. The `QueryInfo` interface anticipates this (comment: "e.g. version number of db"), but the plumbing is not yet built. To support version-dependent SQL generation:
1. Query `SELECT version()` at connection init
2. Store on the connection
3. Pass to the dialect via `QueryInfo` or constructor

## Remaining Test Failures (35)

| Category | Count | Root cause | Status |
|---|---|---|---|
| JOIN ON restrictions | ~8 | ClickHouse requires at least one equality predicate in JOIN ON. Expressions like `ON 1=1` or `ON true` fail with "Cannot determine join keys." | ClickHouse limitation |
| string_agg ordering | ~7 | ClickHouse's `groupArray` does not support ORDER BY inside the function. Sorting by value ascending works via `arraySort(groupArray(...))`, but sorting by a different expression or in DESC order is not supported. Companion-array sorting (`arraySort((x,y)->y, vals, keys)`) is possible but requires the Malloy expression compiler to expose order-by expressions separately from the `ORDER BY` keyword. | Needs expression compiler changes |
| `sqlAggDistinct` | ~6 | Generalized distinct aggregates used for fanout queries. DuckDB implements this with a correlated subquery, but ClickHouse does not support correlated subqueries. An inline approach using `arrayReduce`+`arrayMap` does not work because the callback generates standard aggregate function calls that cannot accept array arguments. | Blocked: needs new approach |
| Compiler CASE WHEN + complex types | ~5 | The Malloy compiler generates `CASE WHEN group_set=N THEN field END` in stage expressions. When the field is an Array or Tuple, this produces `Nullable(Array(...))` which ClickHouse rejects. This code path is in the compiler, not the dialect. | Needs compiler change |
| Timezone edge cases | ~3 | Remaining timezone tests involve the compiler wrapping timezone-aware nested queries with `CASE WHEN`, hitting the same Nullable(Array) issue. | Same as above |
| Minor function differences | ~4 | `concat`: ClickHouse DateTime64(3) always renders with `.000` milliseconds when cast to string. `chr`/`unicode`: no function to convert between Unicode codepoints and characters (available in 25.12 via `system.unicode`). `rand()`: deterministic within a single query row, so `rand()=rand()` is always true. | ClickHouse behavior |
| Misc | ~2 | Edge cases with special characters in field names, single-field computed records cast as Tuple. | Case-by-case |
