const KIDS_DIGITAL_RULES = [
  '固定数字人的年龄感、脸型、肤色、发型发饰和鞋袜必须全程一致，童装不得换款、改色或改变图案结构',
  '不得虚构材质成分、尺码适配、功能、价格、优惠、销量、联名、儿童偏好或穿着体验',
  '数字儿童的造型、动作和镜头必须符合年龄感，禁止成人化、性暗示、身体凝视和危险动作',
];

const KIDS_DEFAULTS = {
  conceptCount: 3,
  shotsPerConcept: 5,
  aspectRatio: '9:16',
  videoDuration: 10,
  platform: '抖音',
};

function buildKidsAnalyzePrompt(focus) {
  return `你是童装电商视觉分析与合规专家。区分固定数字人身份参考图和目标童装参考图，人物原穿服装不是目标款。提取数字人的年龄感、脸型、肤色、发型发饰和鞋袜；提取童装品类、版型、领袖下摆、颜色图案、面料观感、口袋扣件和标识位置。把人物与服装的不可变特征完整写入 consistencyAnchor。卖点只用图片可见或用户明确提供的信息；材质、尺码、功能、价格等无证据写“待确认”。本模板重点：${focus}。描述简洁具体。`;
}

function buildKidsShotPrompt(mode, sequence, direction, extra = '') {
  return `你是童装短视频分镜与生成式视频提示词工程师。模式：${mode}。固定同一数字人和同一套童装，每条 imagePrompt、videoPrompt 都带人物与服装一致性锚点。序列：${sequence}。imagePrompt 写场景、景别、机位、动作、光线、画幅和服装细节；videoPrompt 写起始状态、一个动作、一种运镜、结束状态和衔接。${direction}。禁止换脸、换发型鞋袜、换款改色、图案漂移、肢体异常、背景跳变、剧烈抖动和过度磨皮。每帧优先看清服装，字幕只讲一个重点。${extra}`;
}

const KIDS_UGC_CONCEPT_PROMPT = '你是抖音童装 UGC 编导。生成“妈妈手机随手拍”创意，像给姐妹分享，不像广告。场景限客厅、卧室或窗边；数字儿童自然走动、转身、整理袖口或展示口袋，妈妈可画外音或露手。每套按生活钩子—上身亮相—可见细节—自然 CTA，口播短并给动作留时间。不要影棚、T 台、跳舞主线、震惊体或虚构体验。';
const KIDS_DANCE_CONCEPT_PROMPT = '你是童装居家轻舞短视频编导。前三秒用小幅转身、左右轻摆、小碎步或低幅小跳吸引注意，再展示全身、衣摆动态和关键细节，最后停稳收束。少口播、多画面；不同方案更换动作结构，不更换数字人和童装。不要考级舞台、高难动作、成人化舞蹈或硬广叫卖。';
const KIDS_OUTDOOR_CONCEPT_PROMPT = '你是童装出门穿搭 vlog 编导。每套按场景钩子—换装或门厅亮相—户外走动回眸—搭配细节—自然 CTA，突出完整造型与场景适配。必须包含连贯的出门动线，与室内随拍和跳舞区分；同一数字人、童装、发饰和鞋袜全程不变。不要影棚、无逻辑瞬移或危险跑跳。';
const KIDS_MOM_PICK_CONCEPT_PROMPT = '你是童装“妈妈选衣分享”编导，内容服务购买决策，不做孩子表演。每套围绕一个顾虑和一个选择理由，用平铺、举起、细节近景及可选的短时上身证明，结构为纠结钩子—亮款—2至3个可见理由—顾虑回应—自然 CTA。妈妈可画外音、露手或使用固定数字人。不得虚构购买、洗涤、回购或孩子喜欢等亲身体验。';

function makeKidsTemplate({ id, name, focus, styleAnchor, conceptPrompt, sequence, direction, extraRules = [], shotExtra = '' }) {
  const analyzePrompt = buildKidsAnalyzePrompt(focus);
  return {
    id,
    name,
    desc: `${name}竖屏产品广告模板`,
    industry: name,
    builtin: true,
    analyzePrompt,
    dnaPrompt: analyzePrompt,
    conceptPrompt,
    shotPrompt: buildKidsShotPrompt(name, sequence, direction, shotExtra),
    styleAnchor,
    complianceRules: [...KIDS_DIGITAL_RULES, ...extraRules],
    defaults: { ...KIDS_DEFAULTS },
  };
}

export const BUILTIN_KIDS_PRODUCT_TEMPLATES = [
  makeKidsTemplate({
    id: 'builtin-kids-ugc-phone',
    name: '童装·妈妈随手拍',
    focus: '居家竖屏近中景仍能看清完整轮廓、颜色图案和上身效果',
    styleAnchor: '宝妈手机随手拍，居家自然窗光，轻微手持；数字儿童自然走动转身，童装版型、颜色和图案清晰；拒绝影棚、T台和硬广感',
    conceptPrompt: KIDS_UGC_CONCEPT_PROMPT,
    sequence: '居家建立—全身亮相—走动或转身—领袖口袋特写—自然收束—CTA',
    direction: '儿童胸口以上平视手机机位，客厅、卧室或窗边自然光，轻微手持；动作限走两步、转身、整理袖口和展示口袋，不主打舞蹈',
  }),
  makeKidsTemplate({
    id: 'builtin-kids-dance-show',
    name: '童装·小女孩跳舞',
    focus: '轻转身和小跳时的裙摆、衣摆、袖口动态，以及同款识别度',
    styleAnchor: '女童居家轻舞展示，竖屏自然光，小幅转身、小碎步和低幅小跳带动衣摆；服装颜色图案清晰，拒绝舞台感和成人化姿态',
    conceptPrompt: KIDS_DANCE_CONCEPT_PROMPT,
    sequence: '预备姿态—轻转或低幅小跳—衣摆袖口细节—停稳正面—CTA',
    direction: '全身、半身和服装细节交替；儿童胸口以上平视或轻微俯拍，动作限小幅转身、左右轻摆、小碎步和低幅小跳',
    extraRules: ['禁止裙底视角、低机位仰拍、内搭暴露、连续高速旋转、成人化扭胯和身体局部凝视；镜头始终优先看清完整服装'],
  }),
  makeKidsTemplate({
    id: 'builtin-kids-outfit-outdoor',
    name: '童装·出门穿搭',
    focus: '换装到出门场景的完整造型、搭配关系和连续性',
    styleAnchor: '童装出门穿搭 vlog，门厅到户外的连贯动线与自然日光；数字儿童轻松行走回眸，完整造型清晰，拒绝棚拍和场景瞬移',
    conceptPrompt: KIDS_OUTDOOR_CONCEPT_PROMPT,
    sequence: '室内穿鞋或换装—门厅全身亮相—户外行走—回眸或细节—CTA',
    direction: '机位平视后退或侧跟，动作限走路、回眸、整理衣角和安全范围内轻跑两步；室内到户外保持同一数字人、童装、发饰和鞋袜',
  }),
  makeKidsTemplate({
    id: 'builtin-kids-mom-pick-share',
    name: '童装·妈妈选衣分享',
    focus: '平铺、举起、细节和短时上身能够支持的选衣理由',
    styleAnchor: '宝妈选衣分享，竖屏居家自然光；妈妈画外音或手部展示，平铺、举起和细节近景把款式讲清楚，可短时上身；拒绝跳舞和硬广叫卖',
    conceptPrompt: KIDS_MOM_PICK_CONCEPT_PROMPT,
    sequence: '妈妈钩子—平铺或举起全貌—两个细节理由—可选短时上身—CTA',
    direction: '固定手机位或轻微手持，动作限展开、翻面、指向领袖口袋和轻抖看垂感；妈妈可只出声或露手，若露脸须固定同一数字人',
    extraRules: ['不得虚构“我家孩子穿过、洗过、回购或特别喜欢”等第一人称体验，对比仅限用户提供且图片可见的款式差异'],
  }),
];

export function mergeBuiltinKidsProductTemplates(remoteTemplates) {
  const remote = Array.isArray(remoteTemplates) ? remoteTemplates : [];
  const remoteIds = new Set(remote.map((template) => template?.id).filter(Boolean));
  return [
    ...remote,
    ...BUILTIN_KIDS_PRODUCT_TEMPLATES.filter((template) => !remoteIds.has(template.id)),
  ];
}
