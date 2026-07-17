import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PRODUCT_IMAGE_PROMPT_MAX_CHARS,
    PRODUCT_STORYBOARD_PROMPT_MAX_CHARS,
    PRODUCT_VIDEO_PROMPT_MAX_CHARS,
    buildCompactBackendStoryboardPrompt,
    compactProductShotPrompts,
} from '../utils/product-prompt-limits.js';

const repeated = (label, count) => `${label}${'细节'.repeat(count)}`;

test('keeps long shot prompts without hard truncation', () => {
    const shots = Array.from({ length: 8 }, (_, index) => compactProductShotPrompts({
            imagePrompt: repeated(`图片提示${index + 1}`, 800),
            videoPrompt: repeated(`视频提示${index + 1}`, 800),
            consistencyAnchor: '唯一产品锚点',
            characterAnchor: '数字人小雅正脸清晰',
            styleAnchor: '商业摄影',
            visualDirection: repeated('视觉方向', 200),
            sceneWorld: repeated('场景世界', 100),
            colorLighting: repeated('色彩灯光', 100),
        }));

    assert.equal(shots.length, 8);
    for (const shot of shots) {
        assert.ok(shot.imagePrompt.length <= PRODUCT_IMAGE_PROMPT_MAX_CHARS);
        assert.ok(shot.videoPrompt.length <= PRODUCT_VIDEO_PROMPT_MAX_CHARS);
        assert.match(shot.imagePrompt, /唯一产品锚点|产品一致性/);
        assert.match(shot.imagePrompt, /数字人小雅|数字人/);
        assert.match(shot.videoPrompt, /唯一产品锚点|产品一致性/);
        // 长文应保留，不再压到 1400 字以内
        assert.ok(shot.imagePrompt.length > 500);
    }
});

test('builds the backend storyboard prompt from shot fields including character anchor', () => {
    const concept = {
        title: '测试创意',
        visualDirection: repeated('视觉方向', 200),
        sceneWorld: repeated('场景世界', 100),
        colorLighting: repeated('色彩灯光', 100),
        propStrategy: repeated('道具策略', 100),
        shots: Array.from({ length: 8 }, (_, index) => ({
            startSec: index * 2,
            endSec: Math.min(15, index * 2 + 2),
            shotSize: '中景',
            camera: '稳定机位',
            scene: `场景${index + 1}`,
            composition: '中央构图',
            action: `动作${index + 1}`,
            shotPurpose: `职责${index + 1}`,
            subtitle: `字幕${index + 1}`,
        })),
    };

    const prompt = buildCompactBackendStoryboardPrompt(concept, {
        videoDuration: 15,
        aspectRatio: '9:16',
        industry: '服装鞋包',
        productName: '测试商品',
        consistencyAnchor: repeated('产品锚点', 200),
        characterAnchor: '数字人小雅·正脸清晰',
    });

    assert.ok(prompt.length <= PRODUCT_STORYBOARD_PROMPT_MAX_CHARS);
    assert.match(prompt, /镜头01/);
    assert.match(prompt, /镜头08/);
    assert.match(prompt, /数字人小雅/);
});
