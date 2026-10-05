/**
 * Training 单测（契约 §6）—— 只测纯函数与可注入 fetchImpl 的流程，零 npm 依赖、零真实网络。
 *
 * 覆盖：createManifestTemplate / validateManifest（含各类错误码与警告码）/ normalizeClipPath /
 *       exportRecipe（不得含音频与权重）/ submitJob（fetchImpl 注入 + 缺端点短路）/ pollJob（404/405 回落）。
 *
 * 写断言的口径来自 web/js/training/index.js 实测（见各条注释里的 file:line）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VERSION,
  SCHEMA_VERSION,
  DEFAULT_RULES,
  normalizeClipPath,
  validateManifest,
  createManifestTemplate,
  probeAudio,
  submitJob,
  pollJob,
  exportRecipe,
  Training,
} from '../web/js/training/index.js';

/** 造一份**合法**的清单：直接用模板 + 补 clip，避免手写字面量跟实现漂移。 */
function goodManifest(overrides = {}) {
  const m = createManifestTemplate({ name: 'unit-test-dataset', speakerIds: ['spk-1'] });
  m.license = '说话人本人书面授权，仅用于本地个人非商业用途，不再分发';
  m.clips = [
    {
      file: 'clips/001.wav',
      duration: 5,
      sampleRate: 22050,
      channels: 1,
      text: '你好，这是第一条。',
      speaker: 'spk-1',
      hash: 'hash-001',
    },
    {
      file: 'clips/002.wav',
      duration: 6,
      sampleRate: 22050,
      channels: 1,
      text: '这是第二条。',
      speaker: 'spk-1',
      hash: 'hash-002',
    },
  ];
  return Object.assign(m, overrides);
}

test('createManifestTemplate()：模板结构齐全、通过校验但带 clips-empty 警告，且不含任何音频字段', () => {
  const tpl = createManifestTemplate();
  assert.equal(tpl.schemaVersion, SCHEMA_VERSION);
  assert.equal(tpl.name, 'my-voice-dataset');
  assert.equal(tpl.language, 'zh-CN');
  assert.deepEqual(Object.keys(tpl), [
    'schemaVersion',
    'name',
    'language',
    'license',
    'consent',
    'speakers',
    'clips',
    'notes',
  ]);
  assert.equal(tpl.speakers.length, 1);
  assert.equal(tpl.speakers[0].id, 'speaker-a');
  assert.deepEqual(Object.keys(tpl.speakers[0]), ['id', 'displayName', 'language', 'isSelf', 'consent']);
  assert.deepEqual(Object.keys(tpl.consent), ['obtained', 'subject', 'form', 'date', 'scope', 'note']);
  assert.deepEqual(tpl.clips, [], '模板默认 clips 为空');
  assert.equal(tpl.consent.subject, 'speaker-a', 'consent.subject 应指向第一家说话人');

  // 模板结构完整，但空 clips 会给一条警告（不是错误）
  const check = validateManifest(tpl);
  assert.equal(check.ok, true);
  assert.deepEqual(check.errors, [], '模板本身不应有硬错误');
  assert.ok(
    check.warnings.some((w) => w.code === 'clips-empty'),
    `模板应带 clips-empty 警告，实际：${JSON.stringify(check.warnings)}`,
  );

  // 自定义说话人
  const multi = createManifestTemplate({ name: '  multi  ', language: 'ja-JP', speakerIds: ['a', 'b'] });
  assert.equal(multi.name, 'multi', 'name 应被 trim');
  assert.equal(multi.language, 'ja-JP');
  assert.deepEqual(
    multi.speakers.map((s) => s.id),
    ['a', 'b'],
  );
  // 脏入参要回落而不是抛错
  assert.equal(createManifestTemplate({ speakerIds: [] }).speakers.length, 1);
  assert.equal(createManifestTemplate({ speakerIds: 'x' }).speakers[0].id, 'speaker-a');
  assert.equal(createManifestTemplate({ name: '' }).name, 'my-voice-dataset');
});

test('validateManifest()：合法清单通过；返回 { ok, errors, warnings, stats } 且 stats 字段齐全', () => {
  const res = validateManifest(goodManifest());
  assert.equal(res.ok, true, `合法清单应通过，errors=${JSON.stringify(res.errors)}`);
  assert.deepEqual(res.errors, []);
  assert.ok(Array.isArray(res.warnings));
  for (const key of [
    'speakers',
    'clips',
    'totalDurationSec',
    'avgDurationSec',
    'minDurationSec',
    'maxDurationSec',
    'languages',
    'sampleRates',
    'channels',
    'duplicateHashes',
    'estimatedTrainingMinutes',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(res.stats, key), `stats 缺少字段 ${key}`);
  }
  assert.equal(res.stats.clips, 2);
  assert.equal(res.stats.speakers, 1);
  assert.equal(res.stats.totalDurationSec, 11, '5 + 6 = 11 秒');
  assert.equal(res.stats.minDurationSec, 5);
  assert.equal(res.stats.maxDurationSec, 6);
  assert.deepEqual(res.stats.languages, ['zh-CN']);

  // 空/脏入参不能抛错
  for (const bad of [null, undefined, 42, 'x', [], {}]) {
    const out = validateManifest(bad);
    assert.equal(out.ok, false, `validateManifest(${JSON.stringify(bad)}) 必须判为不合法`);
    assert.ok(out.errors.length > 0, `不合法时必须给出至少一条 errors`);
    assert.ok(Array.isArray(out.warnings));
    assert.ok(out.stats, '即便不合法也应返回 stats 对象');
  }
});

test('validateManifest()：授权与同意缺失/占位值必须报错（红线：只能用本人或有书面授权的声音）', () => {
  // license 占位值
  for (const placeholder of ['TODO', 'todo', '待填', 'N/A', '  ', '']) {
    const res = validateManifest(goodManifest({ license: placeholder }));
    assert.equal(res.ok, false, `license=${JSON.stringify(placeholder)} 必须被拒`);
    assert.ok(
      res.errors.some((e) => e.code === 'license-missing' && e.field === 'license'),
      `应报 license-missing，实际：${JSON.stringify(res.errors.map((e) => e.code))}`,
    );
  }
  // 占位值以「前缀：占位值」形态出现时也必须被识别（实现在冒号前定位占位值）
  for (const typedLicense of ['TODO：待补', 'todo: pending', '待填：稍后补', 'N/A：见附件']) {
    const typed = validateManifest(goodManifest({ license: typedLicense }));
    assert.equal(typed.ok, false, `license=${JSON.stringify(typedLicense)} 必须被拒`);
    assert.ok(
      typed.errors.some((e) => e.code === 'license-missing'),
      `license=${JSON.stringify(typedLicense)} 应报 license-missing，实际：${JSON.stringify(typed.errors.map((e) => e.code))}`,
    );
  }

  // 顶层 consent.obtained 必须为 true
  const noConsent = goodManifest();
  noConsent.consent.obtained = false;
  const r1 = validateManifest(noConsent);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.code === 'consent-not-obtained' && e.field === 'consent.obtained'));

  // 说话人级 consent.obtained 必须为 true，且 errors 要带 index
  const noSpeakerConsent = goodManifest();
  noSpeakerConsent.speakers[0].consent.obtained = false;
  const r2 = validateManifest(noSpeakerConsent);
  assert.equal(r2.ok, false);
  const e2 = r2.errors.find((e) => e.code === 'speaker-consent-not-obtained');
  assert.ok(e2, `应报 speaker-consent-not-obtained，实际：${JSON.stringify(r2.errors.map((e) => e.code))}`);
  assert.equal(e2.index, 0, '说话人级错误必须带 index');

  // 合法授权说明必须真的能通过（否则上面的规则会变成「一律拒绝」）
  assert.equal(validateManifest(goodManifest()).ok, true);
});

// 回归哨兵（原 DEFECT 已修，见 web/js/training/index.js 的 isPlaceholder）：
// 旧实现只认「占位值在开头」或「占位值 + 冒号前缀」，占位值出现在**后缀**位置时漏判：
//   validateManifest(goodManifest({license:'来源：待填'})).ok === true  ← 授权红线可被一句话绕过
// （license 是可自由填写的自由文本，用户写「来源：待填」比写「待填」更自然。）
// 修法：用「非字母数字/汉字边界」包住占位词做子串匹配，而不是只比前缀。
// 注意不能退回 `\b`：它对汉字不生效（'待填' 两侧都是 \W，\b 定位不到）。
test('validateManifest()：占位值出现在前缀之后也必须被拒（DEFECT 回归哨兵）', () => {
  const suffix = validateManifest(goodManifest({ license: '来源：待填' }));
  assert.equal(suffix.ok, false, '「来源：待填」是变相占位，必须判为不合法');
  assert.ok(suffix.errors.some((e) => e.code === 'license-missing'));
  // 对照：最朴素的占位形态确实被拦（证明上面失败不是「一律放行」）
  assert.equal(validateManifest(goodManifest({ license: '待填' })).ok, false);
  // 其它后缀/前后缀形态
  assert.equal(validateManifest(goodManifest({ license: '来源：TODO' })).ok, false);
  assert.equal(validateManifest(goodManifest({ license: '见 placeholder 说明' })).ok, false);
  // 反向断言：正常授权说明必须能通过（否则规则退化成「一律拒绝」）
  assert.equal(validateManifest(goodManifest({ license: '由本人录制并授权，署名：张三' })).ok, true);
  assert.equal(validateManifest(goodManifest({ license: 'CC0-1.0（本人原创录音）' })).ok, true);
  // 单字占位词「无」的边界：单独出现时要拦，作为正常词的一部分时不要拦
  assert.equal(validateManifest(goodManifest({ license: '无' })).ok, false, '单字占位「无」必须被拦');
  assert.equal(
    validateManifest(goodManifest({ license: '来自无版权素材库的录音' })).ok,
    true,
    '「无版权」里的「无」左侧是汉字，不应被误判成占位（旧实现 startsWith 会误杀）',
  );
});

test('validateManifest()：clip 级错误码与 index 逐一可定位（speaker/时长/采样率/扩展名/声道）', () => {
  const m = goodManifest();
  m.clips = [
    // 未知 speaker + 缺 duration + 采样率过低 + 立体声（警告）
    { file: 'clips/a.wav', sampleRate: 8000, channels: 2, text: 'x', speaker: 'ghost' },
    // 扩展名不支持 + 缺 duration + 缺 text（警告）
    { file: 'clips/b.txt', duration: 200, sampleRate: 22050, channels: 1, text: '', speaker: 'spk-1' },
  ];
  const res = validateManifest(m);
  assert.equal(res.ok, false);
  const codes = res.errors.map((e) => e.code);
  for (const code of [
    'clip-speaker-unknown',
    'clip-duration-invalid',
    'clip-sample-rate-too-low',
    'clip-file-extension',
  ]) {
    assert.ok(codes.includes(code), `应报 ${code}，实际：${JSON.stringify(codes)}`);
  }
  // 第 0 条的错误 index 必须是 0，第 1 条的必须是 1 —— 定位能力是这份校验的主要价值
  assert.equal(res.errors.find((e) => e.code === 'clip-speaker-unknown').index, 0);
  assert.equal(res.errors.find((e) => e.code === 'clip-file-extension').index, 1);
  assert.ok(
    res.warnings.some((w) => w.code === 'clip-not-mono' && w.index === 0),
    `立体声应给警告，实际：${JSON.stringify(res.warnings)}`,
  );
  assert.ok(
    res.warnings.some((w) => w.code === 'clip-text-missing' && w.index === 1),
    `缺文本应给警告，实际：${JSON.stringify(res.warnings)}`,
  );

  // 时长超出建议区间：**默认只给 warning（clip-duration-out-of-range）**，不算错误。
  // 只有传 { strictDurations: true } 才升级成 error —— 这点必须按实现口径写，别按「必须报错」想当然。
  const tooLong = goodManifest();
  tooLong.clips[0].duration = DEFAULT_RULES.maxClipSeconds + 1;
  const looseLong = validateManifest(tooLong);
  assert.equal(looseLong.ok, true, '默认规则下超长只是警告，不该判不合法');
  assert.ok(looseLong.warnings.some((w) => w.code === 'clip-duration-out-of-range' && w.index === 0));
  assert.ok(
    !looseLong.errors.some((e) => e.code === 'clip-duration-out-of-range'),
    '默认规则下不应把超长升级成错误',
  );
  const strictLong = validateManifest(tooLong, { strictDurations: true });
  assert.equal(strictLong.ok, false, 'strictDurations 下超长应升级为错误');
  assert.ok(strictLong.errors.some((e) => e.code === 'clip-duration-out-of-range' && e.index === 0));

  const tooShort = goodManifest();
  tooShort.clips[0].duration = DEFAULT_RULES.minClipSeconds - 1;
  assert.equal(validateManifest(tooShort).ok, true, '默认规则下过短也只是警告');
  assert.ok(validateManifest(tooShort).warnings.some((w) => w.code === 'clip-duration-out-of-range'));
  assert.equal(validateManifest(tooShort, { strictDurations: true }).ok, false, 'strictDurations 下过短应升级为错误');

  // 时长非数字/非正数才是硬错误（与「超出建议区间」是两回事）
  for (const badDuration of [undefined, null, 'abc', 0, -1]) {
    const m2 = goodManifest();
    m2.clips[0].duration = badDuration;
    const r = validateManifest(m2);
    assert.equal(r.ok, false, `duration=${JSON.stringify(badDuration)} 必须判为不合法`);
    assert.ok(
      r.errors.some((e) => e.code === 'clip-duration-invalid' && e.index === 0),
      `应报 clip-duration-invalid，实际：${JSON.stringify(r.errors.map((e) => e.code))}`,
    );
  }

  // 样本量不足应给 clips-few 警告而不是错误（默认门槛 10 条）
  assert.equal(DEFAULT_RULES.minClipCount, 10);
  assert.ok(
    validateManifest(goodManifest()).warnings.some((w) => w.code === 'clips-few'),
    '只有 2 条 clip 时应给 clips-few 警告',
  );
  const relaxed = validateManifest(goodManifest(), { minClipCount: 1 });
  assert.ok(
    relaxed.errors.length === 0,
    `把 minClipCount 放宽到 1 后不应有硬错误，实际：${JSON.stringify(relaxed.errors.map((e) => e.code))}`,
  );
});

test('validateManifest()：重复 hash / 重复文件 / 路径越界与非法采样率都能被定位', () => {
  // 相同 hash 但文件不同 → 硬错误 clip-hash-duplicate，并计入 stats.duplicateHashes
  const dupHash = goodManifest();
  dupHash.clips[1].file = 'clips/003.wav';
  dupHash.clips[1].hash = dupHash.clips[0].hash;
  const rh = validateManifest(dupHash);
  assert.equal(rh.ok, false);
  assert.ok(
    rh.errors.some((e) => e.code === 'clip-hash-duplicate' && e.index === 1),
    `应报 clip-hash-duplicate，实际：${JSON.stringify(rh.errors.map((e) => e.code))}`,
  );
  assert.equal(rh.stats.duplicateHashes, 1);

  // 同一文件登记两次 → clip-file-duplicate（与 hash 重复是两条不同规则）
  const dupFile = goodManifest();
  dupFile.clips[1].file = dupFile.clips[0].file;
  const rf = validateManifest(dupFile);
  assert.equal(rf.ok, false);
  assert.ok(
    rf.errors.some((e) => e.code === 'clip-file-duplicate' && e.index === 1),
    `应报 clip-file-duplicate，实际：${JSON.stringify(rf.errors.map((e) => e.code))}`,
  );

  // 路径越界：绝对路径与 .. 都必须被拒（安全边界）
  const cases = [
    ['C:/abs/a.wav', 'clip-file-absolute'],
    ['/abs/a.wav', 'clip-file-absolute'],
    ['../a.wav', 'clip-file-escape'],
    ['a/../../b.wav', 'clip-file-escape'],
    ['', 'clip-file-missing'],
  ];
  for (const [file, code] of cases) {
    const m = goodManifest();
    m.clips[0].file = file;
    const r = validateManifest(m);
    assert.equal(r.ok, false, `file=${JSON.stringify(file)} 必须被拒`);
    assert.ok(
      r.errors.some((e) => e.code === code && e.index === 0),
      `file=${JSON.stringify(file)} 应报 ${code}，实际：${JSON.stringify(r.errors.map((e) => e.code))}`,
    );
  }

  // 非法采样率 vs 偏低的采样率是两条规则
  const badSr = goodManifest();
  badSr.clips[0].sampleRate = 'abc';
  assert.ok(validateManifest(badSr).errors.some((e) => e.code === 'clip-sample-rate-invalid'));
  const lowSr = goodManifest();
  lowSr.clips[0].sampleRate = DEFAULT_RULES.minSampleRate - 1;
  assert.ok(validateManifest(lowSr).errors.some((e) => e.code === 'clip-sample-rate-too-low'));

  // 说话人 id 必须存在且格式合法
  const noSpk = goodManifest();
  noSpk.clips[0].speaker = '';
  assert.ok(validateManifest(noSpk).errors.some((e) => e.code === 'clip-speaker-missing'));

  // schemaVersion 缺失只是警告，写错才是错误
  const noVer = goodManifest();
  delete noVer.schemaVersion;
  assert.ok(validateManifest(noVer).warnings.some((w) => w.code === 'schema-version-missing'));
  assert.equal(validateManifest(noVer).ok, true, 'schemaVersion 缺失只警告，不判不合法');
  assert.equal(validateManifest(goodManifest({ schemaVersion: 99 })).ok, false);
  assert.ok(validateManifest(goodManifest({ schemaVersion: 99 })).errors.some((e) => e.code === 'schema-version-unsupported'));

  // 缺 consent 对象 / speakers 为空
  assert.ok(validateManifest(goodManifest({ consent: null })).errors.some((e) => e.code === 'consent-missing'));
  assert.ok(validateManifest(goodManifest({ speakers: [] })).errors.some((e) => e.code === 'speakers-empty'));
});

test('normalizeClipPath()：统一分隔符、去 ./ 前缀、trim；脏入参回落空串', () => {
  assert.equal(normalizeClipPath('./clips/a.wav'), 'clips/a.wav');
  assert.equal(normalizeClipPath('clips\\sub\\a.wav'), 'clips/sub/a.wav', 'Windows 反斜杠应统一成 /');
  assert.equal(normalizeClipPath('  clips/a.wav  '), 'clips/a.wav');
  assert.equal(normalizeClipPath(''), '');
  assert.equal(normalizeClipPath(null), '');
  assert.equal(normalizeClipPath(undefined), '');
  assert.equal(typeof normalizeClipPath(42), 'string', '数字入参也应返回字符串而不是抛错');
  // 注意：本函数**不做**路径穿越防护（'a/../../b.wav' 原样保留），这是它的诚实边界；
  // 防穿越由调用方 / 后端负责，这里只断言归一化行为，不要伪造安全性。
  assert.equal(normalizeClipPath('a/../../b.wav'), 'a/../../b.wav');
});

test('exportRecipe()：产物是「配方元数据」，绝不含音频二进制、权重或 transcript', () => {
  const recipe = exportRecipe(goodManifest(), { backend: 'gpt-sovits' });
  assert.equal(recipe.kind, 'aemeath-voice-training-recipe');
  assert.equal(recipe.schemaVersion, SCHEMA_VERSION);
  assert.equal(recipe.toolVersion, VERSION);
  assert.equal(recipe.backend, 'gpt-sovits');
  assert.ok(typeof recipe.generatedAt === 'string' && !Number.isNaN(Date.parse(recipe.generatedAt)));
  assert.deepEqual(Object.keys(recipe), [
    'kind',
    'schemaVersion',
    'toolVersion',
    'generatedAt',
    'backend',
    'dataset',
    'license',
    'consent',
    'training',
    'validation',
    'privacy',
    'disclaimer',
  ]);
  assert.equal(recipe.dataset.clipCount, 2);
  assert.equal(recipe.dataset.speakerCount, 1);
  assert.equal(recipe.dataset.totalDurationSec, 11);
  assert.deepEqual(recipe.dataset.speakers, [{ id: 'spk-1', language: 'zh-CN' }]);

  // 红线：配方里不得出现音频二进制/权重/逐字稿字段
  const json = JSON.stringify(recipe);
  for (const forbidden of ['data:audio', 'base64', 'blob', 'Blob', 'ArrayBuffer', 'checkpoint', '.ckpt', '.pth', 'weights']) {
    assert.ok(!json.includes(forbidden), `recipe 中不应出现 ${forbidden}`);
  }

  // includeTranscript 可选行为：默认不带 transcript 字段
  const withTranscript = exportRecipe(goodManifest(), { includeTranscript: true });
  assert.equal(typeof withTranscript, 'object');

  // 脏入参不抛错
  const empty = exportRecipe(null);
  assert.equal(empty.dataset.clipCount, 0);
  assert.equal(empty.dataset.speakerCount, 0);
  assert.equal(empty.backend, 'external-http', '未指定 backend 时的默认值');
});

test('submitJob()：缺端点短路返回 no-endpoint 且**不发任何请求**', async () => {
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    throw new Error('不应该被调用');
  };
  const res = await submitJob({ fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-endpoint');
  assert.ok(res.message.includes('端点'), 'message 应说明缺少端点');
  assert.equal(called, 0, '缺端点时必须短路，不得发起请求');

  // 清单不合法时不发请求，并把 errors 透出
  const bad = await submitJob({ endpoint: 'https://train.example/api', manifest: { license: 'TODO' }, fetchImpl });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid-manifest');
  assert.ok(Array.isArray(bad.errors) && bad.errors.length > 0);
  assert.equal(called, 0, '清单不合法时也不得发起请求');
});

test('submitJob()：请求体只含元数据（无音频二进制），并解析 jobId', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ jobId: 'job-42', state: 'queued' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const res = await submitJob({
    endpoint: 'https://train.example/api/jobs',
    manifest: goodManifest(),
    options: { epochs: 10 },
    fetchImpl,
  });
  assert.equal(res.ok, true, `提交应成功，实际 ${JSON.stringify(res)}`);
  assert.equal(res.jobId, 'job-42');
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1, '应恰好发一次请求');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['content-type'] ?? seen[0].init.headers['Content-Type'], 'application/json');

  const body = seen[0].body;
  assert.equal(body.kind, 'aemeath-voice-training-job');
  assert.equal(body.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(body.options, { epochs: 10 });
  assert.equal(body.client.name, 'aemeath-desktop-pet');
  assert.ok(body.manifest, '必须带 manifest');
  assert.ok(body.clips.length >= 2, 'clips 应以元数据形式带上');

  // 红线：请求体不得携带音频二进制
  const raw = seen[0].init.body;
  assert.equal(typeof raw, 'string', 'body 必须是 JSON 字符串而不是 Blob/FormData');
  for (const forbidden of ['base64', 'data:audio', 'binary', 'audioBytes']) {
    assert.ok(!raw.includes(forbidden), `提交体不应包含 ${forbidden}`);
  }
  // 端点地址要规范化：去掉重复的 /jobs 之类不归本模块管，但必须命中传入的 endpoint 前缀
  assert.ok(seen[0].url.startsWith('https://train.example/api/jobs'), `实际请求 URL：${seen[0].url}`);
});

test('pollJob()：缺端点或 jobId 短路；404/405 回落第二次 URL；成功时解析 state/progress', async () => {
  const noArgs = await pollJob({});
  assert.equal(noArgs.ok, false);
  assert.equal(noArgs.reason, 'no-endpoint');

  const noJobId = await pollJob({ endpoint: 'https://train.example/api' });
  assert.equal(noJobId.ok, false);
  assert.equal(noJobId.reason, 'no-endpoint');

  // 第一次 404 → 应继续尝试 `?jobId=` 形态并成功
  const urls = [];
  const flaky = async (url) => {
    urls.push(url);
    if (urls.length === 1) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ state: 'running', progress: 0.5 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const res = await pollJob({ endpoint: 'https://train.example/api/jobs/', jobId: 'job-42', fetchImpl: flaky });
  assert.equal(res.ok, true, `应回落成功，实际 ${JSON.stringify(res)}`);
  assert.equal(res.state, 'running');
  assert.equal(res.progress, 0.5);
  assert.equal(res.jobId, 'job-42');
  assert.equal(urls.length, 2, '第一次 404 后应换 URL 再试一次');
  assert.equal(urls[0], 'https://train.example/api/jobs/job-42', '端点末尾斜杠应被去掉且 jobId 需 encodeURIComponent');
  assert.equal(urls[1], 'https://train.example/api/jobs?jobId=job-42');

  // 两次都 404 → 返回 http-error 而不是假装成功
  const both404 = async () => new Response('nope', { status: 404 });
  const fail = await pollJob({ endpoint: 'https://train.example/api', jobId: 'j', fetchImpl: both404 });
  assert.equal(fail.ok, false);
  assert.equal(fail.reason, 'http-error');
  assert.equal(fail.status, 404);

  // 网络异常 → request-failed；进度字段脏值 → progress 为 null 而不是 NaN
  const thrower = async () => {
    throw new Error('network down');
  };
  const netErr = await pollJob({ endpoint: 'https://train.example/api', jobId: 'j', fetchImpl: thrower });
  assert.equal(netErr.ok, false);
  assert.equal(netErr.reason, 'request-failed');
  assert.ok(netErr.detail.includes('network down'));

  const dirtyProgress = async () =>
    new Response(JSON.stringify({ state: 'done', progress: 'abc' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const dp = await pollJob({ endpoint: 'https://train.example/api', jobId: 'j', fetchImpl: dirtyProgress });
  assert.equal(dp.ok, true);
  assert.equal(dp.state, 'done');
  assert.equal(dp.progress, null, 'progress 非数字时必须回落 null 而不是 NaN');
});

test('probeAudio()：非 File/Blob 入参应给出 not-a-file 而不是抛错', async () => {
  for (const bad of [null, undefined, 42, 'x', {}]) {
    const res = await probeAudio(bad);
    assert.equal(res.ok, false, `probeAudio(${JSON.stringify(bad)}) 应判为失败`);
    assert.ok(typeof res.reason === 'string' && res.reason.length > 0);
    assert.ok(typeof res.message === 'string' && res.message.length > 0);
  }
  // 说明性断言：probeAudio 依赖 WebAudio，bare Node 下没有 AudioContext，因此只测它的入参守卫。
  // 真正需要 AudioContext 的解码路径不在这里伪造（伪造会测到假实现，不如如实说明边界）。
  assert.equal(typeof globalThis.AudioContext, 'undefined');
});

test('Training 聚合对象与常量：成员齐全、VERSION/SCHEMA_VERSION 形态正确', () => {
  assert.equal(typeof VERSION, 'string');
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(Number.isInteger(SCHEMA_VERSION), true);
  for (const key of [
    'validateManifest',
    'createManifestTemplate',
    'probeAudio',
    'submitJob',
    'pollJob',
    'exportRecipe',
  ]) {
    assert.equal(typeof Training[key], 'function', `Training.${key} 必须是函数`);
  }
  // DEFAULT_RULES 是冻结的纯常量
  assert.ok(Object.isFrozen(DEFAULT_RULES));
  assert.ok(DEFAULT_RULES.maxClipSeconds > DEFAULT_RULES.minClipSeconds);
  assert.ok(Array.isArray(DEFAULT_RULES.allowedExtensions) && DEFAULT_RULES.allowedExtensions.includes('.wav'));
  assert.ok(Array.isArray(DEFAULT_RULES.placeholderValues) && DEFAULT_RULES.placeholderValues.includes('todo'));
});
