import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode, encode, type Entry } from '../src/env-archive.ts';
import { MiB } from '../src/env-files.ts';

const payload = (path: string, bytes = Buffer.from('{}')): Entry => ({
  root: 'agent', path, bytes, mode: 0o600, templated: false,
});

test('archive codec round trips a nested USTAR path and preserves binary bytes', () => {
  const dir = `extensions/${'a'.repeat(85)}`;
  const input = [payload('settings.json'), payload(`${dir}/binary.dat`, Buffer.from([0, 255]))];
  assert.deepEqual(decode(encode({}, input)).entries, input);
});

test('portable names cannot differ only in case or Unicode composition', () => {
  assert.throws(() => encode({}, [payload('settings.json'), payload('Settings.json')]), /archive-path-conflict/);
  assert.throws(() => encode({}, [payload('skills/café/one'), payload('skills/cafe\u0301/two')]), /archive-path-conflict/);
});

test('large manifest is rejected on archive production', () => {
  assert.throws(() => encode({ note: 'a'.repeat(MiB) }, [payload('settings.json')]), /archive-limit/);
});
