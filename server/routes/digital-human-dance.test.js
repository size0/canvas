import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildPrompts,
    danceDirectionOptions,
    normalizePlan,
    timelineRangesFor,
} from './digital-human-dance.js';

test('uses fewer continuous dance phrases instead of six action cards', () => {
    assert.deepEqual(timelineRangesFor(6), [[0, 3], [3, 6]]);
    assert.deepEqual(timelineRangesFor(10), [[0, 3], [3, 7], [7, 10]]);
    assert.deepEqual(timelineRangesFor(20), [[0, 5], [5, 10], [10, 15], [15, 20]]);
    assert.deepEqual(timelineRangesFor(30), [[0, 6], [6, 12], [12, 18], [18, 24], [24, 30]]);
});

test('exposes an age-appropriate dance library without randomly preselecting a style', () => {
    const childOptions = danceDirectionOptions('约4岁儿童');
    const adultOptions = danceDirectionOptions('约23岁成年');

    assert.ok(childOptions.length >= 6);
    assert.ok(adultOptions.length >= 7);
    assert.ok(childOptions.some(item => item.includes('Funk')));
    assert.ok(adultOptions.some(item => item.includes('House')));
    assert.notDeepEqual(childOptions, adultOptions);
});

test('keeps eight-count labels and distributes fallback phrases through the ending', () => {
    const plan = normalizePlan({
        characterProfile: { ageGroup: '约23岁成年' },
        roleSetting: {
            theme: '街角唱片店下班前的轻快舞蹈',
            scene: '有自然侧光和完整舞动空间的唱片店',
            danceStyle: 'House groove',
            tempoBpm: 122,
        },
        storyboard: {
            danceName: '唱针回弹',
            coreGroove: '持续 jack 律动',
            movementMotif: '交叉换步与脚跟内外转',
            rhythmArc: '建立—发展—高潮—收尾',
            timeline: [
                { counts: '第1个八拍', action: '第1拍右脚落地', connection: '右脚继续支撑' },
                { counts: '第2个八拍', action: '左脚交叉换步', connection: '重心转移到左脚' },
                { counts: '第3个八拍', action: '动作母题扩大', connection: '以回弹进入高潮' },
                { counts: '第4个八拍', action: '收束并落稳', connection: '保持最后落点' },
            ],
        },
    }, 20, 'House groove');

    assert.equal(plan.storyboard.timeline.length, 4);
    assert.equal(plan.storyboard.timeline[0].counts, '第1个八拍');
    assert.equal(plan.storyboard.timeline[3].action, '收束并落稳');
    assert.equal(plan.roleSetting.tempoBpm, 122);
});

test('builds a compact Grok prompt centered on groove, counts and continuity', () => {
    const plan = normalizePlan({
        characterProfile: { ageGroup: '约23岁成年' },
        roleSetting: {
            theme: '真实生活场景中的舞蹈',
            outfit: '完整日常穿搭与运动鞋',
            scene: '有自然侧光的唱片店',
            cameraLanguage: '手机竖屏中全景轻微跟拍',
            danceStyle: 'House groove',
            tempoBpm: 120,
        },
        storyboard: {
            danceName: '唱针回弹',
            coreGroove: 'jack 律动持续驱动',
            movementMotif: '交叉换步与脚跟内外转',
            rhythmArc: '建立—发展—高潮—收尾',
            timeline: [
                { counts: '第1个八拍', action: '右脚起步并持续 jack', connection: '右脚落地后直接交叉' },
                { counts: '第2个八拍', action: '交叉换步向左移动', connection: '左脚支撑进入转向' },
                { counts: '第3个八拍', action: '扩大方向与动作幅度', connection: '回弹进入高潮' },
                { counts: '第4个八拍', action: '保持 groove 后收束', connection: '稳定落点' },
            ],
        },
    }, 20, 'House groove');
    const { videoPrompt } = buildPrompts(plan, 20);

    assert.match(videoPrompt, /第1个八拍/);
    assert.match(videoPrompt, /基础 groove 从第一拍持续到最后一拍/);
    assert.match(videoPrompt, /不是独立动作卡/);
    assert.doesNotMatch(videoPrompt, /摄影：摄影如何/);
    assert.ok(videoPrompt.length < 6500);
});
