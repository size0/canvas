import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function loadIsolatedConfig(initialConfig = {}, env = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magicalcanvas-config-'));
    fs.writeFileSync(
        path.join(dir, 'twitcanva-config.json'),
        JSON.stringify(initialConfig),
        'utf8'
    );

    const previous = {
        CONFIG_DIR: process.env.CONFIG_DIR,
        TEXT_API_KEY: process.env.TEXT_API_KEY,
        TEXT_MODEL: process.env.TEXT_MODEL,
    };

    process.env.CONFIG_DIR = dir;
    for (const [key, value] of Object.entries(env)) {
        process.env[key] = value;
    }

    const module = await import(`./config.js?test=${Date.now()}-${Math.random()}`);

    return {
        dir,
        module,
        restore() {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

test('environment values take precedence over writable config values', async () => {
    const fixture = await loadIsolatedConfig(
        { TEXT_API_KEY: 'stored-secret', TEXT_MODEL: 'stored-model' },
        { TEXT_API_KEY: 'environment-secret', TEXT_MODEL: 'environment-model' }
    );
    try {
        assert.equal(fixture.module.getKey('TEXT_API_KEY'), 'environment-secret');
        assert.equal(fixture.module.getKey('TEXT_MODEL'), 'environment-model');
    } finally {
        fixture.restore();
    }
});

test('public settings expose secret presence but never secret values', async () => {
    const fixture = await loadIsolatedConfig(
        { TEXT_MODEL: 'stored-model' },
        { TEXT_API_KEY: 'environment-secret' }
    );
    try {
        const publicSettings = fixture.module.getPublicSettings();
        const secretStatus = fixture.module.getSecretStatus();

        assert.equal(publicSettings.TEXT_MODEL, 'stored-model');
        assert.equal(Object.hasOwn(publicSettings, 'TEXT_API_KEY'), false);
        assert.equal(secretStatus.TEXT_API_KEY, true);
        assert.equal(JSON.stringify({ publicSettings, secretStatus }).includes('environment-secret'), false);
    } finally {
        fixture.restore();
    }
});

test('saving settings ignores submitted secrets and removes persisted secrets', async () => {
    const fixture = await loadIsolatedConfig({
        TEXT_API_KEY: 'legacy-secret',
        TEXT_MODEL: 'old-model',
    });
    try {
        fixture.module.saveConfig({
            TEXT_API_KEY: 'attacker-controlled-secret',
            TEXT_MODEL: 'new-model',
        });

        const saved = JSON.parse(
            fs.readFileSync(path.join(fixture.dir, 'twitcanva-config.json'), 'utf8')
        );
        assert.equal(saved.TEXT_MODEL, 'new-model');
        assert.equal(Object.hasOwn(saved, 'TEXT_API_KEY'), false);
    } finally {
        fixture.restore();
    }
});
