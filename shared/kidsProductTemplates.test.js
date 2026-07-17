import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BUILTIN_KIDS_PRODUCT_TEMPLATES,
  mergeBuiltinKidsProductTemplates,
} from './kidsProductTemplates.js';

describe('kids product templates', () => {
  it('ships the four approved kidswear prompt templates', () => {
    assert.deepEqual(
      BUILTIN_KIDS_PRODUCT_TEMPLATES.map((template) => template.name),
      [
        '童装·妈妈随手拍',
        '童装·小女孩跳舞',
        '童装·出门穿搭',
        '童装·妈妈选衣分享',
      ],
    );
  });

  it('provides complete prompts and supported defaults for every template', () => {
    for (const template of BUILTIN_KIDS_PRODUCT_TEMPLATES) {
      assert.equal(template.builtin, true);
      assert.match(template.id, /^builtin-kids-/);
      assert.ok(template.analyzePrompt.length > 100);
      assert.ok(template.conceptPrompt.length > 100);
      assert.ok(template.shotPrompt.length > 100);
      assert.ok([6, 10, 20, 30].includes(template.defaults.videoDuration));
    }
  });

  it('adds missing built-ins to the API list without duplicating an existing server copy', () => {
    const remoteKidsTemplate = {
      ...BUILTIN_KIDS_PRODUCT_TEMPLATES[0],
      desc: 'server copy wins',
    };
    const merged = mergeBuiltinKidsProductTemplates([
      { id: 'builtin-general-commerce', name: '通用电商' },
      remoteKidsTemplate,
    ]);

    assert.equal(merged.filter((template) => template.id === remoteKidsTemplate.id).length, 1);
    assert.equal(merged.find((template) => template.id === remoteKidsTemplate.id).desc, 'server copy wins');
    assert.equal(merged.length, 5);
  });
});
