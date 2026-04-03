/*
 * Copyright Contributors to the Malloy project
 * SPDX-License-Identifier: MIT
 */

import type {
  Connection,
  MalloyQueryData,
  PersistSQLResults,
  PooledConnection,
  QueryRunStats,
  RunSQLOptions,
  StreamingConnection,
  StructDef,
  QueryOptionsReader,
  QueryData,
  SQLSourceDef,
  TableSourceDef,
  SQLSourceRequest,
} from '@malloydata/malloy';
import {ClickHouseDialect, sqlKey, makeDigest} from '@malloydata/malloy';
import {BaseConnection} from '@malloydata/malloy/connection';
import {createClient} from '@clickhouse/client';
import type {ClickHouseClient} from '@clickhouse/client';

export interface ClickHouseConfiguration {
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  setupSQL?: string;
}

export class ClickHouseExecutor {
  public static getConnectionOptionsFromEnv(): ClickHouseConfiguration {
    const host = process.env['CLICKHOUSE_HOST'];
    if (host) {
      const port = process.env['CLICKHOUSE_PORT']
        ? Number(process.env['CLICKHOUSE_PORT'])
        : undefined;
      const username = process.env['CLICKHOUSE_USER'];
      const password = process.env['CLICKHOUSE_PASSWORD'];
      const database = process.env['CLICKHOUSE_DATABASE'];
      return {host, port, username, password, database};
    }
    return {};
  }
}

export class ClickHouseConnection
  extends BaseConnection
  implements Connection, PersistSQLResults
{
  private readonly dialect = new ClickHouseDialect();
  private client?: ClickHouseClient;
  config: ClickHouseConfiguration;
  queryOptions: QueryOptionsReader | undefined;
  public name: string;

  get dialectName(): string {
    return this.dialect.name;
  }

  constructor(
    name: string,
    config: ClickHouseConfiguration,
    queryOptions?: QueryOptionsReader
  ) {
    super();
    this.config = config;
    this.queryOptions = queryOptions;
    this.name = name;
  }

  private getClient(): ClickHouseClient {
    if (!this.client) {
      const url = this.config.host
        ? `${this.config.host}${this.config.port ? ':' + this.config.port : ''}`
        : 'http://localhost:8123';
      this.client = createClient({
        url,
        username: this.config.username || 'default',
        password: this.config.password || '',
        database: this.config.database || 'default',
        clickhouse_settings: {
          output_format_json_quote_64bit_integers: 0,
          join_use_nulls: 1,
          group_by_use_nulls: 1,
          cast_keep_nullable: 1,
          output_format_json_named_tuples_as_objects: 1,
          date_time_output_format: 'iso',
        },
      });
    }
    return this.client;
  }

  async manifestTemporaryTable(sqlCommand: string): Promise<string> {
    const hash = makeDigest(sqlCommand);
    const tableName = `tt${hash.slice(0, this.dialect.maxIdentifierLength - 2)}`;
    const cmd = `CREATE TABLE IF NOT EXISTS ${tableName} ENGINE = Memory AS (${sqlCommand})`;
    await this.runRawSQL(cmd);
    return tableName;
  }

  public async test(): Promise<void> {
    await this.runRawSQL('SELECT 1');
  }

  runSQL(sql: string, _options?: RunSQLOptions): Promise<MalloyQueryData> {
    return this.runRawSQL(sql);
  }

  isPool(): this is PooledConnection {
    return false;
  }

  public getDigest(): string {
    const {host, port, username, database} = this.config;
    return makeDigest(
      'clickhouse',
      host,
      port !== undefined ? String(port) : undefined,
      username,
      database,
      this.config.setupSQL
    );
  }

  canPersist(): this is PersistSQLResults {
    return true;
  }

  canStream(): this is StreamingConnection {
    return false;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = undefined;
    }
  }

  estimateQueryCost(_sqlCommand: string): Promise<QueryRunStats> {
    throw new Error('Method not implemented.');
  }

  async fetchTableSchema(
    tableName: string,
    tablePath: string
  ): Promise<TableSourceDef | string> {
    const structDef: TableSourceDef = {
      type: 'table',
      name: tableName,
      tablePath,
      dialect: this.dialectName,
      connection: this.name,
      fields: [],
    };

    const quotedTablePath = this.dialect.quoteTablePath(tablePath);
    const infoQuery = `DESCRIBE TABLE ${quotedTablePath}`;
    const result = await this.runRawSQL(infoQuery);
    this.schemaFromDescribeResult(result, structDef);
    return structDef;
  }

  async fetchSelectSchema(sqlRef: SQLSourceRequest): Promise<SQLSourceDef | string> {
    const structDef: SQLSourceDef = {
      type: 'sql_select',
      ...sqlRef,
      dialect: this.dialectName,
      fields: [],
      name: sqlKey(sqlRef.connection, sqlRef.selectStr),
    };

    // Use DESCRIBE on a subquery to get schema without executing
    const describeQuery = `DESCRIBE (${sqlRef.selectStr})`;
    try {
      const result = await this.runRawSQL(describeQuery);
      this.schemaFromDescribeResult(result, structDef);
    } catch {
      // Fallback: create temp table
      const tableName = `__malloy_tmp_${Date.now()}`;
      await this.runRawSQL(
        `CREATE TABLE ${tableName} ENGINE = Memory AS (${sqlRef.selectStr})`
      );
      const result = await this.runRawSQL(`DESCRIBE TABLE ${tableName}`);
      this.schemaFromDescribeResult(result, structDef);
      await this.runRawSQL(`DROP TABLE IF EXISTS ${tableName}`);
    }
    return structDef;
  }

  private schemaFromDescribeResult(
    result: MalloyQueryData,
    structDef: StructDef
  ): void {
    for (const row of result.rows) {
      const fieldName = row['name'] as string;
      const fieldType = row['type'] as string;

      // Detect AggregateFunction(func, type) columns from AggregatingMergeTree tables.
      // Map the inner type to Malloy and store the full AggregateFunction type in rawType
      // so SQL generation can use -Merge combinators (e.g., sumMerge instead of sum).
      const aggMatch = fieldType.match(
        /^AggregateFunction\((\w+),\s*(.+)\)$/i
      );
      if (aggMatch) {
        structDef.fields.push({
          type: 'sql native',
          rawType: fieldType,
          name: fieldName,
        });
        continue;
      }

      const malloyType = this.dialect.sqlTypeToMalloyType(fieldType);
      structDef.fields.push({...malloyType, name: fieldName});
    }
  }

  async runRawSQL(sql: string): Promise<MalloyQueryData> {
    const client = this.getClient();
    const resultSet = await client.query({
      query: sql,
      format: 'JSONEachRow',
    });
    const rows = (await resultSet.json()) as QueryData;
    return {rows, totalRows: rows.length};
  }

}
