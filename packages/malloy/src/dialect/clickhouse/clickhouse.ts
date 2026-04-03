/*
 * Copyright Contributors to the Malloy project
 * SPDX-License-Identifier: MIT
 */

import type {
  Sampling,
  MeasureTimeExpr,
  RegexMatchExpr,
  TimeExtractExpr,
  TypecastExpr,
  BasicAtomicTypeDef,
  AtomicTypeDef,
  ArrayLiteralNode,
  RecordLiteralNode,
} from '../../model/malloy_types';
import {
  isAtomic,
  isRepeatedRecord,
  isSamplingEnable,
  isSamplingRows,
  isSamplingPercent,
  safeRecordGet,
  TD,
} from '../../model/malloy_types';
import {indent} from '../../model/utils';
import type {
  BooleanTypeSupport,
  CompiledOrderBy,
  DialectFieldList,
  FieldReferenceType,
  OrderByClauseType,
  QueryInfo,
} from '../dialect';
import {Dialect, qtz} from '../dialect';
import type {DialectFunctionOverloadDef} from '../functions';
import {expandBlueprintMap, expandOverrideMap} from '../functions';
import {CLICKHOUSE_DIALECT_FUNCTIONS} from './dialect_functions';
import {CLICKHOUSE_MALLOY_STANDARD_OVERLOADS} from './function_overrides';

const extractionMap: Record<string, string> = {
  day_of_year: 'toDayOfYear',
};

const inSeconds: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 24 * 3600,
  week: 7 * 24 * 3600,
};

const clickhouseToMalloyTypes: {[key: string]: BasicAtomicTypeDef} = {
  'bool': {type: 'boolean'},
  'boolean': {type: 'boolean'},
  'int8': {type: 'number', numberType: 'integer'},
  'int16': {type: 'number', numberType: 'integer'},
  'int32': {type: 'number', numberType: 'integer'},
  'int64': {type: 'number', numberType: 'bigint'},
  'int128': {type: 'number', numberType: 'bigint'},
  'int256': {type: 'number', numberType: 'bigint'},
  'uint8': {type: 'number', numberType: 'integer'},
  'uint16': {type: 'number', numberType: 'integer'},
  'uint32': {type: 'number', numberType: 'integer'},
  'uint64': {type: 'number', numberType: 'bigint'},
  'uint128': {type: 'number', numberType: 'bigint'},
  'uint256': {type: 'number', numberType: 'bigint'},
  'float32': {type: 'number', numberType: 'float'},
  'float64': {type: 'number', numberType: 'float'},
  'decimal': {type: 'number', numberType: 'float'},
  'decimal32': {type: 'number', numberType: 'float'},
  'decimal64': {type: 'number', numberType: 'float'},
  'decimal128': {type: 'number', numberType: 'float'},
  'decimal256': {type: 'number', numberType: 'float'},
  'string': {type: 'string'},
  'fixedstring': {type: 'string'},
  'uuid': {type: 'string'},
  'enum8': {type: 'string'},
  'enum16': {type: 'string'},
  'date': {type: 'date'},
  'date32': {type: 'date'},
  'datetime': {type: 'timestamp'},
  'datetime64': {type: 'timestamp'},
};

export class ClickHouseDialect extends Dialect {
  name = 'clickhouse';
  defaultNumberType = 'Float64';
  defaultDecimalType = 'Decimal';
  udfPrefix = '__udf';
  hasFinalStage = false;
  stringTypeName = 'String';
  divisionIsInteger = false;
  supportsSumDistinctFunction = true;
  unnestWithNumbers = false;
  defaultSampling = {rows: 50000};
  supportUnnestArrayAgg = true;
  supportsAggDistinct = false;
  supportsCTEinCoorelatedSubQueries = true;
  supportsSafeCast = false;
  dontUnionIndex = false;
  hasLateralColumnAliasInSelect = true;
  supportsQualify = false;
  supportsNesting = true;
  experimental = false;
  supportsFullJoin = true;
  supportsPipelinesInViews = false;
  readsNestedData = false;
  supportsComplexFilteredSources = false;
  supportsArraysInData = true;
  compoundObjectInSchema = false;
  booleanType: BooleanTypeSupport = 'simulated';
  likeEscape = false;
  orderByClause: OrderByClauseType = 'ordinal';
  hasTimestamptz = false;
  supportsBigIntPrecision = false;
  maxIdentifierLength = 255;

  malloyTypeToSQLType(malloyType: AtomicTypeDef): string {
    switch (malloyType.type) {
      case 'number':
        if (malloyType.numberType === 'integer') {
          return 'Int32';
        } else if (malloyType.numberType === 'bigint') {
          return 'Int64';
        } else {
          return 'Float64';
        }
      case 'string':
        return 'String';
      case 'boolean':
        return 'Bool';
      case 'timestamp':
        return 'DateTime64(3)';
      case 'date':
        return 'Date';
      case 'sql native':
        return malloyType.rawType || 'String';
      case 'record': {
        const typeSpec: string[] = [];
        for (const f of malloyType.fields) {
          if (isAtomic(f)) {
            typeSpec.push(
              `${this.sqlMaybeQuoteIdentifier(f.name)} ${this.malloyTypeToSQLType(f)}`
            );
          }
        }
        return `Tuple(${typeSpec.join(', ')})`;
      }
      case 'array': {
        if (isRepeatedRecord(malloyType)) {
          const typeSpec: string[] = [];
          for (const f of malloyType.fields) {
            if (isAtomic(f)) {
              typeSpec.push(
                `${this.sqlMaybeQuoteIdentifier(f.name)} ${this.malloyTypeToSQLType(f)}`
              );
            }
          }
          return `Array(Tuple(${typeSpec.join(', ')}))`;
        }
        return `Array(${this.malloyTypeToSQLType(malloyType.elementTypeDef)})`;
      }
      default:
        return malloyType.type;
    }
  }

  sqlTypeToMalloyType(sqlType: string): BasicAtomicTypeDef {
    // Strip Nullable(...) and LowCardinality(...) wrappers
    let normalizedType = sqlType.trim();
    const wrapperPattern = /^(Nullable|LowCardinality)\((.+)\)$/i;
    let match = normalizedType.match(wrapperPattern);
    while (match) {
      normalizedType = match[2].trim();
      match = normalizedType.match(wrapperPattern);
    }

    // Extract base type name (before any parenthesized params)
    const baseSqlType = normalizedType.match(/^(\w+)/)?.at(0) ?? normalizedType;
    return (
      clickhouseToMalloyTypes[baseSqlType.toLowerCase()] || {
        type: 'sql native',
        rawType: baseSqlType,
      }
    );
  }

  quoteTablePath(tablePath: string): string {
    return tablePath
      .split('.')
      .map(part => `\`${part.replace(/`/g, '\\`')}\``)
      .join('.');
  }

  sqlGroupSetTable(groupSetCount: number): string {
    return `CROSS JOIN (SELECT number AS group_set FROM numbers(${groupSetCount + 1})) AS group_set_t`;
  }

  sqlOrderBy(orderTerms: string[]): string {
    return `ORDER BY ${orderTerms.map(t => `${t} NULLS LAST`).join(',')}`;
  }

  sqlAnyValue(groupSet: number, fieldName: string): string {
    // Use anyIf instead of any(CASE WHEN ...) to avoid Nullable(Array/Tuple)
    // type mismatch when the field is a complex type.
    return `anyIf(${fieldName}, group_set=${groupSet})`;
  }

  // Generate a ClickHouse type string with Nullable wrapping for scalar types.
  // Array and Tuple can't be Nullable in ClickHouse, but their leaf scalars can.
  private nullableSQLType(typeDef: AtomicTypeDef): string {
    switch (typeDef.type) {
      case 'record': {
        const typeSpec: string[] = [];
        for (const f of typeDef.fields) {
          if (isAtomic(f)) {
            typeSpec.push(
              `${this.sqlMaybeQuoteIdentifier(f.name)} ${this.nullableSQLType(f)}`
            );
          }
        }
        return `Tuple(${typeSpec.join(', ')})`;
      }
      case 'array': {
        if (isRepeatedRecord(typeDef)) {
          const typeSpec: string[] = [];
          for (const f of typeDef.fields) {
            if (isAtomic(f)) {
              typeSpec.push(
                `${this.sqlMaybeQuoteIdentifier(f.name)} ${this.nullableSQLType(f)}`
              );
            }
          }
          return `Array(Tuple(${typeSpec.join(', ')}))`;
        }
        return `Array(${this.nullableSQLType(typeDef.elementTypeDef)})`;
      }
      default:
        return `Nullable(${this.malloyTypeToSQLType(typeDef)})`;
    }
  }

  // Build a CAST(... AS Tuple(name Type, ...)) expression.
  // For 2+ fields, uses bare parens: CAST((e1, e2) AS Tuple(...)).
  // For 1 field, uses tuple(): CAST(tuple(e1) AS Tuple(...)) because
  // bare parens around a single value is just a parenthesized expression,
  // not a tuple.
  // Scalar leaf types are wrapped in Nullable(); complex types are not
  // (ClickHouse forbids Nullable(Array/Tuple)).
  private buildNamedTupleExpression(fieldList: DialectFieldList): string {
    const values = fieldList.map(f => f.sqlExpression).join(', ');
    const typeSpec = fieldList
      .map(f => `${f.sqlOutputName} ${this.nullableSQLType(f.typeDef)}`)
      .join(', ');
    const tupleExpr =
      fieldList.length === 1 ? `tuple(${values})` : `(${values})`;
    return `CAST(${tupleExpr} AS Tuple(${typeSpec}))`;
  }

  // Build an arraySort expression for ordering nested results.
  // Uses key-extraction lambdas with positional tuple access.
  // For DESC on numeric fields, uses negate(). For DESC on string
  // fields, falls back to ASC (known limitation).
  private buildArraySort(
    expr: string,
    orderBy: CompiledOrderBy[],
    fieldList: DialectFieldList
  ): string {
    // Map structField names to 1-based positional indices in the tuple.
    // structField is backtick-quoted (via sqlMaybeQuoteIdentifier), so
    // index by both sqlOutputName (quoted) and rawName (unquoted).
    const fieldIndex: Record<string, number> = {};
    fieldList.forEach((f, i) => {
      fieldIndex[f.sqlOutputName] = i + 1;
      fieldIndex[f.rawName] = i + 1;
    });

    // Check if all directions are the same
    const allAsc = orderBy.every(o => o.dir === 'asc');
    const allDesc = orderBy.every(o => o.dir === 'desc');

    const sortKeys = orderBy.map(ob => {
      const pos = fieldIndex[ob.structField];
      const accessor = pos !== undefined ? `x.${pos}` : `x.1`;
      if (ob.dir === 'desc' && !allDesc) {
        // For mixed directions, negate numeric fields for DESC
        return `negate(${accessor})`;
      }
      return accessor;
    });

    const keyExpr =
      sortKeys.length === 1 ? sortKeys[0] : `(${sortKeys.join(', ')})`;
    const sortFunc = allDesc ? 'arrayReverseSort' : 'arraySort';
    return `${sortFunc}(x -> ${keyExpr}, ${expr})`;
  }

  sqlAggregateTurtle(
    groupSet: number,
    fieldList: DialectFieldList,
    orderBy: CompiledOrderBy[] | undefined
  ): string {
    const tupleExpr = this.buildNamedTupleExpression(fieldList);
    // Use groupArrayIf instead of FILTER (WHERE ...) to avoid
    // Nullable(Tuple) issues with CASE WHEN.
    const collectExpr = `groupArrayIf(${tupleExpr}, group_set=${groupSet})`;
    if (!orderBy || orderBy.length === 0) {
      return collectExpr;
    }
    return this.buildArraySort(collectExpr, orderBy, fieldList);
  }

  sqlAnyValueTurtle(groupSet: number, fieldList: DialectFieldList): string {
    const tupleExpr = this.buildNamedTupleExpression(fieldList);
    // Use anyIf instead of any(CASE WHEN ...) to avoid Nullable(Tuple).
    return `anyIf(${tupleExpr}, group_set=${groupSet})`;
  }

  sqlAnyValueLastTurtle(
    name: string,
    groupSet: number,
    sqlName: string
  ): string {
    return `anyIf(${name}, group_set=${groupSet}) as ${sqlName}`;
  }

  sqlCoaleseMeasuresInline(
    groupSet: number,
    fieldList: DialectFieldList
  ): string {
    const tupleExpr = this.buildNamedTupleExpression(fieldList);
    // Use anyIf instead of any(CASE WHEN ...) to avoid Nullable(Tuple).
    // No COALESCE needed since anyIf returns the tuple type directly.
    return `anyIf(${tupleExpr}, group_set=${groupSet})`;
  }

  sqlUnnestAlias(
    source: string,
    alias: string,
    _fieldList: DialectFieldList,
    needDistinctKey: boolean,
    _isArray: boolean,
    _isInNestedPipeline: boolean
  ): string {
    if (needDistinctKey) {
      return `LEFT ARRAY JOIN ${source} AS ${alias}, arrayEnumerate(${source}) AS __row_id_from_${alias}`;
    }
    return `LEFT ARRAY JOIN ${source} AS ${alias}`;
  }

  sqlUnnestPipelineHead(
    isSingleton: boolean,
    sourceSQLExpression: string
  ): string {
    let p = sourceSQLExpression;
    if (isSingleton) {
      p = `[${p}]`;
    }
    return `ARRAY JOIN ${p}`;
  }

  sqlSumDistinctHashedKey(sqlDistinctKey: string): string {
    return `toDecimal128(cityHash64(CAST(${sqlDistinctKey} AS String)), 0)`;
  }

  sqlSumDistinct(key: string, value: string, funcName: string): string {
    const hashKey = this.sqlSumDistinctHashedKey(key);
    // Use scale with 4 decimal places of precision to avoid truncating
    // fractional values. The Decimal128 scale parameter is the number of
    // digits after the decimal point.
    const scale = 100000000.0;
    const v = `toDecimal128(COALESCE(${value},0)*${scale}, 8)`;
    const sqlSum = `(SUM(DISTINCT ${hashKey} + ${v}) - SUM(DISTINCT ${hashKey}))/${scale}`;
    if (funcName === 'SUM') {
      return sqlSum;
    } else if (funcName === 'AVG') {
      return `(${sqlSum})/NULLIF(COUNT(DISTINCT CASE WHEN ${value} IS NOT NULL THEN ${key} END),0)`;
    }
    throw new Error(`Unknown Symmetric Aggregate function ${funcName}`);
  }

  sqlGenerateUUID(): string {
    return 'generateUUIDv4()';
  }

  sqlFieldReference(
    parentAlias: string,
    parentType: FieldReferenceType,
    childName: string,
    _childType: string
  ): string {
    if (childName === '__row_id') {
      return `__row_id_from_${parentAlias}`;
    }
    // LEFT ARRAY JOIN arr AS alias makes alias the scalar element directly
    if (parentType === 'array[scalar]') {
      return parentAlias;
    }
    return `${parentAlias}.${this.sqlMaybeQuoteIdentifier(childName)}`;
  }

  sqlCreateFunction(id: string, funcText: string): string {
    return `CREATE FUNCTION IF NOT EXISTS ${id} AS (param) -> (\n${indent(
      funcText
    )}\n);\n`;
  }

  sqlCreateFunctionCombineLastStage(
    lastStageName: string,
    fieldList: DialectFieldList
  ): string {
    const tupleExpr = this.buildNamedTupleExpression(fieldList);
    return `SELECT groupArray(${tupleExpr}) FROM ${lastStageName}\n`;
  }

  sqlSelectAliasAsStruct(alias: string, fieldList: DialectFieldList) {
    const fields = fieldList
      .map(f => `${alias}.${this.sqlMaybeQuoteIdentifier(f.rawName)}`)
      .join(', ');
    return fieldList.length === 1 ? `tuple(${fields})` : `(${fields})`;
  }

  sqlMaybeQuoteIdentifier(identifier: string): string {
    return '`' + identifier.replace(/`/g, '\\`') + '`';
  }

  sqlCreateTableAsSelect(tableName: string, sql: string): string {
    return `CREATE TABLE ${tableName} ENGINE = Memory AS ${sql}`;
  }

  sqlNowExpr(): string {
    return 'now()';
  }

  sqlConvertToCivilTime(
    expr: string,
    timezone: string,
    _typeDef: AtomicTypeDef
  ): {sql: string; typeDef: AtomicTypeDef} {
    return {
      sql: `toTimeZone(${expr}, '${timezone}')`,
      typeDef: {type: 'timestamp'},
    };
  }

  sqlConvertFromCivilTime(
    expr: string,
    timezone: string,
    _destTypeDef: AtomicTypeDef
  ): string {
    return `toTimeZone(${expr}, '${timezone}')`;
  }

  sqlTruncate(
    expr: string,
    unit: string,
    _typeDef: AtomicTypeDef,
    _inCivilTime: boolean,
    timezone?: string
  ): string {
    // dateTrunc supports a timezone argument; use it when timezone is specified
    // so truncation happens in civil time, not UTC.
    if (timezone) {
      if (unit === 'week') {
        // toStartOfWeek returns Date; cast to DateTime64 for timezone compatibility
        return `toDateTime64(toStartOfWeek(toTimeZone(${expr}, '${timezone}'), 0), 3, '${timezone}')`;
      }
      // dateTrunc returns Date for day/week/month/quarter/year; cast to DateTime64
      const needsCast = ['day', 'month', 'quarter', 'year'].includes(unit);
      const truncated = `dateTrunc('${unit}', ${expr}, '${timezone}')`;
      return needsCast ? `toDateTime64(${truncated}, 3, '${timezone}')` : truncated;
    }
    switch (unit) {
      case 'second':
        return `toStartOfSecond(${expr})`;
      case 'minute':
        return `toStartOfMinute(${expr})`;
      case 'hour':
        return `toStartOfHour(${expr})`;
      case 'day':
        return `toStartOfDay(${expr})`;
      case 'week':
        return `toStartOfWeek(${expr}, 0)`;
      case 'month':
        return `toStartOfMonth(${expr})`;
      case 'quarter':
        return `toStartOfQuarter(${expr})`;
      case 'year':
        return `toStartOfYear(${expr})`;
      default:
        return `dateTrunc('${unit}', ${expr})`;
    }
  }

  sqlOffsetTime(
    expr: string,
    op: '+' | '-',
    magnitude: string,
    unit: string,
    _typeDef: AtomicTypeDef,
    _inCivilTime: boolean,
    _timezone?: string
  ): string {
    const intervalUnit = unit.toUpperCase();
    if (op === '-') {
      return `${expr} - INTERVAL ${magnitude} ${intervalUnit}`;
    }
    return `${expr} + INTERVAL ${magnitude} ${intervalUnit}`;
  }

  sqlTimeExtractExpr(qi: QueryInfo, te: TimeExtractExpr): string {
    let extractFrom = te.e.sql;
    if (TD.isTimestamp(te.e.typeDef)) {
      const tz = qtz(qi);
      if (tz) {
        extractFrom = `toTimeZone(${extractFrom}, '${tz}')`;
      }
    }
    const funcName = extractionMap[te.units];
    if (funcName) {
      return `${funcName}(${extractFrom})`;
    }
    switch (te.units) {
      case 'day_of_week':
        // Mode 3: Sunday=1, Saturday=7 (matches Malloy convention)
        return `toDayOfWeek(${extractFrom}, 3)`;
      case 'year':
        return `toYear(${extractFrom})`;
      case 'month':
        return `toMonth(${extractFrom})`;
      case 'day':
        return `toDayOfMonth(${extractFrom})`;
      case 'hour':
        return `toHour(${extractFrom})`;
      case 'minute':
        return `toMinute(${extractFrom})`;
      case 'second':
        return `toSecond(${extractFrom})`;
      case 'quarter':
        return `toQuarter(${extractFrom})`;
      case 'week':
        return `toWeek(${extractFrom})`;
      default:
        return `EXTRACT(${te.units} FROM ${extractFrom})`;
    }
  }

  sqlCast(qi: QueryInfo, cast: TypecastExpr): string {
    const srcSQL = cast.e.sql || 'internal-error-in-sql-generation';
    const {op, srcTypeDef, dstTypeDef, dstSQLType} = this.sqlCastPrep(cast);
    const tz = qtz(qi);

    // ClickHouse can't CAST NULL to Array. Return empty array instead.
    if (srcSQL === 'NULL' && dstTypeDef?.type === 'array') {
      return `CAST([] AS ${dstSQLType})`;
    }

    if (op === 'timestamp::date' && tz) {
      return `toDate(toTimeZone(${srcSQL}, '${tz}'))`;
    } else if (op === 'date::timestamp' && tz) {
      return `toDateTime64(${srcSQL}, 3, '${tz}')`;
    }
    if (!TD.eq(srcTypeDef, dstTypeDef)) {
      if (TD.isString(dstTypeDef)) {
        return `CAST(${srcSQL} AS String)`;
      }
      return `CAST(${srcSQL} AS ${dstSQLType})`;
    }
    return srcSQL;
  }

  sqlRegexpMatch(df: RegexMatchExpr): string {
    return `match(${df.kids.expr.sql}, ${df.kids.regex.sql})`;
  }

  sqlDateLiteral(_qi: QueryInfo, literal: string): string {
    return `toDate('${literal}')`;
  }

  sqlTimestampLiteral(
    qi: QueryInfo,
    literal: string,
    timezone: string | undefined
  ): string {
    const tz = timezone || qtz(qi);
    if (tz) {
      // 3rd arg to toDateTime64 means "parse this string in this timezone"
      // (not "convert from UTC to this timezone" which toTimeZone does)
      return `toDateTime64('${literal}', 3, '${tz}')`;
    }
    return `toDateTime64('${literal}', 3)`;
  }

  sqlTimestamptzLiteral(
    _qi: QueryInfo,
    _literal: string,
    _timezone: string
  ): string {
    throw new Error('ClickHouse does not support timestamptz');
  }

  sqlMeasureTimeExpr(df: MeasureTimeExpr): string {
    let lVal = df.kids.left.sql;
    let rVal = df.kids.right.sql;
    if (inSeconds[df.units]) {
      lVal = `toUnixTimestamp64Micro(toDateTime64(${lVal}, 6))`;
      rVal = `toUnixTimestamp64Micro(toDateTime64(${rVal}, 6))`;
      const duration = `(${rVal}-${lVal})`;
      const divisor = inSeconds[df.units] * 1000000;
      return `FLOOR(${duration}/${divisor}.0)`;
    }
    throw new Error(`Unknown or unhandled ClickHouse time unit: ${df.units}`);
  }

  sqlSampleTable(tableSQL: string, sample: Sampling | undefined): string {
    if (sample !== undefined) {
      if (isSamplingEnable(sample) && sample.enable) {
        sample = this.defaultSampling;
      }
      if (isSamplingRows(sample)) {
        return `(SELECT * FROM ${tableSQL} LIMIT ${sample.rows})`;
      } else if (isSamplingPercent(sample)) {
        return `(SELECT * FROM ${tableSQL} SAMPLE ${sample.percent / 100})`;
      }
    }
    return tableSQL;
  }

  sqlLiteralString(literal: string): string {
    const noVirgule = literal.replace(/\\/g, '\\\\');
    return "'" + noVirgule.replace(/'/g, "\\'") + "'";
  }

  sqlLiteralRegexp(literal: string): string {
    return "'" + literal.replace(/'/g, "''") + "'";
  }

  getDialectFunctionOverrides(): {
    [name: string]: DialectFunctionOverloadDef[];
  } {
    return expandOverrideMap(CLICKHOUSE_MALLOY_STANDARD_OVERLOADS);
  }

  getDialectFunctions(): {[name: string]: DialectFunctionOverloadDef[]} {
    return expandBlueprintMap(CLICKHOUSE_DIALECT_FUNCTIONS);
  }

  castToString(expression: string): string {
    return `CAST(${expression} AS String)`;
  }

  concat(...values: string[]): string {
    return `concat(${values.join(',')})`;
  }

  validateTypeName(sqlType: string): boolean {
    return sqlType.match(/^[A-Za-z\s(),0-9_]*$/) !== null;
  }

  sqlLiteralArray(lit: ArrayLiteralNode): string {
    const array = lit.kids.values.map(val => val.sql);
    return `[${array.join(',')}]`;
  }

  sqlLiteralRecord(lit: RecordLiteralNode): string {
    // Use CAST to create named tuples. We can't use tuple(val AS name) syntax
    // because enable_named_columns_in_function_tuple breaks groupArrayIf in CTEs.
    const values: string[] = [];
    const typeSpec: string[] = [];
    for (const f of lit.typeDef.fields) {
      if (isAtomic(f)) {
        const name = f.as ?? f.name;
        values.push(
          safeRecordGet(lit.kids, name)?.sql ?? 'NULL'
        );
        typeSpec.push(
          `${this.sqlMaybeQuoteIdentifier(name)} ${this.malloyTypeToSQLType(f)}`
        );
      }
    }
    return `CAST((${values.join(', ')}) AS Tuple(${typeSpec.join(', ')}))`;
  }
}
