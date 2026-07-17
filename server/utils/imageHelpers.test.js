import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveImageToBase64 } from './imageHelpers.js';

test('keeps external image URLs so the provider can fetch the reference image', () => {
    const url = 'https://img.alicdn.com/example.jpg_q50.jpg_.webp';
    assert.equal(resolveImageToBase64(url), url);
});
