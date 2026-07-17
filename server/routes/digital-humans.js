/**
 * 数字人资产库 CRUD
 * 文件：library/assets/Digital Human/
 * 元数据：library/assets/digital-humans.json
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const router = express.Router();
const CATEGORY = 'Digital Human';

function libraryAssetsDir(req) {
    return req.app.locals.LIBRARY_ASSETS_DIR
        || path.join(req.app.locals.LIBRARY_DIR || path.join(process.cwd(), 'library'), 'assets');
}

function indexPath(req) {
    return path.join(libraryAssetsDir(req), 'digital-humans.json');
}

function categoryDir(req) {
    return path.join(libraryAssetsDir(req), CATEGORY);
}

function loadIndex(req) {
    try {
        const p = indexPath(req);
        if (!fs.existsSync(p)) return [];
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function saveIndex(req, list) {
    const dir = libraryAssetsDir(req);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(indexPath(req), JSON.stringify(list, null, 2));
}

function ensureCategoryListed(req) {
    // 把 Digital Human 写入素材分类列表，便于通用素材面板也能看到
    try {
        const assetsDir = libraryAssetsDir(req);
        const categoriesPath = path.join(assetsDir, 'categories.json');
        let list = ['Character', 'Scene', 'Item', 'Style', 'Sound Effect', 'Others', CATEGORY];
        if (fs.existsSync(categoriesPath)) {
            const parsed = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));
            if (Array.isArray(parsed?.all)) list = parsed.all;
            else if (Array.isArray(parsed)) list = [...parsed];
        }
        if (!list.includes(CATEGORY)) {
            list.push(CATEGORY);
            fs.writeFileSync(categoriesPath, JSON.stringify({ all: list }, null, 2));
        }
    } catch {
        /* ignore */
    }
}

function mimeToExt(mime) {
    const map = {
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/gif': '.gif',
    };
    return map[mime] || '.png';
}

/** 将 data URL 或已有 /library 路径落盘到 Digital Human 目录，返回公开 URL */
function persistImage(req, sourceUrl, id, index) {
    const dir = categoryDir(req);
    fs.mkdirSync(dir, { recursive: true });

    if (!sourceUrl) return null;

    // 已是本库路径
    if (typeof sourceUrl === 'string' && sourceUrl.startsWith('/library/assets/')) {
        return sourceUrl.split('?')[0];
    }

    if (typeof sourceUrl === 'string' && sourceUrl.startsWith('data:')) {
        const matches = sourceUrl.match(/^data:([A-Za-z0-9.+/-]+);base64,(.+)$/);
        if (!matches) throw new Error('Invalid data URL');
        const ext = mimeToExt(matches[1]);
        const filename = `${id}_${index}${ext}`;
        const dest = path.join(dir, filename);
        fs.writeFileSync(dest, Buffer.from(matches[2], 'base64'));
        return `/library/assets/${CATEGORY}/${filename}`;
    }

    // 本地生成图 / 其它 library 路径
    if (typeof sourceUrl === 'string') {
        let cleanUrl = sourceUrl;
        try {
            if (sourceUrl.startsWith('http')) cleanUrl = new URL(sourceUrl).pathname;
        } catch { /* keep */ }
        cleanUrl = decodeURIComponent(cleanUrl.split('?')[0]);
        const libraryDir = req.app.locals.LIBRARY_DIR || path.join(process.cwd(), 'library');
        let sourcePath = null;
        if (cleanUrl.startsWith('/library/images/')) {
            sourcePath = path.join(libraryDir, 'images', cleanUrl.replace('/library/images/', ''));
        } else if (cleanUrl.startsWith('/library/assets/')) {
            sourcePath = path.join(libraryDir, 'assets', cleanUrl.replace('/library/assets/', ''));
        }
        if (sourcePath && fs.existsSync(sourcePath)) {
            const ext = path.extname(sourcePath) || '.png';
            const filename = `${id}_${index}${ext}`;
            const dest = path.join(dir, filename);
            fs.copyFileSync(sourcePath, dest);
            return `/library/assets/${CATEGORY}/${filename}`;
        }
    }

    // 外部 http(s) URL：直接保存引用（生图侧可拉公网 URL）
    if (typeof sourceUrl === 'string' && /^https?:\/\//i.test(sourceUrl)) {
        return sourceUrl;
    }

    throw new Error('无法保存数字人参考图');
}

router.get('/', (req, res) => {
    try {
        const list = loadIndex(req).sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
        res.json(list);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/:id', (req, res) => {
    const item = loadIndex(req).find(h => h.id === req.params.id);
    if (!item) return res.status(404).json({ error: '数字人不存在' });
    res.json(item);
});

router.post('/', (req, res) => {
    try {
        const body = req.body || {};
        const name = String(body.name || '').trim().slice(0, 80) || '未命名数字人';
        const rawImages = Array.isArray(body.referenceImages) ? body.referenceImages : [];
        const cover = body.coverUrl || rawImages[0];
        if (!cover && rawImages.length === 0) {
            return res.status(400).json({ error: '请至少上传一张数字人参考图' });
        }

        ensureCategoryListed(req);
        const id = crypto.randomUUID();
        const sources = Array.from(new Set([cover, ...rawImages].filter(Boolean))).slice(0, 4);
        const referenceImages = sources.map((url, index) => persistImage(req, url, id, index));
        const now = new Date().toISOString();
        const tags = Array.isArray(body.tags)
            ? body.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 12)
            : [];
        // 童装等行业可标记 defaultFor: ['kids']，一键成片切到童装模板时自动选用
        let defaultFor = Array.isArray(body.defaultFor)
            ? body.defaultFor.map(t => String(t).trim()).filter(Boolean).slice(0, 8)
            : [];
        if (body.setKidsDefault === true || tags.includes('童装默认')) {
            if (!defaultFor.includes('kids')) defaultFor.push('kids');
            if (!tags.includes('童装默认')) tags.push('童装默认');
        }

        const list = loadIndex(req);
        // 童装默认同一时间只保留一个
        if (defaultFor.includes('kids')) {
            for (const item of list) {
                if (Array.isArray(item.defaultFor) && item.defaultFor.includes('kids')) {
                    item.defaultFor = item.defaultFor.filter(x => x !== 'kids');
                    item.tags = Array.isArray(item.tags) ? item.tags.filter(t => t !== '童装默认') : [];
                    item.updatedAt = now;
                }
            }
        }

        const entry = {
            id,
            name,
            coverUrl: referenceImages[0],
            referenceImages,
            identityAnchor: String(body.identityAnchor || '').trim().slice(0, 800)
                || `${name}，五官、发型、肤色、体态与气质严格以参考图为准，全片同一人物身份，禁止另造脸`,
            tags,
            defaultFor,
            createdAt: now,
            updatedAt: now,
        };

        list.push(entry);
        saveIndex(req, list);

        // 同步一条到 assets.json，方便通用素材库展示
        try {
            const assetsJson = path.join(libraryAssetsDir(req), 'assets.json');
            let assets = [];
            if (fs.existsSync(assetsJson)) assets = JSON.parse(fs.readFileSync(assetsJson, 'utf8'));
            if (!Array.isArray(assets)) assets = [];
            assets.push({
                id: entry.id,
                name: entry.name,
                category: CATEGORY,
                url: entry.coverUrl,
                type: 'image',
                createdAt: entry.createdAt,
                digitalHuman: true,
                referenceImages: entry.referenceImages,
                identityAnchor: entry.identityAnchor,
                tags: entry.tags,
            });
            fs.writeFileSync(assetsJson, JSON.stringify(assets, null, 2));
        } catch {
            /* optional sync */
        }

        res.status(201).json(entry);
    } catch (error) {
        console.error('[digital-humans] create error:', error);
        res.status(500).json({ error: error.message || '创建数字人失败' });
    }
});

router.patch('/:id', (req, res) => {
    try {
        const list = loadIndex(req);
        const index = list.findIndex(h => h.id === req.params.id);
        if (index < 0) return res.status(404).json({ error: '数字人不存在' });

        const body = req.body || {};
        const current = list[index];
        const now = new Date().toISOString();
        if (body.name != null) current.name = String(body.name).trim().slice(0, 80) || current.name;
        if (body.identityAnchor != null) current.identityAnchor = String(body.identityAnchor).trim().slice(0, 800);
        if (Array.isArray(body.tags)) {
            current.tags = body.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 12);
        }
        if (Array.isArray(body.defaultFor)) {
            current.defaultFor = body.defaultFor.map(t => String(t).trim()).filter(Boolean).slice(0, 8);
        }
        // 设为 / 取消 童装默认数字人（全库唯一）
        if (body.setKidsDefault === true) {
            for (const item of list) {
                item.defaultFor = Array.isArray(item.defaultFor) ? item.defaultFor.filter(x => x !== 'kids') : [];
                item.tags = Array.isArray(item.tags) ? item.tags.filter(t => t !== '童装默认') : [];
                item.updatedAt = now;
            }
            current.defaultFor = [...(current.defaultFor || []).filter(x => x !== 'kids'), 'kids'];
            current.tags = [...(current.tags || []).filter(t => t !== '童装默认'), '童装默认'];
        } else if (body.setKidsDefault === false) {
            current.defaultFor = (current.defaultFor || []).filter(x => x !== 'kids');
            current.tags = (current.tags || []).filter(t => t !== '童装默认');
        }
        // 追加参考图（最多 4 张，不覆盖已有）
        if (Array.isArray(body.appendReferenceImages) && body.appendReferenceImages.length) {
            const existing = Array.isArray(current.referenceImages) ? current.referenceImages.filter(Boolean) : [];
            const room = Math.max(0, 4 - existing.length);
            if (room === 0) {
                return res.status(400).json({ error: '该数字人已有 4 张参考图，无法再追加' });
            }
            const toAdd = body.appendReferenceImages.filter(Boolean).slice(0, room).map((url, i) => {
                try {
                    return persistImage(req, url, current.id, `a${Date.now()}_${i}`);
                } catch {
                    return url;
                }
            });
            current.referenceImages = [...existing, ...toAdd].slice(0, 4);
            if (!current.coverUrl) current.coverUrl = current.referenceImages[0];
        } else if (Array.isArray(body.referenceImages) && body.referenceImages.length) {
            // 全量替换参考图（最多 4 张）
            const sources = body.referenceImages.filter(Boolean).slice(0, 4);
            current.referenceImages = sources.map((url, i) => {
                try {
                    return persistImage(req, url, current.id, `${Date.now()}_${i}`);
                } catch {
                    return url;
                }
            });
            current.coverUrl = current.referenceImages[0];
        }
        current.updatedAt = now;
        list[index] = current;
        saveIndex(req, list);
        res.json(current);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/:id', (req, res) => {
    try {
        const list = loadIndex(req);
        const item = list.find(h => h.id === req.params.id);
        if (!item) return res.status(404).json({ error: '数字人不存在' });

        const next = list.filter(h => h.id !== req.params.id);
        saveIndex(req, next);

        // 尝试删除文件
        for (const url of item.referenceImages || []) {
            if (typeof url === 'string' && url.startsWith(`/library/assets/${CATEGORY}/`)) {
                const filePath = path.join(
                    libraryAssetsDir(req),
                    CATEGORY,
                    url.replace(`/library/assets/${CATEGORY}/`, ''),
                );
                try {
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                } catch { /* ignore */ }
            }
        }

        // 从 assets.json 移除
        try {
            const assetsJson = path.join(libraryAssetsDir(req), 'assets.json');
            if (fs.existsSync(assetsJson)) {
                let assets = JSON.parse(fs.readFileSync(assetsJson, 'utf8'));
                if (Array.isArray(assets)) {
                    assets = assets.filter(a => a.id !== item.id);
                    fs.writeFileSync(assetsJson, JSON.stringify(assets, null, 2));
                }
            }
        } catch { /* ignore */ }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
