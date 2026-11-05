const fs = require('fs');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

(async () => {
  const db = new DatabaseSync(':memory:');
  for (const file of fs.readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(`drizzle/${file}`, 'utf8').replaceAll('--> statement-breakpoint', ''));
  }

  let user = { userId: 'teacher', displayName: 'Teacher', email: 'teacher@test' };
  const files = new Map();
  globalThis.testEnv = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            const statement = db.prepare(sql);
            return {
              async first() { return statement.get(...args) || null; },
              async all() { return { results: statement.all(...args) }; },
              async run() { return statement.run(...args); },
            };
          },
        };
      },
    },
    BUCKET: {
      async put(key, body, options) { files.set(key, { body, httpMetadata: options.httpMetadata }); },
      async get(key) { return files.get(key); },
    },
  };
  globalThis.testUser = () => user;

  const source = fs.readFileSync('app/api/[...path]/route.ts', 'utf8')
    .replace("import { env } from 'cloudflare:workers';", 'const env=globalThis.testEnv;')
    .replace("import { getChatGPTUser } from '../../chatgpt-auth';", 'const getChatGPTUser=async()=>globalThis.testUser();');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const moduleObject = { exports: {} };
  new Function('exports', 'require', 'module', code)(moduleObject.exports, require, moduleObject);
  const { GET, POST } = moduleObject.exports;
  let checks = 0;

  async function request(path, body, status = 200) {
    const response = await (body === undefined ? GET : POST)(new Request(`https://test/api/${path}`,
      body === undefined ? {} : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
    assert.equal(response.status, status, path);
    checks += 1;
    return response.json();
  }

  async function upload(path, data, status = 200) {
    const response = await POST(new Request(`https://test/api/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'video/webm' },
      body: data,
    }));
    assert.equal(response.status, status, path);
    checks += 1;
    return response.json();
  }

  user = null;
  await request('exams', undefined, 401);
  user = { userId: 'teacher' };
  await request('exams', { title: '', minutes: 30, questions: [] }, 400);
  const created = await request('exams', {
    title: 'Test',
    minutes: 10,
    questions: [{ text: '2+2?', options: ['1', '2', '3', '4'], correct: 3 }],
  });
  assert.equal(created.code.length, 10);
  assert.equal((await request('exams')).length, 1);

  user = { userId: 'student' };
  assert.equal((await request('exams')).length, 0);
  const joined = await request('join', { code: created.code });
  assert.equal(joined.count, 1);
  assert.equal(joined.questions, undefined);
  await request('start', { exam: joined.id, name: 'Student' }, 400);
  const startBody = { exam: joined.id, name: 'Student', cameraConsent: true };
  const started = await request('start', startBody);
  assert.equal(started.questions[0].correct, undefined);
  const resumed = await request('start', startBody);
  assert.equal(resumed.id, started.id);
  await request(`attempt/${started.id}/answers`, { answers: { 0: 99 } }, 400);
  await request(`attempt/${started.id}/answers`, { answers: { 0: 3 } });
  await request(`attempt/${started.id}/event`, { type: 'tab hidden' });
  await request(`attempt/${started.id}/submit`, {}, 400);

  await upload(`attempt/${started.id}/record`, new Uint8Array([1, 2, 3]));
  const camera = await upload(`attempt/${started.id}/camera`, new Uint8Array([4, 5, 6]));
  assert.equal(camera.analysis.status, 'not_configured');
  assert.equal(files.has([...files.keys()].find(key => key.startsWith('camera/'))), true);
  globalThis.testEnv.PROCTORING_API_URL = 'https://model.example.org';
  globalThis.testEnv.PROCTORING_API_TOKEN = 'test-secret';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/analyze');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    return Response.json({
      status: 'analyzed',
      model_version: 'test-model',
      frames_analyzed: 3,
      review_flags: [
        { time_s: 2, label: 'cheating', confidence: 0.9 },
        { time_s: 3, label: 'normal', confidence: 0.99 },
        { time_s: 31, label: 'suspicious', confidence: 0.8 },
      ],
    });
  };
  const analyzed = await upload(`attempt/${started.id}/camera`, new Uint8Array([7, 8, 9]));
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  const unavailable = await upload(`attempt/${started.id}/camera`, new Uint8Array([10, 11, 12]));
  globalThis.fetch = originalFetch;
  assert.equal(analyzed.analysis.status, 'analyzed');
  assert.equal(analyzed.analysis.reviewFlags.length, 1);
  assert.equal(analyzed.analysis.reviewFlags[0].label, 'cheating');
  assert.equal(unavailable.analysis.status, 'model_unavailable');

  user = { userId: 'intruder' };
  await request(`results/${joined.id}`, undefined, 403);
  await request(`video/${started.id}/0`, undefined, 403);
  await request(`camera/${started.id}/0`, undefined, 403);
  await request(`attempt/${started.id}/answers`, { answers: {} }, 403);

  user = { userId: 'student' };
  const submitted = await request(`attempt/${started.id}/submit`, {});
  assert.equal(submitted.score, 1);
  await request('start', startBody, 409);

  user = { userId: 'teacher' };
  const results = await request(`results/${joined.id}`);
  assert.equal(results[0].score, 1);
  assert.equal(results[0].events.length, 1);
  assert.equal(results[0].recordings.length, 1);
  assert.equal(results[0].cameraRecordings.length, 3);
  assert.deepEqual(results[0].proctoringEvents.map(item => item.status), ['not_configured', 'analyzed', 'model_unavailable']);
  const screenVideo = await GET(new Request(`https://test/api/video/${started.id}/0`));
  assert.equal(screenVideo.status, 200);
  const cameraVideo = await GET(new Request(`https://test/api/camera/${started.id}/0`));
  assert.equal(cameraVideo.status, 200);
  checks += 2;

  console.log(`PASS: ${checks} API checks — auth, consent, recording, camera, analysis status, scoring and owner-only video access`);
  db.close();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
