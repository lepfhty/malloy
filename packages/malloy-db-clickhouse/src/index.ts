/*
 * Copyright Contributors to the Malloy project
 * SPDX-License-Identifier: MIT
 */

export {ClickHouseConnection, ClickHouseExecutor} from './clickhouse_connection';

import {registerConnectionType} from '@malloydata/malloy';
import type {ConnectionConfig} from '@malloydata/malloy';
import {ClickHouseConnection} from './clickhouse_connection';

registerConnectionType('clickhouse', {
  displayName: 'ClickHouse',
  factory: async (config: ConnectionConfig) => {
    return new ClickHouseConnection(config.name, {
      host: typeof config['host'] === 'string' ? config['host'] : undefined,
      port: typeof config['port'] === 'number' ? config['port'] : undefined,
      database:
        typeof config['database'] === 'string' ? config['database'] : undefined,
      username:
        typeof config['username'] === 'string' ? config['username'] : undefined,
      password:
        typeof config['password'] === 'string' ? config['password'] : undefined,
      setupSQL:
        typeof config['setupSQL'] === 'string' ? config['setupSQL'] : undefined,
    });
  },
  properties: [
    {
      name: 'host',
      displayName: 'Host',
      type: 'string',
      optional: true,
      default: 'http://localhost:8123',
    },
    {
      name: 'port',
      displayName: 'Port',
      type: 'number',
      optional: true,
      default: '8123',
    },
    {name: 'database', displayName: 'Database', type: 'string', optional: true},
    {
      name: 'username',
      displayName: 'Username',
      type: 'string',
      optional: true,
      default: 'default',
    },
    {
      name: 'password',
      displayName: 'Password',
      type: 'password',
      optional: true,
    },
    {
      name: 'setupSQL',
      displayName: 'Setup SQL',
      type: 'text',
      optional: true,
      description: 'SQL statements to run when the connection is established',
    },
  ],
});
