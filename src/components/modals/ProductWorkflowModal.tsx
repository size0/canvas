import React, { useEffect, useRef, useState } from 'react';
import {
    Check, Clock, FileText, Film, Image as ImageIcon, Loader2, Mic2,
    Pencil, Save, Sparkles, Trash2, Upload, Wand2, X,
} from 'lucide-react';
import { fetchJsonWithRetry } from '../../utils/fetchJsonWithRetry';
import { mergeBuiltinKidsProductTemplates } from '../../../shared/kidsProductTemplates.js';

export interface 产品DNA {
    productName: string;
    category?: string;
    visualIdentity?: {
        shape?: string;
        colors?: string[];
        materials?: string[];
        packaging?: string;
        visibleText?: string[];
        consistencyAnchor?: string;
    };
    confirmedSellingPoints?: string[];
    targetAudience?: string[];
    usageScenarios?: string[];
    uncertainties?: string[];
    complianceRisks?: string[];
    [key: string]: unknown;
}

export interface Shot {
    index: number;
    startSec?: number;
    endSec?: number;
    description?: string;
    imagePrompt: string;
    videoPrompt: string;
    duration: number;
    narration?: string;
    subtitle?: string;
    voiceover?: string;
    transition?: string;
    shotPurpose?: string;
    scene?: string;
    shotSize?: string;
    camera?: string;
    composition?: string;
    action?: string;
    [key: string]: unknown;
}

export interface Concept {
    id?: string;
    title: string;
    hook?: string;
    angle?: string;
    script?: string;
    cta?: string;
    visualDirection?: string;
    sceneWorld?: string;
    colorLighting?: string;
    propStrategy?: string;
    rhythm?: string;
    differentiation?: string;
    storyboardPrompt?: string;
    shots: Shot[];
    [key: string]: unknown;
}

export interface ProductWorkflowResult {
    productDNA: 产品DNA;
    concepts: Concept[];
    title?: string;
    summary?: string;
    styleAnchor?: string;
    templateId?: string;
    industry?: string;
    talent?: DigitalHumanSelection | null;
    [key: string]: unknown;
}

export type ProductGenerationScope = 'nodes' | 'images' | 'videos' | 'final';

export interface DigitalHumanSelection {
    id?: string | null;
    name: string;
    coverUrl: string;
    referenceImages: string[];
    identityAnchor?: string;
    tags?: string[];
    /** 绑定行业：kids = 童装模板默认人物 */
    defaultFor?: string[];
}

export interface ProductWorkflowOptions {
    productImages: string[];
    digitalHuman?: DigitalHumanSelection | null;
    templateId: string;
    aspectRatio: string;
    conceptCount: number;
    shotsPerConcept: number;
    videoDuration: number;
    generationScope: ProductGenerationScope;
    generateSubtitles: boolean;
    generateVoiceover: boolean;
    platform: string;
    productName: string;
    sellingPoints: string;
    industry: string;
    styleAnchor: string;
}

interface ProductWorkflowModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreate: (result: ProductWorkflowResult, opts: ProductWorkflowOptions) => void;
}

interface ProductTemplate {
    id: string;
    name: string;
    desc?: string;
    industry?: string;
    builtin: boolean;
    analyzePrompt?: string;
    dnaPrompt: string;
    conceptPrompt: string;
    shotPrompt: string;
    styleAnchor?: string;
    complianceRules?: string[];
    defaults?: {
        conceptCount?: number;
        shotsPerConcept?: number;
        aspectRatio?: string;
        videoDuration?: number;
        platform?: string;
        /** kids = 自动选用童装默认数字人 */
        digitalHumanBinding?: string;
        requireDigitalHuman?: boolean;
    };
}

/** 是否为童装类模板（共用一个固定数字人） */
function isKidsProductTemplate(template?: ProductTemplate | null): boolean {
    if (!template) return false;
    if (template.defaults?.digitalHumanBinding === 'kids') return true;
    if (String(template.id || '').startsWith('builtin-kids')) return true;
    const text = `${template.industry || ''} ${template.name || ''}`;
    return /童装/.test(text);
}

/** 挑选童装默认数字人：标记 kids / 童装默认 优先，否则取库中第一张 */
function pickKidsDigitalHuman(list: DigitalHumanSelection[]): DigitalHumanSelection | null {
    if (!list.length) return null;
    return list.find(h =>
        (Array.isArray(h.defaultFor) && h.defaultFor.includes('kids'))
        || (Array.isArray(h.tags) && h.tags.includes('童装默认'))
    ) || list[0] || null;
}

type PromptTab = 'dna' | 'concept' | 'shot';

const PROMPT_TABS: { id: PromptTab; label: string; key: keyof Pick<ProductTemplate, 'dnaPrompt' | 'conceptPrompt' | 'shotPrompt'> }[] = [
    { id: 'dna', label: '① 产品 DNA', key: 'dnaPrompt' },
    { id: 'concept', label: '② 营销创意', key: 'conceptPrompt' },
    { id: 'shot', label: '③ 分镜脚本', key: 'shotPrompt' },
];

const PLATFORMS = ['抖音', '小红书', '视频号', '快手', 'B站', '通用'];
const RATIOS = [
    { value: '9:16', label: '9:16 竖屏' },
    { value: '16:9', label: '16:9 横屏' },
    { value: '1:1', label: '1:1 方形' },
    { value: '4:3', label: '4:3' },
];
const SCOPES: { value: ProductGenerationScope; label: string; desc: string }[] = [
    { value: 'nodes', label: '仅策划节点', desc: '创建策略、视觉导演与故事板节点' },
    { value: 'images', label: '生成故事板', desc: '每套创意生成一张高清分镜母版' },
    { value: 'final', label: '故事板直接出片', desc: '故事板 + 产品原图生成一条 Grok 视频' },
];

const emptyDraft = { dnaPrompt: '', conceptPrompt: '', shotPrompt: '' };
const labelCls = 'flex items-center gap-1.5 text-xs font-medium text-neutral-400 mb-1.5';
const choiceCls = (selected: boolean) =>
    `py-1.5 px-2 rounded-lg text-xs border transition-colors ${selected
        ? 'bg-amber-500/15 border-amber-500/50 text-amber-300'
        : 'bg-white/[0.03] border-white/[0.07] text-neutral-400 hover:text-white hover:bg-white/[0.07]'}`;

export const ProductWorkflowModal: React.FC<ProductWorkflowModalProps> = ({ isOpen, onClose, onCreate }) => {
    const [productName, setProductName] = useState('');
    const [sellingPoints, setSellingPoints] = useState('');
    const [productImageUrl, setProductImageUrl] = useState('');
    const [productImages, setProductImages] = useState<string[]>([]);
    const [digitalHumans, setDigitalHumans] = useState<DigitalHumanSelection[]>([]);
    const [selectedDigitalHuman, setSelectedDigitalHuman] = useState<DigitalHumanSelection | null>(null);
    const [recentImages, setRecentImages] = useState<{ id?: string; url: string; title?: string; prompt?: string }[]>([]);
    const [templates, setTemplates] = useState<ProductTemplate[]>([]);
    const [templateId, setTemplateId] = useState('');
    const [draft, setDraft] = useState(emptyDraft);
    const [showEditor, setShowEditor] = useState(false);
    const [promptTab, setPromptTab] = useState<PromptTab>('dna');
    const [platform, setPlatform] = useState('抖音');
    const [aspectRatio, setAspectRatio] = useState('9:16');
    const [conceptCount, setConceptCount] = useState(3);
    const [videoDuration, setVideoDuration] = useState(10);
    const [generateSubtitles, setGenerateSubtitles] = useState(true);
    const [generateVoiceover, setGenerateVoiceover] = useState(true);
    const [generationScope, setGenerationScope] = useState<ProductGenerationScope>('final');
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [uploadingTalent, setUploadingTalent] = useState(false);
    const [error, setError] = useState('');
    const [stage, setStage] = useState('');
    const [stageNo, setStageNo] = useState(0);
    const [chars, setChars] = useState(0);
    const [elapsed, setElapsed] = useState(0);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const talentInputRef = useRef<HTMLInputElement>(null);
    const promptInputRef = useRef<HTMLInputElement>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const currentTemplate = templates.find(template => template.id === templateId);
    const currentPrompt = PROMPT_TABS.find(tab => tab.id === promptTab)!;
    const keyframeCount = Math.ceil(videoDuration / 2);
    const videoCount = conceptCount;
    const estimatedImages = generationScope === 'nodes' ? 0 : conceptCount;
    const estimatedVideos = generationScope === 'videos' || generationScope === 'final' ? videoCount : 0;
    const previewImage = productImages[0] || '';

    const addProductImages = (images: string[]) => {
        setProductImages(current => Array.from(new Set([...current, ...images.filter(Boolean)])).slice(0, 6));
        setError('');
    };

    const removeProductImage = (image: string) => {
        setProductImages(current => current.filter(item => item !== image));
    };

    const applyTemplate = (template: ProductTemplate, humans?: DigitalHumanSelection[]) => {
        setTemplateId(template.id);
        setDraft({
            dnaPrompt: template.dnaPrompt || '',
            conceptPrompt: template.conceptPrompt || '',
            shotPrompt: template.shotPrompt || '',
        });
        if (template.defaults) {
            if (template.defaults.conceptCount) setConceptCount(Math.max(1, Math.min(6, template.defaults.conceptCount)));
            if (template.defaults.aspectRatio) setAspectRatio(template.defaults.aspectRatio);
            if (template.defaults.videoDuration && [6, 10, 20, 30].includes(template.defaults.videoDuration)) {
                setVideoDuration(template.defaults.videoDuration);
            }
            if (template.defaults.platform) setPlatform(template.defaults.platform);
        }
        // 童装：自动绑定「童装默认」数字人（全库同一张）
        const pool = humans || digitalHumans;
        if (isKidsProductTemplate(template)) {
            const kidsHuman = pickKidsDigitalHuman(pool);
            if (kidsHuman) setSelectedDigitalHuman(kidsHuman);
        }
    };

    const loadTemplates = async (preferredId?: string) => {
        try {
            const data = await fetchJsonWithRetry('/api/product-templates');
            if (!Array.isArray(data) || data.length === 0) throw new Error('暂无可用的产品模板');
            const normalized: ProductTemplate[] = mergeBuiltinKidsProductTemplates(data).map((item: ProductTemplate) => ({
                ...item,
                dnaPrompt: item.dnaPrompt || item.analyzePrompt || '',
                conceptPrompt: item.conceptPrompt || '',
                shotPrompt: item.shotPrompt || '',
            }));
            setError('');
            setTemplates(normalized);
            const picked = normalized.find(item => item.id === preferredId)
                || normalized.find(item => item.id === templateId)
                || normalized[0];
            if (picked) applyTemplate(picked);
        } catch (err: any) {
            setError(err?.message || '产品模板加载失败');
        }
    };

    const loadDigitalHumans = async (): Promise<DigitalHumanSelection[]> => {
        try {
            const response = await fetch('/api/digital-humans');
            const data = await response.json().catch(() => []);
            const list = Array.isArray(data) ? data : [];
            setDigitalHumans(list);
            return list;
        } catch {
            setDigitalHumans([]);
            return [];
        }
    };

    useEffect(() => {
        if (!isOpen) return;
        void (async () => {
            if (templates.length === 0) await loadTemplates();
            const humans = await loadDigitalHumans();
            // 当前已是童装模板时，补绑默认数字人
            const current = templates.find(t => t.id === templateId)
                || (templates.length ? templates[0] : null);
            if (current && isKidsProductTemplate(current)) {
                const kidsHuman = pickKidsDigitalHuman(humans);
                if (kidsHuman) setSelectedDigitalHuman(kidsHuman);
            }
            void fetch('/api/assets/images?limit=8')
                .then(response => response.json())
                .then(data => setRecentImages(Array.isArray(data) ? data : (Array.isArray(data?.assets) ? data.assets : [])))
                .catch(() => setRecentImages([]));
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    const handleTalentUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        setUploadingTalent(true);
        setError('');
        try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(new Error('读取图片失败'));
                reader.readAsDataURL(file);
            });
            const kidsMode = isKidsProductTemplate(currentTemplate);
            const name = file.name.replace(/\.[^.]+$/, '') || (kidsMode ? '童装默认数字人' : '数字人');
            // 童装模板下首次上传：自动设为「童装默认」，以后所有童装工作流共用
            const setAsKidsDefault = kidsMode && !digitalHumans.some(h =>
                (h.defaultFor || []).includes('kids') || (h.tags || []).includes('童装默认')
            );
            const response = await fetch('/api/digital-humans', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    coverUrl: dataUrl,
                    referenceImages: [dataUrl],
                    setKidsDefault: setAsKidsDefault || kidsMode,
                    tags: (setAsKidsDefault || kidsMode) ? ['童装默认'] : [],
                    defaultFor: (setAsKidsDefault || kidsMode) ? ['kids'] : [],
                }),
            });
            const created = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(created?.error || '上传数字人失败');
            const list = await loadDigitalHumans();
            setSelectedDigitalHuman(created.id ? created : pickKidsDigitalHuman(list));
        } catch (err: any) {
            setError(err?.message || '上传数字人失败');
        } finally {
            setUploadingTalent(false);
        }
    };

    const handleSetKidsDefault = async (human: DigitalHumanSelection) => {
        if (!human?.id) return;
        setError('');
        try {
            const response = await fetch(`/api/digital-humans/${encodeURIComponent(human.id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ setKidsDefault: true }),
            });
            const updated = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(updated?.error || '设置失败');
            const list = await loadDigitalHumans();
            const next = list.find(h => h.id === human.id) || updated;
            setSelectedDigitalHuman(next);
        } catch (err: any) {
            setError(err?.message || '设为童装默认失败');
        }
    };

    useEffect(() => () => {
        if (timerRef.current) clearInterval(timerRef.current);
    }, []);

    if (!isOpen) return null;

    const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []).slice(0, 6);
        event.target.value = '';
        if (!files.length) return;
        if (files.some(file => !file.type.startsWith('image/'))) {
            setError('请选择图片文件');
            return;
        }
        if (files.some(file => file.size > 8 * 1024 * 1024)) {
            setError('单张产品图不能超过 8 MB');
            return;
        }
        try {
            const images = await Promise.all(files.map(file => new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = reject;
                reader.readAsDataURL(file);
            })));
            addProductImages(images);
        } catch {
            setError('产品图读取失败');
        }
    };

    const handleAddImageUrl = () => {
        const url = productImageUrl.trim();
        if (!url) return;
        if (!/^https?:\/\//i.test(url) && !url.startsWith('/library/')) {
            setError('请输入 http(s) 图片地址或素材库图片地址');
            return;
        }
        addProductImages([url]);
        setProductImageUrl('');
    };

    const handlePromptImport = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => setDraft(value => ({ ...value, [currentPrompt.key]: String(reader.result || '') }));
        reader.onerror = () => setError('提示词文件读取失败');
        reader.readAsText(file);
    };

    const handleSaveTemplate = async () => {
        const name = window.prompt('另存为自定义模板，请输入名称：', currentTemplate ? `${currentTemplate.name} 副本` : '我的产品模板');
        if (!name?.trim()) return;
        setSaving(true);
        setError('');
        try {
            const response = await fetch('/api/product-templates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name.trim(),
                    industry: name.trim(),
                    desc: '自定义产品模板',
                    analyzePrompt: draft.dnaPrompt,
                    conceptPrompt: draft.conceptPrompt,
                    shotPrompt: draft.shotPrompt,
                    styleAnchor: currentTemplate?.styleAnchor || '',
                    complianceRules: currentTemplate?.complianceRules || [],
                }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data?.error || '保存失败');
            await loadTemplates(data.id);
        } catch (err: any) {
            setError(err?.message || '模板保存失败');
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteTemplate = async () => {
        if (!currentTemplate || currentTemplate.builtin) return;
        if (!window.confirm(`删除自定义模板「${currentTemplate.name}」？`)) return;
        try {
            const response = await fetch(`/api/product-templates/${encodeURIComponent(currentTemplate.id)}`, { method: 'DELETE' });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data?.error || '删除失败');
            }
            await loadTemplates();
        } catch (err: any) {
            setError(err?.message || '模板删除失败');
        }
    };

    const handleSubmit = async () => {
        if (!previewImage) {
            setError('请上传产品图或填写产品图 URL');
            return;
        }
        if (isKidsProductTemplate(currentTemplate) && !selectedDigitalHuman) {
            setError('童装模板需绑定一个固定数字人：请先「上传/更换童装默认」');
            return;
        }
        setLoading(true);
        setError('');
        setStage('正在提交产品信息…');
        setStageNo(0);
        setChars(0);
        setElapsed(0);
        timerRef.current = setInterval(() => setElapsed(value => value + 1), 1000);

        const opts: ProductWorkflowOptions = {
            productImages,
            digitalHuman: selectedDigitalHuman,
            templateId,
            aspectRatio,
            conceptCount,
            shotsPerConcept: keyframeCount,
            videoDuration,
            generationScope,
            generateSubtitles,
            generateVoiceover,
            platform,
            productName: productName.trim(),
            sellingPoints: sellingPoints.trim(),
            industry: currentTemplate?.industry || currentTemplate?.name || '',
            styleAnchor: currentTemplate?.styleAnchor || '',
        };

        try {
            const response = await fetch('/api/product-workflow/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...opts,
                    // 服务端的 multimodalChat 同时接受多张远程 URL、素材库 URL 与 data URL。
                    productImageUrls: productImages,
                    digitalHuman: selectedDigitalHuman,
                    prompts: {
                        analyze: draft.dnaPrompt,
                        concept: draft.conceptPrompt,
                        shot: draft.shotPrompt,
                        complianceRules: currentTemplate?.complianceRules || [],
                    },
                }),
            });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data?.error || '产品分析失败');
            }
            if (!response.body) throw new Error('浏览器不支持流式响应');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let result: ProductWorkflowResult | null = null;
            let serverError = '';

            const consumeEvent = (raw: string) => {
                const payload = raw.split('\n')
                    .filter(line => line.startsWith('data:'))
                    .map(line => line.slice(5).trim())
                    .join('\n');
                if (!payload) return;
                try {
                    const event = JSON.parse(payload);
                    if (event.type === 'status') {
                        setStage(event.message || 'AI 分析中…');
                        if (event.stage) setStageNo(Number(event.stage));
                    } else if (event.type === 'progress') {
                        if (typeof event.chars === 'number') setChars(event.chars);
                        if (event.stage) setStageNo(Number(event.stage));
                        if (event.message) setStage(event.message);
                    } else if (event.type === 'done') {
                        result = event.data;
                    } else if (event.type === 'error') {
                        serverError = event.error || '产品分析失败';
                    }
                } catch { /* 忽略心跳及非 JSON 数据 */ }
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
                const events = buffer.split('\n\n');
                buffer = events.pop() || '';
                events.forEach(consumeEvent);
            }
            buffer += decoder.decode();
            if (buffer.trim()) consumeEvent(buffer);
            if (serverError) throw new Error(serverError);
            if (!result) throw new Error('连接中断，未收到分析结果，请重试');
            onCreate(result, opts);
            onClose();
        } catch (err: any) {
            setError(err?.message || '产品分析失败，请重试');
        } finally {
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
            setLoading(false);
        }
    };

    const formatTime = (seconds: number) =>
        `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

    return (
        <div className="fixed inset-x-0 bottom-0 z-[9000] flex items-center justify-center" style={{ top: 'var(--titlebar-h, 0px)' }}>
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={loading ? undefined : onClose} />
            <div className="relative w-[820px] max-w-[94vw] max-h-[92vh] flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#141416] shadow-2xl">
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
                    <div className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-500/25 to-rose-500/25 flex items-center justify-center">
                            <Sparkles size={17} className="text-amber-400" />
                        </div>
                        <div>
                            <h2 className="text-sm font-semibold text-white">产品一键出片</h2>
                            <p className="text-[11px] text-neutral-500">产品 DNA → 营销创意 → 分镜脚本 → 多套成片</p>
                        </div>
                    </div>
                    <button onClick={onClose} disabled={loading} className="p-1.5 rounded-lg text-neutral-500 hover:text-white hover:bg-white/10 disabled:opacity-40">
                        <X size={16} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
                    {/* ① 数字人（童装模板自动绑定默认卡；其它模板可选） */}
                    <section className="rounded-xl border border-violet-500/20 bg-violet-500/[0.04] p-3.5">
                        <div className="flex items-center justify-between mb-2">
                            <label className={labelCls + ' mb-0'}>
                                <Sparkles size={13} className="text-violet-300" />
                                ① 选择数字人
                                {isKidsProductTemplate(currentTemplate) ? (
                                    <span className="text-violet-300/90 font-normal">（童装固定 1 人 · 全片以 ta 为准）</span>
                                ) : (
                                    <span className="text-neutral-500 font-normal">（可选 · 出镜人物外貌以此为准）</span>
                                )}
                            </label>
                            <div className="flex gap-1.5">
                                {!isKidsProductTemplate(currentTemplate) && (
                                    <button
                                        type="button"
                                        onClick={() => setSelectedDigitalHuman(null)}
                                        disabled={loading || !selectedDigitalHuman}
                                        className="px-2 py-1 rounded-md text-[11px] text-neutral-400 hover:text-white bg-white/[0.04] border border-white/[0.06] disabled:opacity-40"
                                    >
                                        不使用数字人
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => talentInputRef.current?.click()}
                                    disabled={loading || uploadingTalent}
                                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-violet-200 border border-violet-500/30 hover:bg-violet-500/10 disabled:opacity-40"
                                >
                                    {uploadingTalent ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
                                    {isKidsProductTemplate(currentTemplate) ? '上传/更换童装默认' : '上传新人'}
                                </button>
                                <input ref={talentInputRef} type="file" accept="image/*" className="hidden" onChange={handleTalentUpload} />
                            </div>
                        </div>
                        {isKidsProductTemplate(currentTemplate) && (
                            <div className="mb-2 text-[11px] text-violet-200/80 rounded-lg border border-violet-500/20 bg-violet-500/10 px-2.5 py-1.5">
                                所有「童装·…」模板共用同一个数字人。上传一次并设为默认后，妈妈随手拍 / 跳舞 / 出门穿搭 / 选衣分享都会自动用 ta。
                            </div>
                        )}
                        {selectedDigitalHuman ? (
                            <div className="flex items-center gap-3 rounded-lg border border-violet-500/40 bg-black/30 p-2">
                                <img src={selectedDigitalHuman.coverUrl} alt="" className="w-14 h-14 rounded-lg object-cover border border-white/10" />
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5 text-xs text-violet-100 font-medium truncate">
                                        <span className="truncate">{selectedDigitalHuman.name}</span>
                                        {((selectedDigitalHuman.defaultFor || []).includes('kids')
                                            || (selectedDigitalHuman.tags || []).includes('童装默认')) && (
                                            <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] bg-violet-500/30 text-violet-100 border border-violet-400/30">童装默认</span>
                                        )}
                                    </div>
                                    <div className="text-[10px] text-neutral-500 mt-0.5 line-clamp-2">
                                        {selectedDigitalHuman.identityAnchor || '后续分镜/成片中人物外貌将锁定此数字人'}
                                    </div>
                                </div>
                                {selectedDigitalHuman.id && !(
                                    (selectedDigitalHuman.defaultFor || []).includes('kids')
                                    || (selectedDigitalHuman.tags || []).includes('童装默认')
                                ) && (
                                    <button
                                        type="button"
                                        disabled={loading}
                                        onClick={() => handleSetKidsDefault(selectedDigitalHuman)}
                                        className="shrink-0 px-2 py-1 rounded-md text-[10px] text-violet-200 border border-violet-500/40 hover:bg-violet-500/15"
                                    >
                                        设为童装默认
                                    </button>
                                )}
                                <Check size={16} className="text-violet-300 shrink-0" />
                            </div>
                        ) : (
                            <div className="text-[11px] text-neutral-500 mb-2">
                                {isKidsProductTemplate(currentTemplate)
                                    ? '请上传一张固定儿童形象，将作为所有童装工作流的唯一数字人。'
                                    : '未选择时行为与原先一致；选择后全片人物以数字人为准，产品仍以产品图为准。'}
                            </div>
                        )}
                        {digitalHumans.length > 0 && (
                            <div className="flex gap-2 overflow-x-auto pt-2 pb-0.5">
                                {digitalHumans.map(human => {
                                    const selected = selectedDigitalHuman?.id === human.id
                                        || selectedDigitalHuman?.coverUrl === human.coverUrl;
                                    const isKidsDefault = (human.defaultFor || []).includes('kids')
                                        || (human.tags || []).includes('童装默认');
                                    return (
                                        <button
                                            key={human.id || human.coverUrl}
                                            type="button"
                                            disabled={loading}
                                            onClick={() => setSelectedDigitalHuman(human)}
                                            title={isKidsDefault ? `${human.name}（童装默认）` : human.name}
                                            className={`relative w-16 shrink-0 rounded-lg overflow-hidden border transition-colors ${selected ? 'border-violet-400 ring-1 ring-violet-400/40' : 'border-white/10 hover:border-violet-400/40'}`}
                                        >
                                            <img src={human.coverUrl} alt="" className="w-16 h-16 object-cover" />
                                            <span className="block px-1 py-0.5 text-[9px] text-neutral-300 truncate bg-black/60">{human.name}</span>
                                            {isKidsDefault && (
                                                <span className="absolute left-0.5 top-0.5 px-1 rounded text-[8px] bg-violet-600/90 text-white">童装</span>
                                            )}
                                            {selected && <Check size={12} className="absolute right-1 top-1 text-violet-200" />}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                        {digitalHumans.length === 0 && !selectedDigitalHuman && (
                            <div className="mt-1 text-[11px] text-neutral-600">数字人库为空。可点「上传新人」，或先在左侧素材库「数字人」分类入库。</div>
                        )}
                    </section>

                    <section className="grid grid-cols-[220px_1fr] gap-4">
                        <div>
                            <label className={labelCls}>
                                <ImageIcon size={13} /> ② 产品参考图
                                <span className="ml-auto text-amber-300">{productImages.length}/6</span>
                            </label>
                            <button type="button" onClick={() => imageInputRef.current?.click()} disabled={loading}
                                className="relative w-full h-[178px] overflow-hidden rounded-xl border border-dashed border-white/15 bg-black/30 hover:border-amber-500/50 transition-colors">
                                {productImages.length
                                    ? <span className="grid h-full grid-cols-2 gap-1 p-1">
                                        {productImages.slice(0, 4).map((image, index) => (
                                            <span key={image} className="relative min-h-0 overflow-hidden rounded-md bg-black/40">
                                                <img src={image} alt={`产品参考图 ${index + 1}`} className="w-full h-full object-contain" />
                                                {index === 3 && productImages.length > 4 && (
                                                    <span className="absolute inset-0 flex items-center justify-center bg-black/65 text-sm text-white">+{productImages.length - 4}</span>
                                                )}
                                            </span>
                                        ))}
                                    </span>
                                    : <span className="flex h-full flex-col items-center justify-center gap-2 text-xs text-neutral-500"><Upload size={22} />上传 1–6 张产品图</span>}
                                {productImages.length > 0 && <span className="absolute right-2 bottom-2 px-2 py-1 rounded-md bg-black/70 text-[10px] text-white">点击继续添加</span>}
                            </button>
                            <input ref={imageInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleImageUpload} />
                            {productImages.length > 0 && (
                                <div className="flex gap-1.5 mt-1.5 overflow-x-auto pb-1">
                                    {productImages.map((image, index) => (
                                        <button key={image} type="button" onClick={() => removeProductImage(image)}
                                            className="relative w-10 h-10 shrink-0 overflow-hidden rounded-md border border-white/10 group"
                                            title={`移除参考图 ${index + 1}`}>
                                            <img src={image} alt="" className="w-full h-full object-cover" />
                                            <span className="absolute inset-0 hidden items-center justify-center bg-black/65 text-white group-hover:flex"><X size={12} /></span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div className="space-y-3">
                            <div>
                                <label className={labelCls}>添加产品图 URL</label>
                                <div className="flex gap-2">
                                    <input value={productImageUrl} onChange={event => setProductImageUrl(event.target.value)}
                                        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); handleAddImageUrl(); } }}
                                        disabled={loading || productImages.length >= 6} placeholder="https://..."
                                        className="flex-1 px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-xs text-neutral-200 outline-none focus:border-amber-500/50" />
                                    <button type="button" onClick={handleAddImageUrl} disabled={loading || !productImageUrl.trim() || productImages.length >= 6}
                                        className="px-3 rounded-lg text-xs text-amber-300 border border-amber-500/30 hover:bg-amber-500/10 disabled:opacity-40">
                                        添加
                                    </button>
                                </div>
                            </div>
                            <div>
                                <label className={labelCls}>产品名（可选，AI 可从图片识别）</label>
                                <input value={productName} onChange={event => setProductName(event.target.value)} disabled={loading}
                                    placeholder="例如：轻盈防晒乳 SPF50+" className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-xs text-neutral-200 outline-none focus:border-amber-500/50" />
                            </div>
                            <div>
                                <label className={labelCls}>真实卖点 / 促销信息</label>
                                <textarea value={sellingPoints} onChange={event => setSellingPoints(event.target.value)} disabled={loading}
                                    placeholder="每行一个真实卖点；可填写活动价、赠品、有效期等。请勿填写无法证实的功效。"
                                    className="w-full h-[72px] px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-xs text-neutral-200 resize-none outline-none focus:border-amber-500/50" />
                            </div>
                        </div>
                        {recentImages.length > 0 && (
                            <div className="md:col-span-2">
                                <div className="text-[11px] text-neutral-500 mb-1.5">或从最近生成的素材中选择</div>
                                <div className="flex gap-2 overflow-x-auto pb-1">
                                    {recentImages.map((image, index) => (
                                        <button
                                            key={image.id || image.url || index}
                                            type="button"
                                            disabled={loading}
                                            onClick={() => productImages.includes(image.url) ? removeProductImage(image.url) : addProductImages([image.url])}
                                            title={image.title || image.prompt || '选择该素材'}
                                            className={`relative w-14 h-14 shrink-0 rounded-lg overflow-hidden border transition-colors ${productImages.includes(image.url) ? 'border-amber-400' : 'border-white/10 hover:border-white/30'}`}
                                        >
                                            <img src={image.url} alt="" className="w-full h-full object-cover" />
                                            {productImages.includes(image.url) && <Check size={12} className="absolute right-1 top-1 text-amber-300" />}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </section>

                    <section>
                        <div className="flex items-center justify-between mb-2">
                            <label className={labelCls + ' mb-0'}><FileText size={13} /> 行业模板</label>
                            <div className="flex gap-1.5">
                                <button onClick={() => setShowEditor(value => !value)} disabled={loading}
                                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-neutral-400 hover:text-white bg-white/[0.04] border border-white/[0.06]">
                                    <Pencil size={11} />{showEditor ? '收起编辑' : '查看 / 编辑三段 Prompt'}
                                </button>
                                {currentTemplate && !currentTemplate.builtin && (
                                    <button onClick={handleDeleteTemplate} disabled={loading} title="删除自定义模板"
                                        className="p-1.5 rounded-md text-neutral-500 hover:text-red-400 bg-white/[0.04] border border-white/[0.06]"><Trash2 size={12} /></button>
                                )}
                            </div>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                            {templates.map(template => (
                                <button key={template.id} onClick={() => applyTemplate(template)} disabled={loading}
                                    className={`relative text-left px-3 py-2.5 rounded-xl border transition-colors ${templateId === template.id
                                        ? 'bg-amber-500/10 border-amber-500/50'
                                        : 'bg-white/[0.025] border-white/[0.07] hover:bg-white/[0.06]'}`}>
                                    {templateId === template.id && <Check size={12} className="absolute top-2 right-2 text-amber-400" />}
                                    <div className={`text-xs font-medium pr-4 ${templateId === template.id ? 'text-amber-300' : 'text-neutral-200'}`}>{template.name}</div>
                                    <div className="mt-1 text-[10px] text-neutral-500 truncate">{template.builtin ? (template.industry || template.desc || '内置行业模板') : `自定义 · ${template.desc || ''}`}</div>
                                </button>
                            ))}
                        </div>
                        {showEditor && (
                            <div className="mt-2 overflow-hidden rounded-xl border border-white/10 bg-black/30">
                                <div className="flex border-b border-white/[0.06]">
                                    {PROMPT_TABS.map(tab => (
                                        <button key={tab.id} onClick={() => setPromptTab(tab.id)}
                                            className={`flex-1 py-2 text-[11px] ${promptTab === tab.id ? 'text-amber-300 bg-white/[0.04] border-b-2 border-amber-400' : 'text-neutral-500 hover:text-neutral-300'}`}>
                                            {tab.label}
                                        </button>
                                    ))}
                                </div>
                                <textarea value={draft[currentPrompt.key]} onChange={event => setDraft(value => ({ ...value, [currentPrompt.key]: event.target.value }))}
                                    disabled={loading} spellCheck={false} placeholder="该阶段的系统提示词…"
                                    className="w-full h-36 px-3 py-2.5 bg-transparent text-[11px] text-neutral-300 font-mono resize-none outline-none leading-relaxed" />
                                <div className="flex items-center justify-between px-2.5 py-2 border-t border-white/[0.06]">
                                    <span className="text-[10px] text-neutral-600">导入内容会覆盖当前段；修改后可另存为自定义模板</span>
                                    <div className="flex gap-1.5">
                                        <button onClick={() => promptInputRef.current?.click()} disabled={loading}
                                            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-neutral-400 hover:text-white bg-white/[0.04] border border-white/[0.06]">
                                            <Upload size={11} />导入当前段
                                        </button>
                                        <input ref={promptInputRef} type="file" accept=".txt,.md,text/plain" className="hidden" onChange={handlePromptImport} />
                                        <button onClick={handleSaveTemplate} disabled={loading || saving}
                                            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] text-white bg-amber-600/80 hover:bg-amber-500 disabled:opacity-50">
                                            {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}另存自定义
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </section>

                    <section className="grid grid-cols-2 gap-4">
                        <div>
                            <label className={labelCls}>发布平台</label>
                            <div className="grid grid-cols-3 gap-1.5">
                                {PLATFORMS.map(item => <button key={item} onClick={() => setPlatform(item)} className={choiceCls(platform === item)}>{item}</button>)}
                            </div>
                        </div>
                        <div>
                            <label className={labelCls}>画幅比例</label>
                            <div className="grid grid-cols-2 gap-1.5">
                                {RATIOS.map(item => <button key={item.value} onClick={() => setAspectRatio(item.value)} className={choiceCls(aspectRatio === item.value)}>{item.label}</button>)}
                            </div>
                        </div>
                    </section>

                    <section className="grid grid-cols-3 gap-4">
                        <div>
                            <label className={labelCls}>创意数量 <span className="ml-auto text-amber-300">{conceptCount} 套</span></label>
                            <input type="range" min={1} max={6} value={conceptCount} onChange={event => setConceptCount(Number(event.target.value))}
                                className="w-full accent-amber-400" />
                        </div>
                        <div>
                            <label className={labelCls}>时间轴关键帧 <span className="ml-auto text-amber-300">{keyframeCount} 张</span></label>
                            <div className="flex h-8 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/[0.06] text-[11px] text-cyan-200">
                                每 2 秒自动规划 1 张
                            </div>
                        </div>
                        <div>
                            <label className={labelCls}><Clock size={12} />每条成片时长</label>
                            <div className="flex gap-1">{[6, 10, 20, 30].map(value => <button key={value} onClick={() => setVideoDuration(value)} className={`flex-1 ${choiceCls(videoDuration === value)}`}>{value}s</button>)}</div>
                        </div>
                    </section>

                    <section>
                        <label className={labelCls}>生成范围</label>
                        <div className="grid grid-cols-3 gap-2">
                            {SCOPES.map(scope => (
                                <button key={scope.value} onClick={() => setGenerationScope(scope.value)}
                                    className={`text-left p-2.5 rounded-xl border ${generationScope === scope.value ? 'bg-amber-500/10 border-amber-500/50' : 'bg-white/[0.025] border-white/[0.07] hover:bg-white/[0.05]'}`}>
                                    <div className={`text-xs ${generationScope === scope.value ? 'text-amber-300' : 'text-neutral-200'}`}>{scope.label}</div>
                                    <div className="text-[10px] text-neutral-500 mt-1">{scope.desc}</div>
                                </button>
                            ))}
                        </div>
                    </section>

                    <section className="grid grid-cols-2 gap-2">
                        {[
                            { label: '自动生成字幕', desc: '按口播文案生成逐句字幕', value: generateSubtitles, set: setGenerateSubtitles, icon: FileText },
                            { label: '生成口播', desc: '为每套创意生成配音文案', value: generateVoiceover, set: setGenerateVoiceover, icon: Mic2 },
                        ].map(item => (
                            <button key={item.label} onClick={() => item.set(!item.value)}
                                className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
                                <div className="flex items-center gap-2 text-left">
                                    <item.icon size={14} className={item.value ? 'text-amber-400' : 'text-neutral-600'} />
                                    <div><div className="text-xs text-neutral-200">{item.label}</div><div className="text-[10px] text-neutral-500">{item.desc}</div></div>
                                </div>
                                <span className={`relative inline-block w-9 h-5 shrink-0 rounded-full transition-colors ${item.value ? 'bg-amber-500/80' : 'bg-white/10'}`}>
                                    <span className={`absolute left-0 top-0.5 block w-4 h-4 bg-white rounded-full transition-transform ${item.value ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                                </span>
                            </button>
                        ))}
                    </section>

                    <section className="flex items-center justify-between px-3.5 py-3 rounded-xl bg-cyan-500/[0.06] border border-cyan-500/20">
                        <div>
                            <div className="text-xs font-medium text-cyan-200">成本预估</div>
                            <div className="text-[10px] text-neutral-500 mt-1">实际消耗取决于生成范围和失败重试</div>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-neutral-300">
                            <span>文本分析 <b className="text-white">3</b> 次</span>
                            <span>故事板母版 <b className="text-white">{estimatedImages}</b> 张（每张 {keyframeCount} 格）</span>
                            <span>Grok 视频 <b className="text-white">{estimatedVideos}</b> 个 / 共 {estimatedVideos * videoDuration}s</span>
                            <span>FFmpeg 合成 <b className="text-emerald-300">0</b> 次</span>
                        </div>
                    </section>
                    {error && <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400">{error}</div>}
                </div>

                <div className="flex items-center justify-between px-5 py-3.5 border-t border-white/[0.06] bg-black/20">
                    <span className="text-[10px] text-neutral-600">先完成三段文本分析，再按生成范围创建内容</span>
                    <div className="flex gap-2">
                        <button onClick={onClose} disabled={loading} className="px-4 py-2 rounded-lg text-xs text-neutral-400 hover:text-white bg-white/[0.04] disabled:opacity-40">取消</button>
                        <button onClick={handleSubmit} disabled={loading || !previewImage || !templateId}
                            className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-medium text-white bg-gradient-to-r from-amber-600 to-rose-600 hover:from-amber-500 hover:to-rose-500 disabled:opacity-40">
                            {loading ? <><Loader2 size={13} className="animate-spin" />分析中…</> : <><Wand2 size={13} />开始一键出片</>}
                        </button>
                    </div>
                </div>

                {loading && (
                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[#141416]/92 backdrop-blur-md">
                        <div className="relative w-16 h-16 mb-5">
                            <div className="absolute inset-0 rounded-full border-2 border-amber-500/20" />
                            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-amber-400 animate-spin" />
                            <div className="absolute inset-0 flex items-center justify-center"><Film size={21} className="text-amber-400" /></div>
                        </div>
                        <div className="flex items-center gap-2 mb-4">
                            {['产品 DNA', '营销创意', '故事板规划'].map((name, index, all) => (
                                <div key={name} className={`flex items-center gap-1 text-[11px] ${stageNo > index + 1 ? 'text-emerald-400' : stageNo === index + 1 ? 'text-amber-300' : 'text-neutral-600'}`}>
                                    <span className={`w-5 h-5 rounded-full flex items-center justify-center border ${stageNo >= index + 1 ? 'border-current' : 'border-neutral-700'}`}>{stageNo > index + 1 ? <Check size={11} /> : index + 1}</span>
                                    {name}{index < all.length - 1 && <span className="mx-1 text-neutral-700">→</span>}
                                </div>
                            ))}
                        </div>
                        <div className="text-sm font-medium text-white">{stage || 'AI 分析中…'}</div>
                        <div className="mt-2 text-[11px] text-neutral-500">{chars > 0 ? `本段已生成 ${chars.toLocaleString()} 字符` : '正在处理…'}</div>
                        <div className="mt-4 text-[11px] text-neutral-600">已用时 {formatTime(elapsed)}，请勿关闭窗口</div>
                    </div>
                )}
            </div>
        </div>
    );
};
