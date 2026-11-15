import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../src/errors.ts';
import { canonicalJson, parseJson, parseJsonBytes } from '../src/json.ts';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ToolError, 'expected ToolError');
    return e.code;
  }
  assert.fail('expected an error');
}

describe('strict JSON parser', () => {
  it('parses ordinary JSON into null-prototype objects', () => {
    const v = parseJson('{"a":[1,2.5,-3e2,true,false,null,"x\\u00e9\\n"],"b":{}}') as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(v), null);
    assert.deepEqual(v.a, [1, 2.5, -300, true, false, null, 'xé\n']);
    assert.equal(Object.getPrototypeOf(v.b), null);
  });

  it('rejects duplicate keys', () => {
    assert.equal(code(() => parseJson('{"a":1,"a":2}')), 'json-duplicate-key');
    assert.equal(code(() => parseJson('{"a":{"b":1,"b":1}}')), 'json-duplicate-key');
  });

  it('rejects prototype-sensitive keys', () => {
    for (const k of ['__proto__', 'constructor', 'prototype']) {
      assert.equal(code(() => parseJson(`{"${k}":{"polluted":true}}`)), 'json-unsafe-key');
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it('rejects a byte order mark', () => {
    assert.equal(code(() => parseJsonBytes(Buffer.from('\ufeff{}', 'utf8'))), 'json-bom');
    assert.equal(code(() => parseJson('\ufeff{}')), 'json-bom');
  });

  it('rejects numbers that cannot round-trip', () => {
    assert.equal(code(() => parseJson('12345678901234567890')), 'json-unsafe-number');
    assert.equal(code(() => parseJson('1e400')), 'json-unsafe-number');
    assert.equal(parseJson('9007199254740991'), 9007199254740991);
  });

  it('rejects syntax errors, trailing data, lone surrogates and deep nesting', () => {
    assert.equal(code(() => parseJson('{"a":1,}')), 'json-syntax');
    assert.equal(code(() => parseJson('{} x')), 'json-syntax');
    assert.equal(code(() => parseJson("{'a':1}")), 'json-syntax');
    assert.equal(code(() => parseJson('"\t"')), 'json-syntax');
    assert.equal(code(() => parseJson('01')), 'json-syntax');
    assert.equal(code(() => parseJson('"\\ud800"')), 'json-invalid-string');
    assert.equal(code(() => parseJson('['.repeat(100) + ']'.repeat(100))), 'json-too-deep');
  });

  it('rejects invalid UTF-8', () => {
    assert.equal(code(() => parseJsonBytes(Buffer.from([0x22, 0xff, 0x22]))), 'invalid-utf8');
  });

  it('never includes input text in errors', () => {
    try {
      parseJson('{"secret-value-123": 1, "secret-value-123": 2}');
    } catch (e) {
      assert.ok(e instanceof Error);
      assert.ok(!e.message.includes('secret'));
    }
  });
});

describe('canonical JSON', () => {
  it('sorts object keys and keeps array order', () => {
    assert.equal(canonicalJson({ b: 1, a: [3, 1, 2], c: { z: null, y: 'x' } }), '{"a":[3,1,2],"b":1,"c":{"y":"x","z":null}}');
  });

  it('refuses unsafe values', () => {
    assert.throws(() => canonicalJson(Number.NaN));
    assert.throws(() => canonicalJson(2 ** 60));
    assert.throws(() => canonicalJson(undefined));
  });
});
