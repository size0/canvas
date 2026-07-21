/**
 * 数字人一键编舞：数字人参考图 → 角色设定 → 精确首帧 → Grok 成片。
 *
 * 本路由只负责视觉规划和提示词编排；图片与视频仍由画布节点按顺序生成。
 */
import express from 'express';
import { jsonrepair } from 'jsonrepair';
import { getKey } from '../config.js';
import { multimodalChat, textChat } from '../utils/multimodal-chat.js';

const router = express.Router();
const DEFAULT_DURATION = 20;
const ASPECT_RATIO = '9:16';
const SUPPORTED_DURATIONS = [6, 10, 20, 30];
const CHILD_AGE = /儿童|幼儿|青少年|child|teen/i;
const CHILD_UNSAFE_STYLE = /露脐|抹胸|吊带|滑肩|低胸|性感|挑逗|撩人|扭胯|臀部|胸部|高跟|劈叉|地板动作/gi;
const FACE_REFERENCE_INSTRUCTION = '上传图只有两个用途：判断可见年龄阶段，以及作为后续生图的唯一脸部身份参考。严格保持同一张脸及其可识别的面部结构；不得从上传图提取、描述或延续身材、体型、姿态、气质、服装、发型、发饰、其他配饰、表情模板、构图或背景。';
const FORCED_RESTYLE_INSTRUCTION = '除脸部身份和年龄呈现外，上传图中的其余内容全部视为无效旧方案。必须重新设计肉眼明显不同的完整服装、发型、配饰、表情风格、自然身体姿态和新场景；新方案只依据年龄阶段、舞种和创作主题，不得模仿原图。';

function cleanString(value, fallback = '', max = 4000) {
    const text = typeof value === 'string' || typeof value === 'number'
        ? String(value).trim()
        : '';
    return (text || fallback).slice(0, max);
}

function normalizeDuration(value) {
    const duration = Number.parseInt(value, 10);
    return SUPPORTED_DURATIONS.includes(duration) ? duration : DEFAULT_DURATION;
}

function timelineRangesFor(duration) {
    const segmentCount = duration <= 6 ? 3 : duration <= 10 ? 5 : 6;
    const boundaries = Array.from({ length: segmentCount + 1 }, (_, index) =>
        Math.round((duration * index) / segmentCount)
    );
    return Array.from({ length: segmentCount }, (_, index) => [boundaries[index], boundaries[index + 1]]);
}

function parseStructuredJson(reply) {
    let text = String(reply || '').trim().replace(/^\uFEFF/, '');
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('角色规划未返回完整 JSON');
    const candidate = text.slice(start, end + 1);
    try {
        return JSON.parse(candidate);
    } catch (strictError) {
        try {
            return JSON.parse(jsonrepair(candidate));
        } catch (repairError) {
            throw new Error(`角色规划 JSON 无法解析：${strictError.message}`);
        }
    }
}

function sanitizeChildText(value, fallback) {
    const text = cleanString(value, fallback, 1200);
    return text.replace(CHILD_UNSAFE_STYLE, match => {
        if (/露脐|抹胸|吊带|滑肩|低胸/i.test(match)) return '完整合身上衣';
        if (/高跟/i.test(match)) return '舒适运动鞋';
        if (/劈叉|地板动作/i.test(match)) return '安全低冲击动作';
        if (/扭胯|臀部|胸部/i.test(match)) return '轻快重心变化';
        return '自然童真';
    });
}

function enforceSafetyMode(plan) {
    const isChild = CHILD_AGE.test(plan.characterProfile.ageGroup);
    if (!isChild) {
        return {
            ...plan,
            safetyMode: 'standard',
            safetyNotice: '成年数字人采用常规视觉连续性规则。',
        };
    }

    plan.characterProfile.continuityNote = '后续生图只延续上传数字人的同一脸部设计与儿童年龄呈现；不延续原图的身材、体型、姿态、气质、服装、发型、配饰、表情、构图或背景。';
    plan.roleSetting.outfit = sanitizeChildText(
        plan.roleSetting.outfit,
        '完整得体、方便活动、符合儿童年龄的日常舞蹈服装与舒适运动鞋',
    );
    plan.roleSetting.hairstyle = sanitizeChildText(plan.roleSetting.hairstyle, '自然、整洁、方便活动的儿童发型');
    plan.roleSetting.accessories = sanitizeChildText(plan.roleSetting.accessories, '少量安全、轻便的儿童配饰');
    plan.roleSetting.expressionStyle = sanitizeChildText(plan.roleSetting.expressionStyle, '自然、童真、自信的表情变化');
    plan.roleSetting.danceStyle = sanitizeChildText(plan.roleSetting.danceStyle, '儿童活力短视频流行舞');
    plan.storyboard.timeline = plan.storyboard.timeline.map(item => ({
        ...item,
        action: sanitizeChildText(item.action, '健康、轻快、低冲击并符合儿童年龄的连续舞步'),
        environment: sanitizeChildText(item.environment, '安全、自然的生活场景变化'),
    }));
    return {
        ...plan,
        safetyMode: 'fictional-child',
        safetyNotice: '检测到儿童或青少年年龄呈现：启用原创虚构角色模式，不复刻现实未成年人身份，并自动清理成人化造型与动作。',
    };
}

function normalizePlan(raw, duration) {
    const profile = raw?.characterProfile && typeof raw.characterProfile === 'object'
        ? raw.characterProfile
        : {};
    const role = raw?.roleSetting && typeof raw.roleSetting === 'object'
        ? raw.roleSetting
        : {};
    const storyboard = raw?.storyboard && typeof raw.storyboard === 'object'
        ? raw.storyboard
        : {};
    const rawTimeline = Array.isArray(storyboard.timeline) ? storyboard.timeline : [];
    const fallbackActions = [
        '保持首帧的等待姿势半拍，用一个细小的视线或肩部变化接住音乐起拍',
        '用与场景相符的轻快步法进入主舞段，形成清楚但不夸张的偶像记忆点',
        '完成一组方向变化明确的身体律动和手臂线条，动作连续、节拍清晰',
        '让环境中的一个真实小事件短暂发生，舞者自然注意到，但舞步不中断',
        '恢复主节拍，完成全身旋转、低幅度踢腿或安全跳跃组成的高潮组合',
        '收束舞步并稳定落点，保留真实呼吸和自然表情作为结尾',
    ];
    const fallbackCameras = [
        '成人手持手机视角，保持全身和环境，轻微重新构图',
        '人物动作带动摄影者平滑后退，不主动炫技',
        '轻微横移跟随，始终保留脚部，不切镜',
        '镜头只做被动跟随，让生活事件自然进入再离开',
        '小幅绕行配合高潮动作，不推拉变焦',
        '轻微靠近到中景后停稳，保留一镜到底观感',
    ];
    const timeline = timelineRangesFor(duration).map(([startSec, endSec], index) => {
        const item = rawTimeline[index] && typeof rawTimeline[index] === 'object'
            ? rawTimeline[index]
            : {};
        return {
            startSec,
            endSec,
            action: cleanString(item.action, fallbackActions[index], 1000),
            camera: cleanString(item.camera, fallbackCameras[index], 700),
            environment: cleanString(item.environment, index === 3 ? '生活瞬间自然发生，不抢舞者主体' : '场景结构和灯光保持连续', 500),
        };
    });

    const plan = {
        characterProfile: {
            ageGroup: cleanString(profile.ageGroup, '无法确认', 30),
            visualSummary: '规划模型仅从上传图判断可见年龄阶段，不读取其他人物或造型信息。',
            continuityNote: '后续生图以上传图作为唯一脸部身份参考，只保持同一张脸和年龄呈现；其余视觉元素全部重新设计。',
        },
        roleSetting: {
            theme: cleanString(role.theme, '真实生活场景中的短视频舞蹈', 150),
            outfit: cleanString(role.outfit, '选择与人物年龄呈现、舞种和场景协调且便于活动的完整服装', 900),
            hairstyle: cleanString(role.hairstyle, '重新设计一款与上传图明显不同、适合舞蹈和场景的新发型', 500),
            accessories: cleanString(role.accessories, '少量与主题协调、不会抢主体的配饰', 500),
            expressionStyle: cleanString(role.expressionStyle, '自然、自信，包含一次与生活事件相呼应的细微情绪变化', 500),
            scene: cleanString(role.scene, '选择与人物气质和舞种相符、可供全身舞动的真实生活场景', 900),
            lighting: cleanString(role.lighting, '符合场景来源的真实自然光或环境光', 500),
            colorPalette: cleanString(role.colorPalette, '协调、真实、不过度商业精修', 400),
            cameraLanguage: cleanString(role.cameraLanguage, '9:16 手机竖屏，成人视线附近的手持跟拍，全身入镜，人物带动镜头', 700),
            danceStyle: cleanString(role.danceStyle, '与角色、服装和场景匹配的短视频流行舞', 300),
            tempoBpm: Math.max(80, Math.min(150, Number.parseInt(role.tempoBpm, 10) || 118)),
            lifeMoment: cleanString(role.lifeMoment, '一个背景人物或环境变化造成短暂而自然的情绪反应，但舞蹈不中断', 900),
        },
        storyboard: {
            danceName: cleanString(storyboard.danceName, '生活感一镜到底舞蹈', 120),
            rhythmArc: cleanString(storyboard.rhythmArc, '起拍—进入—展开—生活插曲—高潮—呼吸收尾', 500),
            timeline,
        },
    };
    return enforceSafetyMode(plan);
}

function buildPrompts(plan, duration) {
    const { characterProfile: character, roleSetting: role, storyboard } = plan;
    const isChild = plan.safetyMode === 'fictional-child';
    const childSafe = isChild
        ? '这是一个全新原创的虚构儿童数字角色。服装完整得体，舞蹈健康、童真、低冲击并符合年龄。'
        : '服装与编舞应符合人物明确的年龄呈现，不改变年龄感。';
    const continuity = isChild
        ? `输入素材是用户声明有权使用、且不对应现实未成年人的原创虚构儿童数字角色。只保持该虚构角色的同一张脸和儿童年龄呈现，不推断现实身份。${character.continuityNote}`
        : `输入数字人只作为同一张脸和年龄呈现的视觉参考，不推断现实身份。${character.continuityNote}`;

    const roleImagePrompt = [
        `生成一张 ${ASPECT_RATIO} 竖版、照片级写实的“角色设定定稿图”，不是分镜拼图。`,
        continuity,
        FACE_REFERENCE_INSTRUCTION,
        childSafe,
        FORCED_RESTYLE_INSTRUCTION,
        `主题：${role.theme}。`,
        `完整服装：${role.outfit}。`,
        `发型：${role.hairstyle}。配饰：${role.accessories}。表情风格：${role.expressionStyle}。`,
        `场景：${role.scene}。灯光：${role.lighting}。色彩：${role.colorPalette}。`,
        `摄影语言：${role.cameraLanguage}。人物完整入镜，脚部清楚，身体比例自然，不拉长腿部，不使用低机位仰拍或夸张广角透视。`,
        isChild
            ? '用参考图中的同一张脸建立新的虚构儿童角色造型，再锁定本次新生成的服装、发型、配饰、表情风格和场景供后续首帧使用。只输出单张完整画面，不要多格排版、文字、Logo、水印、换脸、额外肢体或混乱背景。'
            : '用参考图中的同一张脸建立全新造型，再一次性锁定后续视频使用的新服装、新发型、新配饰、新表情风格和新场景。禁止多格排版、文字、Logo、水印、换脸、年龄漂移、额外肢体、塑料皮肤和背景结构混乱。',
    ].join('\n');

    const first = storyboard.timeline[0];
    const firstFramePrompt = [
        `将输入的角色设定定稿图转换为一张 ${ASPECT_RATIO} 竖版“精确视频首帧”，只输出单张画面。`,
        isChild
            ? '输入图是本流程刚刚生成的原创虚构儿童数字角色设定图。延续这名虚构角色的整体造型、年龄呈现、身材比例、服装、发型、配饰、表情基调、场景结构、灯光和色彩。'
            : '角色设定图中的人物面部、年龄呈现、身材比例、服装、发型、配饰、表情基调、场景结构、灯光和色彩全部锁定，不重新设计。',
        childSafe,
        `舞种：${role.danceStyle}，约 ${role.tempoBpm} BPM。首帧处于动作真正开始前的稳定起拍状态：${first.action}。`,
        `镜头：${first.camera}。${role.cameraLanguage}。必须完整保留双脚和头顶安全区，人物占画面约 55%–68%，镜头略高于或接近人物视线，避免仰拍、透视拉伸和超长腿。`,
        `生活事件将在后续视频中发生：${role.lifeMoment}；首帧不要提前把事件演完。`,
        isChild
            ? '只输出一个虚构角色的单张首帧，不要九宫格、分镜板、动作残影、多人复制、文字、水印、服装变化或场景变化。'
            : '禁止九宫格、分镜板、动作残影、多人复制、文字、水印、服装变化、场景变化和脸部漂移。',
    ].join('\n');

    const timelineText = storyboard.timeline.map(item =>
        `${item.startSec}-${item.endSec}秒：${item.action}。摄影：${item.camera}。环境：${item.environment}。`
    ).join('\n');
    const videoPrompt = [
        isChild
            ? '输入图片是视频的精确第一帧，画面中的人物是本流程生成的原创虚构儿童数字角色。全程延续该虚构角色的整体造型、年龄呈现、身材比例、发型、服装、配饰、场景、灯光与色彩。'
            : '输入图片是视频的精确第一帧，也是舞者视觉身份、面部、年龄呈现、身材比例、发型、服装、配饰、场景、灯光与色彩的严格参考。全程保持视觉连续性，不重新设计人物或空间。',
        childSafe,
        `生成一条 ${duration} 秒、${ASPECT_RATIO} 竖屏、正常实时速度、照片级真实手机摄影质感的连续舞蹈视频。舞种为“${role.danceStyle}”，节拍约 ${role.tempoBpm} BPM，主题为“${role.theme}”。`,
        `故事发生在：${role.scene}。小小的现实生活瞬间：${role.lifeMoment}。这个事件只造成一次短暂自然的注意力或情绪变化，舞者不中断舞蹈，背景角色或环境变化不抢镜。`,
        `节奏结构：${storyboard.rhythmArc}。舞名：${storyboard.danceName}。`,
        timelineText,
        `镜头总则：${role.cameraLanguage}。保持一镜到底，不随机切镜；人物动作带动镜头，摄影者只做轻微手持跟随、后退、横移或必要的小幅绕行；全程保留完整脚部，禁止固定机位导致人物只在原地机械扭动。`,
        '动作总则：动作必须踩正常音乐节拍，有明确重心转移、脚步、手臂线条、方向变化和高潮，不做慢动作，不把两秒动作拖满整段，不机械循环；头发、衣摆和配饰符合真实重力与惯性。',
        isChild
            ? '全局限制：保持单镜头、正常速度和稳定空间连续性；角色身体比例自然，服装发型配饰保持连续；肢体与手指结构正确；背景人物短暂经过且不抢镜；不出现文字、Logo、品牌或水印。'
            : '全局限制：不要切镜、瞬移、随机推拉变焦、慢动作、人物僵住或只移动背景；不要换脸、脸部漂移、年龄变化、身材拉长、服装发型配饰变化、塑料皮肤；不要多余肢体、手指错误或人物克隆；不要让背景人物停留、互动过度或抢镜；不要场景结构突变；不要文字、Logo、品牌或水印。',
    ].join('\n\n');

    return { roleImagePrompt, firstFramePrompt, videoPrompt };
}

router.post('/analyze', async (req, res) => {
    const digitalHumanImageUrl = cleanString(req.body?.digitalHumanImageUrl, '', 20_000_000);
    const duration = normalizeDuration(req.body?.duration);
    const plannerModel = cleanString(req.body?.plannerModel, getKey('TEXT_MODEL') || 'grok-4.20-fast', 160);
    const timelineRanges = timelineRangesFor(duration);
    const timelineSkeleton = timelineRanges.map(([start, end], index) =>
        `      {"action":"${start}-${end}秒的连续编舞${index === Math.floor(timelineRanges.length / 2) ? '，生活事件自然进入' : ''}","camera":"摄影如何被动作带动","environment":"环境状态"}`
    ).join(',\n');
    if (!digitalHumanImageUrl) return res.status(400).json({ error: '请上传数字人图片' });
    if (!getKey('TEXT_API_KEY')) return res.status(400).json({ error: '请先在设置中配置文字模型 API Key' });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = data => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        send({ type: 'status', stage: 1, message: '第 1/3 步：仅判断数字人的可见年龄阶段…' });
        const ageReply = await multimodalChat({
            system: `你是数字人素材的年龄阶段分类器。你只能观察并输出画面人物的可见年龄阶段，不得分析、描述、推断或利用脸部细节、身份、性别、民族、健康、气质、身材、体型、姿态、服装、发型、配饰、表情、构图、场景或背景。输入是用户声明有权使用的虚构或自有数字人素材。只输出严格 JSON，不要 Markdown 或解释。`,
            prompt: `只判断画面人物的可见年龄阶段。输出 {"ageGroup":"约4岁儿童/约15岁青少年/约23岁成年/无法确认"}，年龄数字按画面合理估计，且只能包含 ageGroup 这一个字段。`,
            imageUrls: [digitalHumanImageUrl],
            libraryDir: req.app.locals.LIBRARY_DIR,
            model: plannerModel,
            label: '数字人年龄阶段判断',
            maxTokens: 120,
            temperature: 0,
        });
        const ageGroup = cleanString(parseStructuredJson(ageReply)?.ageGroup, '无法确认', 30);

        send({ type: 'status', stage: 1, message: `已判断年龄阶段：${ageGroup}；正在独立设计全新造型与编舞…` });
        const reply = await textChat({
            system: `你是数字人短视频的角色造型师、场景导演和专业舞蹈编导。你不会看到上传图片，只会收到可见年龄阶段，因此不得描述或沿用原图的脸部、身份、性别、民族、健康、气质、身材、体型、姿态、服装、发型、配饰、表情、构图、场景或背景。

请仅依据给定年龄阶段，自主设计全新的完整服装、发型、配饰、表情风格、自然身体姿态、真实生活场景、舞种、节拍和一个微小生活事件。服装、舞种和事件必须彼此匹配；洗衣店只是示例，不得默认使用。若年龄阶段为儿童或青少年，必须采用健康、童真、完整得体的造型与安全低冲击舞蹈。只输出严格 JSON，不要 Markdown 或解释。`,
            prompt: `可见年龄阶段：${ageGroup}。

为该年龄阶段的数字人规划一条 ${duration} 秒、${ASPECT_RATIO}、一镜到底的真实生活感舞蹈视频。不要输出人物视觉分析，只输出：
{
  "roleSetting": {
    "theme": "主题",
    "outfit": "从上到下完整服装与材质颜色",
    "hairstyle": "发型",
    "accessories": "配饰",
    "expressionStyle": "表情风格",
    "scene": "有空间结构和可互动环境元素的真实生活场景",
    "lighting": "灯光",
    "colorPalette": "色彩",
    "cameraLanguage": "手机竖屏一镜到底的机位、距离和跟拍方式",
    "danceStyle": "明确具体的舞种或短视频舞风，不要只写流行舞",
    "tempoBpm": 118,
    "lifeMoment": "只发生一次、自然、不抢镜的小生活事件"
  },
  "storyboard": {
    "danceName": "原创舞名",
    "rhythmArc": "整条节奏弧线",
    "timeline": [
${timelineSkeleton}
    ]
  }
}

要求：${timelineRanges.length} 段合起来是同一支舞，不是动作清单；有清楚脚步、重心、方向、上肢线条、高潮和结尾；不用慢动作填时长；生活事件只能短暂影响注意力，不能打断舞蹈。`,
            model: plannerModel,
            label: '数字人造型与编舞规划',
            maxTokens: 9000,
            temperature: 0.65,
            onDelta: (_delta, total) => {
                if (total % 500 < 30) send({ type: 'progress', stage: 1, chars: total });
            },
        });

        send({ type: 'status', stage: 2, message: '第 2/3 步：正在锁定角色设定和精确首帧…' });
        const plan = normalizePlan({
            ...parseStructuredJson(reply),
            characterProfile: { ageGroup },
        }, duration);
        const prompts = buildPrompts(plan, duration);

        send({ type: 'status', stage: 3, message: `第 3/3 步：正在生成 ${duration} 秒编舞故事板…` });
        send({
            type: 'done',
            data: {
                ...plan,
                ...prompts,
                aspectRatio: ASPECT_RATIO,
                duration,
                plannerModel,
                videoModel: 'grok-imagine-video',
            },
        });
    } catch (error) {
        console.error('[DigitalHumanDance] analyze failed:', error);
        send({ type: 'error', error: error?.message || '数字人编舞规划失败' });
    } finally {
        if (!res.writableEnded) res.end();
    }
});

export default router;
