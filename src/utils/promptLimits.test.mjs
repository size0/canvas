import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IMAGE_PROMPT_MAX_CHARS,
  STORYBOARD_PROMPT_MAX_CHARS,
  VIDEO_PROMPT_MAX_CHARS,
  buildCompactProductStoryboardPrompt,
  buildCompactProductVideoPrompt,
  limitPrompt,
} from './promptLimits.ts';

const longText = (label, length) => `${label}${'细节'.repeat(length)}`;

test('limits ordinary prompts while preserving both the opening and final constraints', () => {
  const prompt = `开头产品锚点：${longText('主体', 1600)}\n结尾负面约束：禁止变形和文字乱码`;
  const limited = limitPrompt(prompt, IMAGE_PROMPT_MAX_CHARS);

  assert.ok(limited.length <= IMAGE_PROMPT_MAX_CHARS);
  assert.match(limited, /^开头产品锚点/);
  assert.match(limited, /结尾负面约束：禁止变形和文字乱码$/);
});
test('builds a storyboard prompt without embedding every full image prompt', () => {
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
    imagePrompt: longText(`不应嵌入的完整提示词${index + 1}`, 1800),
  }));

  const prompt = buildCompactProductStoryboardPrompt({
    title: '测试创意',
    productName: '测试商品',
    industry: '服装鞋包',
    videoDuration: 15,
    aspectRatio: '9:16',
    consistencyAnchor: longText('产品锚点', 500),
    visualDirection: longText('视觉方向', 500),
    sceneWorld: longText('场景世界', 300),
    colorLighting: longText('色彩灯光', 300),
    shots,
  });

  assert.ok(prompt.length <= STORYBOARD_PROMPT_MAX_CHARS);
  assert.doesNotMatch(prompt, /不应嵌入的完整提示词/);
  assert.match(prompt, /镜头01/);
  assert.match(prompt, /镜头08/);
});

test('builds a compact video timeline with every shot and one product anchor', () => {
  const shots = Array.from({ length: 8 }, (_, index) => ({
    startSec: index * 2,
    endSec: Math.min(15, index * 2 + 2),
    shotPurpose: `职责${index + 1}`,
    action: longText(`动作${index + 1}`, 100),
    camera: '稳定推进',
    transition: '动作匹配转场',
    videoPrompt: longText(`不应嵌入的完整视频提示词${index + 1}`, 1800),
  }));

  const prompt = buildCompactProductVideoPrompt({
    productName: '测试商品',
    videoDuration: 15,
    consistencyAnchor: longText('唯一产品锚点', 500),
    visualDirection: longText('视觉方向', 500),
    rhythm: longText('节奏', 300),
    shots,
  });

  assert.ok(prompt.length <= VIDEO_PROMPT_MAX_CHARS);
  assert.doesNotMatch(prompt, /不应嵌入的完整视频提示词/);
  assert.match(prompt, /镜头 1/);
  assert.match(prompt, /镜头 8/);
  assert.equal(prompt.split('唯一产品锚点').length - 1, 1);
});
