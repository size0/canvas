import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateUUID, installRandomUUIDFallback } from '../src/utils/generateUuid.js';

describe('generateUUID', () => {
  it('uses the native implementation when randomUUID is available', () => {
    const expected = '11111111-2222-4333-8444-555555555555';
    const cryptoApi = { randomUUID: () => expected };

    assert.equal(generateUUID(cryptoApi), expected);
  });

  it('creates an RFC 4122 v4 UUID when randomUUID is unavailable', () => {
    let seed = 0;
    const cryptoApi = {
      getRandomValues: (bytes) => {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = seed + index;
        }
        seed += bytes.length;
        return bytes;
      },
    };

    const first = generateUUID(cryptoApi);
    const second = generateUUID(cryptoApi);

    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(second, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(first, second);
  });

  it('still creates a UUID when no Web Crypto API is available', () => {
    assert.match(
      generateUUID(null),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('installs the fallback only when the native method is missing', () => {
    const nativeRandomUUID = () => 'native';
    const nativeCrypto = { randomUUID: nativeRandomUUID };
    const insecureCrypto = {
      getRandomValues: (bytes) => {
        bytes.fill(7);
        return bytes;
      },
    };

    installRandomUUIDFallback(nativeCrypto);
    installRandomUUIDFallback(insecureCrypto);

    assert.equal(nativeCrypto.randomUUID, nativeRandomUUID);
    assert.match(
      insecureCrypto.randomUUID(),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
