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

test('normalizes model shot prompts to bounded executable prompts', () => {
    const shots = Array.from({ length: 8 }, (_, index) => compactProductShotPrompts({
            imagePrompt: repeated(`图片提示${index + 1}`, 1800),
            videoPrompt: repeated(`视频提示${index + 1}`, 1800),
            consistencyAnchor: '唯一产品锚点',
            styleAnchor: '商业摄影',
            visualDirection: repeated('视觉方向', 800),
            sceneWorld: repeated('场景世界', 300),
            colorLighting: repeated('色彩灯光', 300),
        }));

    assert.equal(shots.length, 8);
    for (const shot of shots) {
        assert.ok(shot.imagePrompt.length <= PRODUCT_IMAGE_PROMPT_MAX_CHARS);
        assert.ok(shot.videoPrompt.length <= PRODUCT_VIDEO_PROMPT_MAX_CHARS);
        assert.match(shot.imagePrompt, /唯一产品锚点|产品一致性/);
        assert.match(shot.videoPrompt, /唯一产品锚点|产品一致性/);
        assert.ok(shot.videoPrompt.length <= PRODUCT_VIDEO_PROMPT_MAX_CHARS);
    }
});

test('builds the backend storyboard prompt from concise shot fields', () => {
    const concept = {
        title: '测试创意',
        visualDirection: repeated('视觉方向', 800),
        sceneWorld: repeated('场景世界', 300),
        colorLighting: repeated('色彩灯光', 300),
        propStrategy: repeated('道具策略', 300),
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
            imagePrompt: repeated(`FULL_IMAGE_PROMPT_MARKER_${index + 1}`, 1800),
        })),
    };

    const prompt = buildCompactBackendStoryboardPrompt(concept, {
        videoDuration: 15,
        aspectRatio: '9:16',
        industry: '服装鞋包',
        productName: '测试商品',
        consistencyAnchor: repeated('产品锚点', 500),
    });

    assert.ok(prompt.length <= PRODUCT_STORYBOARD_PROMPT_MAX_CHARS);
    assert.doesNotMatch(prompt, /FULL_IMAGE_PROMPT_MARKER/);
    assert.match(prompt, /镜头01/);
    assert.match(prompt, /镜头08/);
    assert.ok(prompt.length <= PRODUCT_STORYBOARD_PROMPT_MAX_CHARS);
});
