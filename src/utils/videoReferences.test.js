import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selectVideoReferenceParents } from './videoReferences.js';

describe('selectVideoReferenceParents', () => {
  it('keeps product anchors but excludes the storyboard board for concept videos', () => {
    const storyboard = { id: 'storyboard', adRole: 'storyboard-board', resultUrl: 'storyboard.png' };
    const product = { id: 'product', adRole: 'product-anchor', resultUrl: 'product.png' };

    assert.deepEqual(
      selectVideoReferenceParents([storyboard, product], 'concept-video'),
      [product],
    );
  });

  it('keeps all image parents for regular video nodes', () => {
    const firstFrame = { id: 'first', resultUrl: 'first.png' };
    const lastFrame = { id: 'last', resultUrl: 'last.png' };

    assert.deepEqual(
      selectVideoReferenceParents([firstFrame, lastFrame], undefined),
      [firstFrame, lastFrame],
    );
  });
});
