/*
 * Copyright Contributors to the Malloy project
 * SPDX-License-Identifier: MIT
 */

import type {MalloyStandardFunctionImplementations as OverrideMap} from '../functions/malloy_standard_functions';

export const CLICKHOUSE_MALLOY_STANDARD_OVERLOADS: OverrideMap = {
  byte_length: {function: 'LENGTH'},
  starts_with: {sql: 'COALESCE(startsWith(${value}, ${prefix}), 0)'},
  ends_with: {sql: 'COALESCE(endsWith(${value}, ${suffix}), 0)'},
  strpos: {sql: 'positionUTF8(${test_string}, ${search_string})'},
  log: {sql: '(log(${value}) / log(${base}))'},
  div: {sql: 'intDiv(${dividend}, ${divisor})'},
  replace: {
    regular_expression: {
      sql: 'replaceRegexpAll(${value}, ${pattern}, ${replacement})',
    },
  },
  regexp_extract: {sql: "extractAll(${value}, ${pattern})[1]"},
  chr: {sql: 'char(${value})'},
  trim: {
    characters: {sql: 'trim(BOTH ${trim_characters} FROM ${value})'},
  },
  ltrim: {
    characters: {sql: 'trim(LEADING ${trim_characters} FROM ${value})'},
  },
  rtrim: {
    characters: {sql: 'trim(TRAILING ${trim_characters} FROM ${value})'},
  },
  is_inf: {sql: 'if(${value} IS NULL, 0, isInfinite(${value}))'},
  is_nan: {sql: 'if(${value} IS NULL, 0, isNaN(${value}))'},
  unicode: {sql: 'toUInt32(reinterpretAsUInt32(substring(${value}, 1, 1)))'},
  stddev: {function: 'stddevSamp'},
  greatest: {
    sql: 'CASE WHEN countEqual([${...values}], NULL) > 0 THEN NULL ELSE greatest(${...values}) END',
  },
  least: {
    sql: 'CASE WHEN countEqual([${...values}], NULL) > 0 THEN NULL ELSE least(${...values}) END',
  },
  lag: {
    bare: {
      sql: 'lagInFrame(toNullable(${value}))',
      needsWindowOrderBy: true,
      between: {preceding: -1, following: -1},
    },
    with_offset: {
      sql: 'lagInFrame(toNullable(${value}), ${offset})',
      needsWindowOrderBy: true,
      between: {preceding: -1, following: -1},
    },
    with_default: {
      sql: 'lagInFrame(toNullable(${value}), ${offset}, ${default})',
      needsWindowOrderBy: true,
      between: {preceding: -1, following: -1},
    },
  },
  lead: {
    bare: {
      sql: 'leadInFrame(toNullable(${value}))',
      needsWindowOrderBy: true,
      between: {preceding: -1, following: -1},
    },
    with_offset: {
      sql: 'leadInFrame(toNullable(${value}), ${offset})',
      needsWindowOrderBy: true,
      between: {preceding: -1, following: -1},
    },
    with_default: {
      sql: 'leadInFrame(toNullable(${value}), ${offset}, ${default})',
      needsWindowOrderBy: true,
      between: {preceding: -1, following: -1},
    },
  },
};
