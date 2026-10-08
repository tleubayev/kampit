import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postgresPlaceholders } from '../src/postgres.ts';

test('postgres adapter translates positional parameters', () => {
  assert.equal(postgresPlaceholders('SELECT ?::int, ?::text'), 'SELECT $1::int, $2::text');
});
