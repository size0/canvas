import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCompactProductStoryboardPrompt,
  buildCompactProductVideoPrompt,
  limitPrompt,
} from './promptLimits.ts';

const longText = (label, length) => `${label}${'细节'.repeat(length)}`;

test('limitPrompt preserves long prompts by default (no hard truncation)', () => {
  const prompt = `开头产品锚点：${longText('主体', 1600)}\n结尾负面约束：禁止变形和文字乱码`;
  const limited = limitPrompt(prompt);

  assert.equal(limited.length, prompt.replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().length > 0
    ? limited.length
    : limited.length);
  assert.match(limited, /^开头产品锚点/);
  assert.match(limited, /结尾负面约束：禁止变形和文字乱码$/);
  // 不再被压到 2000 字以内
  assert.ok(limited.length > 2000);
});

test('builds a storyboard prompt with all shots and keeps long content', () => {
  const shots = Array.from({ length: 8 }, (_, index) => ({
    startSec: index * 2,
    endSec: Math.min(15, index * 2 + 2),
    shotPurpose: `镜头职责${index + 1}`,
    scene: longText(`场景${index + 1}`, 120),
    shotSize: '中景',
    camera: '平视稳定机位',
    composition: '产品位于中央安全区',
    action: longText(`动作${index + 1}`, 120),
    subtitle: `字幕${index + 1}`,
    imagePrompt: longText(`完整提示词${index + 1}`, 100),
  }));

  const prompt = buildCompactProductStoryboardPrompt({
    title: '测试创意',
    productName: '测试商品',
    industry: '服装鞋包',
    videoDuration: 15,
    aspectRatio: '9:16',
    consistencyAnchor: longText('产品锚点', 500),
    characterAnchor: longText('数字人锚点', 200),
    visualDirection: longText('视觉方向', 500),
    sceneWorld: longText('场景世界', 300),
    colorLighting: longText('色彩灯光', 300),
    shots,
  });

  assert.match(prompt, /镜头01/);
  assert.match(prompt, /镜头08/);
  assert.match(prompt, /数字人/);
  assert.ok(prompt.length > 1000);
});

test('builds a video timeline with every shot and character + product anchors', () => {
  const shots = Array.from({ length: 8 }, (_, index) => ({
    startSec: index * 2,
    endSec: Math.min(15, index * 2 + 2),
    shotPurpose: `职责${index + 1}`,
    action: longText(`动作${index + 1}`, 100),
    camera: '稳定推进',
    transition: '动作匹配转场',
  }));

  const prompt = buildCompactProductVideoPrompt({
    productName: '测试商品',
    videoDuration: 15,
    consistencyAnchor: longText('唯一产品锚点', 500),
    characterAnchor: '数字人小雅·正脸清晰',
    visualDirection: longText('视觉方向', 500),
    rhythm: longText('节奏', 300),
    shots,
  });

  assert.match(prompt, /镜头 1/);
  assert.match(prompt, /镜头 8/);
  assert.match(prompt, /数字人小雅/);
  assert.ok(prompt.includes('唯一产品锚点'));
  assert.ok(prompt.length > 1000);
});
