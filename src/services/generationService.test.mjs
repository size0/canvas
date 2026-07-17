import assert from 'node:assert/strict';
import test from 'node:test';

import { generateVideo } from './generationService.ts';

test('normalizes a saved mixed-contract node at the final request boundary', async () => {
  const originalFetch = global.fetch;
  let sentBody;

  global.fetch = async (_url, options = {}) => {
    sentBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ resultUrl: '/library/videos/test.mp4' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const resultUrl = await generateVideo({
      prompt: 'product video',
      duration: 15,
      resolution: '1K',
      videoModel: 'xai/grok-imagine-video',
      referenceImages: ['/library/images/board.png', 'https://img.example/product.webp'],
      nodeId: 'saved-node',
    });

    assert.equal(resultUrl, '/library/videos/test.mp4');
    assert.equal(sentBody.duration, 10);
    assert.equal(sentBody.resolution, '720p');
    assert.equal(sentBody.videoModel, 'grok-imagine-video');
    assert.deepEqual(sentBody.referenceImages, [
      '/library/images/board.png',
      'https://img.example/product.webp',
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('keeps valid video duration and resolution values unchanged', async () => {
  const originalFetch = global.fetch;
  let sentBody;

  global.fetch = async (_url, options = {}) => {
    sentBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ resultUrl: '/library/videos/test.mp4' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await generateVideo({
      prompt: 'product video',
      duration: 20,
      resolution: '1080p',
      videoModel: 'grok-imagine-video',
    });

    assert.equal(sentBody.duration, 20);
    assert.equal(sentBody.resolution, '1080p');
  } finally {
    global.fetch = originalFetch;
  }
});

test('uses the documented duration set for Sora requests', async () => {
  const originalFetch = global.fetch;
  let sentBody;

  global.fetch = async (_url, options = {}) => {
    sentBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ resultUrl: '/library/videos/test.mp4' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await generateVideo({
      prompt: 'sora video',
      duration: 10,
      resolution: '720p',
      videoModel: 'sora',
    });

    assert.equal(sentBody.duration, 8);
  } finally {
    global.fetch = originalFetch;
  }
});

test('recovers a completed backend video after the Vercel proxy request fails', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return new Response('An error occurred while proxying the request', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    return new Response(JSON.stringify({
      status: 'success',
      resultUrl: '/library/videos/recovered.mp4',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const resultUrl = await generateVideo({
      prompt: 'slow product video',
      duration: 10,
      nodeId: 'slow-node',
    });

    assert.equal(resultUrl, '/library/videos/recovered.mp4');
    assert.deepEqual(calls, [
      '/api/generate-video',
      '/api/generation-status/slow-node',
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});
test('surfaces a plain-text proxy error instead of hiding it behind the status text', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => new Response('An error occurred while proxying the request', {
    status: 502,
    statusText: 'Bad Gateway',
    headers: { 'Content-Type': 'text/plain' },
  });

  try {
    await assert.rejects(
      generateVideo({ prompt: 'product video', duration: 10 }),
      /An error occurred while proxying the request/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});