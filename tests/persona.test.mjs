/**
 * tests/persona.test.mjs —— 人设与语气后处理测试（docs/CONTRACT.md §5）
 *
 * 被测对象：web/js/persona/index.js + presets.js（B 交付，只读）。
 * 本文件覆盖契约明确要求的三件事：buildSystemPrompt / polish / splitBubbles。
 *
 * 断言口径：全部断言**用户可观察行为**（返回的字符串、数组、键集合），
 * 不断言内部实现细节；凡是按字符截断的位置，都先算出期望值再比对。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import Persona, {
  PRESETS,
  PRESET_IDS,
  DEFAULT_PRESET,
  STYLE_DEFAULTS,
  GLOBAL_BOUNDARIES,
  VERSION,
  getPreset,
  normalizePreset,
  registerPreset,
  affectionStage,
  moodHint,
  buildSystemPrompt,
  polish,
  splitBubbles,
  listPresets,
  truncateAtSentence,
  applyMoodTail,
} from '../web/js/persona/index.js';

test('契约 §5 要求的四个方法都存在，且 Persona 默认导出与具名导出一致', async () => {
  for (const m of ['buildSystemPrompt', 'polish', 'splitBubbles', 'listPresets']) {
    assert.equal(typeof Persona[m], 'function', `契约 §5 要求 Persona.${m}()`);
  }
  const mod = await import('../web/js/persona/index.js');
  assert.equal(mod.default, Persona, '默认导出应与具名导出一致');
  assert.equal(typeof VERSION, 'string');
  assert.match(VERSION, /^\d+\.\d+\.\d+$/, `VERSION 应是 semver，实际 "${VERSION}"`);
});

test('内置预设：DEFAULT_PRESET 存在、四个预设结构与键集合完全一致', () => {
  assert.equal(DEFAULT_PRESET, 'lively-companion', '契约 §5 规定默认预设 id');
  assert.ok(PRESET_IDS.includes(DEFAULT_PRESET), 'DEFAULT_PRESET 必须在 PRESET_IDS 里');
  assert.equal(new Set(PRESET_IDS).size, PRESET_IDS.length, '预设 id 不得重复');
  assert.deepEqual(
    Object.keys(PRESETS).sort(),
    [...PRESET_IDS].sort(),
    'PRESET_IDS 必须是 PRESETS 的键集合（顺序即面板展示顺序，但集合必须一致）',
  );

  const expectedKeys = [
    'address', 'boundaries', 'catchphraseStyle', 'description', 'emotion',
    'examples', 'id', 'interjections', 'length', 'moodTail', 'name', 'rhythm', 'sentences', 'tone',
  ];
  for (const id of PRESET_IDS) {
    const p = PRESETS[id];
    assert.equal(p.id, id, `预设 ${id} 的 id 字段必须与键名一致`);
    assert.ok(p.name && p.name.trim(), `预设 ${id} 必须有 name`);
    assert.ok(p.description && p.description.trim(), `预设 ${id} 必须有 description`);
    assert.deepEqual(Object.keys(p).sort(), expectedKeys, `预设 ${id} 的字段集合应与其余预设一致`);
    assert.ok(p.tone && p.sentences && p.rhythm, `预设 ${id} 必须给出 tone/sentences/rhythm`);
    assert.ok(p.length.maxChars > 0 && p.length.bubbleMaxChars > 0, `预设 ${id} 的字数必须为正`);
    assert.ok(p.length.bubbleMaxChars <= p.length.maxChars, `预设 ${id} 的气泡上限不应大于整段上限`);
    assert.equal(typeof p.emotion, 'object');
    for (const key of Object.keys(STYLE_DEFAULTS.emotion)) {
      assert.ok(typeof p.emotion[key] === 'string' && p.emotion[key].trim(), `预设 ${id} 缺 emotion.${key}`);
    }
  }
});

test('getPreset()：未知 id / 空值一律回落默认预设；对象按角色卡规整；normalizePreset 拒绝非法输入', () => {
  assert.equal(getPreset('lively-companion').id, 'lively-companion');
  assert.equal(getPreset('gentle-caring').name, PRESETS['gentle-caring'].name);
  assert.equal(getPreset('no-such-preset').id, DEFAULT_PRESET, '未知 id 必须回落默认，而不是抛错或返回 undefined');
  assert.equal(getPreset(undefined).id, DEFAULT_PRESET);
  assert.equal(getPreset(null).id, DEFAULT_PRESET);
  assert.equal(getPreset('').id, DEFAULT_PRESET);
  assert.equal(getPreset(123).id, DEFAULT_PRESET);

  // 普通对象当自定义角色卡：getPreset(obj) 只做「规整」，不会替你打 custom 标记
  const card = getPreset({ id: 'my-card', name: '我的卡' });
  assert.equal(card.id, 'my-card');
  assert.equal(card.name, '我的卡');
  assert.equal(card.custom, false, 'getPreset(对象) 不负责打 custom 标记（custom 标记由 registerPreset 打）');
  assert.equal(card.tone, STYLE_DEFAULTS.tone, '缺字段应按 STYLE_DEFAULTS 补齐，而不是留 undefined');
  assert.deepEqual(card.emotion, STYLE_DEFAULTS.emotion);
  // 显式声明自定义才算自定义卡
  assert.equal(getPreset({ id: 'c2', name: 'C2', custom: true }).custom, true);
  assert.equal(getPreset({ id: 'c3', name: 'C3', builtin: false }).custom, true);

  assert.equal(normalizePreset(null), null);
  assert.equal(normalizePreset('string'), null);
  assert.equal(normalizePreset({}), null, '没有 id 的卡片不合法');
  assert.equal(normalizePreset({ id: '   ' }), null, '纯空白 id 不合法');
  assert.equal(normalizePreset({ name: '只有名字' }, 'fallback-id').id, 'fallback-id', '应能用 fallbackId 补 id');
});

test('buildSystemPrompt()：六个小节的标题与内容齐全，preset/称呼/好感度/心情/额外规则都被写进去', () => {
  const p = buildSystemPrompt({ preset: 'lively-companion', userName: '小林', affection: 45, mood: 'happy' });

  for (const section of ['【你是谁】', '【说话风格】', '【称呼与关系】', '【当前心情】', '【边界】', '【输出格式】']) {
    assert.ok(p.includes(section), `system prompt 必须包含小节 ${section}`);
  }
  // 人设本身
  assert.ok(p.includes(PRESETS['lively-companion'].name), '必须写明当前性格模板名');
  assert.ok(p.includes(PRESETS['lively-companion'].tone), '必须写入该预设的 tone');
  // 称呼
  assert.ok(p.includes('「小林」'), '必须使用用户指定的称呼');
  // 禁敬称是契约要求，但「您」这个字必须允许出现在**禁令本身**里：
  //   index.js:116 的真实文案是「…不要自行改成敬称「您」。」——这是规则，不是违规。
  // 所以这里断言「敬称没有被当成称呼推荐出去」，而不是「整段不许出现您字」。
  assert.ok(!p.includes(`称呼为「您」`), `不得把用户称呼成「您」（userName=小林）`);
  assert.ok(!p.includes(`称呼为「${PRESETS['lively-companion'].name}」`), '不得把预设名当称呼');
  // 反向检查：当 userName 就是「您」时，实现应如实写入（这是用户自己的选择，不是实现违规）
  assert.ok(
    buildSystemPrompt({ preset: 'lively-companion', userName: '您' }).includes('「您」'),
    'userName 由调用方决定，实现应如实写入',
  );
  // 逐预设检查：呼称文案不得把「您」推荐为呼称（提到「您」只允许是否定语境，如 lively-companion 的「也不用「您」」）
  for (const id of PRESET_IDS) {
    const addr = PRESETS[id].address;
    assert.ok(addr && typeof addr.default === 'string' && addr.default.length > 0, `${id} 必须有默认呼称文案`);
    let pre = String(addr.default);
    for (const b of Array.isArray(addr.byAffection) ? addr.byAffection : []) pre += ' ' + String(b.text ?? '');
    const stripped = pre.replace(/不(?:用|加|要|得|必|要再)[^，。；;]*/g, '');
    assert.ok(!stripped.includes('您'), `${id} 的呼称文案把「您」用在非否定语境里：${pre}`);
  }
  // 好感度阶段：45 应落在「亲近」而不是「初识」
  assert.ok(p.includes('亲近'), `好感度 45 应给出「亲近」阶段，实际 prompt 未包含`);
  assert.ok(p.includes('45/100'), '必须写明好感度数值');
  assert.ok(p.includes('昵称版'), '好感度 45 应触发 min:40 的呼称条目');
  // 呼称条目是「累积包含」语义（index.js:118-119 满足 level >= min 就全写进去），不是「只写最高一档」，
  // 所以不能用「不出现 min:0 条目」来判阶段；改用「低段位不该出现的阶段描述」来判。
  assert.ok(p.includes(PRESETS['lively-companion'].address.byAffection[0].text), '累计语义下 min:0 条目仍应在场');
  assert.ok(!p.includes('还在互相熟悉的阶段'), '好感度 45 不该出现「初识」阶段描述');
  // 低好感度时不该出现 min:40 的高段条目
  const low = buildSystemPrompt({ preset: 'lively-companion', userName: '小林', affection: 5, mood: 'idle' });
  assert.ok(low.includes('初识'), '好感度 5 应为「初识」');
  assert.ok(!low.includes('昵称版'), '好感度 5 不该出现 min:40 的呼称条目');
  // 心情
  assert.ok(p.includes('happy'), '必须写明当前心情');
  assert.ok(p.includes(PRESETS['lively-companion'].emotion.happy), '必须写入该心情对应的表达方式');
  // 全局边界
  for (const b of GLOBAL_BOUNDARIES) assert.ok(p.includes(b), `全局边界条目必须全部写入：${b.slice(0, 12)}…`);
  // 输出格式：整段字数上限取自预设
  assert.ok(p.includes(`${PRESETS['lively-companion'].length.maxChars} 字以内`), '必须写明整段字数上限');

  // extraRules：数组 / 字符串 / 脏值三种形态
  const withRules = buildSystemPrompt({ extraRules: ['只说实话', '  ', '', '不加戏'] });
  assert.ok(withRules.includes('【补充规则】'));
  assert.ok(withRules.includes('- 只说实话') && withRules.includes('- 不加戏'));
  // 结构口径（index.js:100-142）：**不要按整段数 `- `**，必须按小节切片再数。
  // 实测默认 prompt（DEFAULT_PRESET=lively-companion）的顶层 `- ` 分布共 19 条：
  //   【说话风格】5（句长/节奏/口头禅类型/语气词示例/语气示意句）
  //   【称呼与关系】3（呼称指令/呼称方式/当前阶段）
  //   【当前心情】1
  //   【边界】7（= 6 条 GLOBAL_BOUNDARIES + 该预设自带的 1 条 boundaries）
  //   【输出格式】3
  //   合计 19。注意【称呼与关系】里 byAffection 条目是 `  · `、【说话风格】里示例句是 `    · `，都不是顶层 `- `。
  const sectionOf = (s, title) => {
    const i = s.indexOf(title);
    assert.notEqual(i, -1, `prompt 里必须有小节 ${title}`);
    const j = s.indexOf('【', i + 1);
    return s.slice(i, j === -1 ? undefined : j);
  };
  const bulletsIn = (s, title) => sectionOf(s, title).split('\n').filter((l) => l.startsWith('- ')).length;

  const topBullets = (s) => s.split('\n').filter((l) => l.startsWith('- ')).length;
  const baseline = buildSystemPrompt({});
  const ownBoundaries = (PRESETS[DEFAULT_PRESET].boundaries || []).length;
  assert.equal(topBullets(baseline), 19, '默认 prompt 的顶层 `- ` 总数（实测值，改动小节结构时同步更新）');
  assert.equal(bulletsIn(baseline, '【说话风格】'), 5, '【说话风格】5 条');
  assert.equal(bulletsIn(baseline, '【称呼与关系】'), 3, '【称呼与关系】3 条');
  assert.equal(bulletsIn(baseline, '【当前心情】'), 1, '【当前心情】1 条');
  assert.equal(bulletsIn(baseline, '【边界】'), GLOBAL_BOUNDARIES.length + ownBoundaries, '【边界】= 全局 + 预设自带');
  assert.equal(bulletsIn(baseline, '【输出格式】'), 3, '【输出格式】3 条');
  assert.ok(!baseline.includes('【补充规则】'), '无 extraRules 时不应出现【补充规则】小节');
  assert.equal(topBullets(withRules), topBullets(baseline) + 2, '空字符串形式的 extraRules 必须被过滤，只多 2 条');
  assert.equal(bulletsIn(withRules, '【补充规则】'), 2, '【补充规则】小节里只能有 2 条真实规则（空串已被过滤）');
  const oneRule = buildSystemPrompt({ extraRules: '  只说短句  ' });
  assert.ok(oneRule.includes('- 只说短句'), '字符串形式的 extraRules 应被接受');
  const badRules = buildSystemPrompt({ extraRules: 42 });
  assert.ok(!badRules.includes('【补充规则】'), '非法 extraRules 不应产生空小节');

  // 无参调用不应抛错
  const bare = buildSystemPrompt();
  assert.ok(bare.includes('【你是谁】'));
  assert.equal(getPreset().name, PRESETS[DEFAULT_PRESET].name);
  assert.ok(buildSystemPrompt().includes(`「${PRESETS[DEFAULT_PRESET].name}」`), '无 preset 时用默认预设');
  // 未知 preset 也不该抛错
  assert.ok(buildSystemPrompt({ preset: 'nope' }).includes(PRESETS[DEFAULT_PRESET].name));
});

test('affectionStage()：四档边界（0/9/10/39/40/69/70/100）与越界夹紧', () => {
  const nameAt = (v) => affectionStage(v).name;
  assert.equal(nameAt(0), '初识');
  assert.equal(nameAt(9), '初识');
  assert.equal(nameAt(10), '熟络');
  assert.equal(nameAt(39), '熟络');
  assert.equal(nameAt(40), '亲近');
  assert.equal(nameAt(69), '亲近');
  assert.equal(nameAt(70), '很亲近');
  assert.equal(nameAt(100), '很亲近');

  assert.equal(affectionStage(-5).level, 0, '负数应夹紧到 0');
  assert.equal(affectionStage(999).level, 100, '超过 100 应夹紧到 100');
  assert.equal(affectionStage(Number.NaN).level, 0, 'NaN 应夹紧到 0 而不是 NaN');
  assert.equal(affectionStage('55').level, 55, '数字字符串应被接受');
  assert.equal(affectionStage('abc').level, 0, '非数字字符串应夹紧到 0');

  for (const v of [0, 25, 50, 90]) {
    const s = affectionStage(v);
    assert.equal(s.level, v);
    assert.ok(typeof s.name === 'string' && s.name.trim());
    assert.ok(typeof s.text === 'string' && s.text.trim());
  }
});

test('moodHint()：已知心情取预设文案；缺失/空白心情按 idle 取预设 idle；未知心情键回落 STYLE_DEFAULTS', () => {
  // 口径（index.js:62-68 实测，写断言以此为准）：
  //   const key = String(mood ?? 'idle').trim() || 'idle';
  //   return p.emotion?.[key] || STYLE_DEFAULTS.emotion[key] || STYLE_DEFAULTS.emotion.idle;
  // 即「缺失/空白心情」等价于 idle（能命中预设 idle），而「有值但预设没这个键」才走 STYLE_DEFAULTS。
  assert.equal(moodHint('happy', 'lively-companion'), PRESETS['lively-companion'].emotion.happy);
  assert.equal(moodHint('sad', 'lively-companion'), PRESETS['lively-companion'].emotion.sad);
  assert.equal(moodHint('idle', 'lively-companion'), PRESETS['lively-companion'].emotion.idle);
  // 缺失/空白心情 → 与显式 'idle' 完全等价
  assert.equal(moodHint(undefined, 'lively-companion'), PRESETS['lively-companion'].emotion.idle);
  assert.equal(moodHint(null, 'lively-companion'), PRESETS['lively-companion'].emotion.idle);
  assert.equal(moodHint('  ', 'lively-companion'), PRESETS['lively-companion'].emotion.idle);
  // 有值但预设 emotion 里没有这个键 → 回落 STYLE_DEFAULTS（**不是**预设 idle）
  assert.ok(!Object.prototype.hasOwnProperty.call(PRESETS['lively-companion'].emotion, 'nonsense'));
  assert.equal(moodHint('nonsense', 'lively-companion'), STYLE_DEFAULTS.emotion.idle);
  // 逐预设：四个内置预设都必须有 idle，且显式 idle 一定命中预设自己的文案（不走通用兜底）
  for (const id of PRESET_IDS) {
    const own = PRESETS[id].emotion.idle;
    assert.ok(typeof own === 'string' && own.length > 0, `${id} 必须有 emotion.idle`);
    assert.equal(moodHint('idle', id), own, `${id} 的显式 idle 必须取预设自己的文案`);
    assert.equal(moodHint(undefined, id), own, `${id} 的缺失心情必须等价于 idle`);
  }
  // 找不到 preset（回落默认预设）也不应抛错；直接把对象卡传进来也不应抛错
  assert.ok(moodHint('happy', 'no-such').length > 0, '未知 preset 不应抛错');
  assert.ok(moodHint('happy', { id: 'inline-card' }).length > 0, '对象卡入参不应抛错');
  assert.ok(STYLE_DEFAULTS.emotion.idle.length > 0);
});

test('polish()：剥掉元叙述（整句/Markdown/客服式收尾），空输入有中文兜底', () => {
  // 句首元叙述被剥掉，保留后续
  assert.equal(polish('作为一个AI，我没有真实情感。今天天气不错。'), '我没有真实情感。今天天气不错。');
  // 句中插入的元叙述被替换掉，不能留下「，作为一个AI，」
  const inline = polish('我不太确定。作为一个AI，我没有真实情感。不过可以聊聊。');
  assert.ok(!inline.includes('作为一个AI'), `句中元叙述必须被清理，实际：${inline}`);
  assert.ok(inline.includes('不过可以聊聊'));
  // 英文同类表达
  const en = polish('我在呢。As an AI language model, I cannot feel. 说说看？');
  assert.ok(!/As an AI language model/i.test(en), `英文元叙述必须被清理，实际：${en}`);
  assert.ok(en.includes('说说看'));
  // 客服式收尾逐句丢弃
  assert.equal(polish('如果还有其他问题，随时找我。今天天气不错。'), '今天天气不错。');
  assert.equal(polish('总之，希望你今天开心。走吧。'), '走吧。');
  assert.equal(polish('免责声明：以上仅供参考。开始吧。'), '开始吧。');
  // Markdown 收敛成纯文本
  assert.equal(polish('**你好**\n\n# 标题\n- 第一点\n- 第二点'), '你好\n标题\n第一点\n第二点');
  // 空 / 全空白 / 全被清理 → 中文兜底，不能返回空串
  for (const bad of ['', '   ', '\n\n', null, undefined]) {
    const out = polish(bad);
    assert.ok(out.trim().length > 0, `polish(${JSON.stringify(bad)}) 不能返回空串`);
    assert.ok(/[\u4e00-\u9fa5]/.test(out), '兜底文案必须是中文');
  }
  assert.ok(polish('我是一个AI。').trim().length > 0, '整段都是元叙述时也不应返回空串');
  // 非字符串入参不应抛错
  assert.equal(typeof polish(12345), 'string');
});

test('polish() 回归：整句「我是一个AI语言模型，没有真实情感。」必须被整句丢弃（曾经只剥前缀，AI 自述漏进用户可见文本）', () => {
  // 历史缺陷（chat-dev 已修，2026-xx）：polish('我是一个AI语言模型，没有真实情感。今天天气不错。')
  //   曾经返回 '我没有真实情感。今天天气不错。'（只剥了「我是一个AI语言模型，」这个前缀）。
  // 这句属于「AI 自述漏进用户可见文本」，红线级 —— 所以这条断言是硬回归哨兵，不许放宽。
  assert.ok(!polish('我是一个AI。').includes('我是一个AI'), '对照：短句形态能被整句丢弃');
  assert.ok(polish('我是一个AI。').length > 0, '丢掉后仍应有中文兜底，不能返回空串');
  assert.equal(polish('我是一个AI语言模型，没有真实情感。今天天气不错。'), '今天天气不错。');
  // 更多整句变体
  assert.equal(polish('我是一个语言模型，没有真实情感。今天天气不错。'), '今天天气不错。');
  assert.equal(polish('我是人工智能，无法产生真实情感。走吧。'), '走吧。');
});

test('polish() 回归：括号内元叙述含逗号也必须被清理（PAREN_META 曾写窄到「，」处停住）', () => {
  // 历史缺陷（chat-dev 已修，2026-xx）：PAREN_META 里的 `[^）)]{0,26}?` 不含「，」，
  // 于是「（作为一个AI，我没有真实情感。）」整段原样留在输出里。
  assert.equal(polish('（作为一个AI）今天天气不错。'), '今天天气不错。', '对照：无逗号的括号元叙述能被清理');
  assert.equal(
    polish('（作为一个AI，我没有真实情感。）今天天气不错。'),
    '今天天气不错。',
    '含逗号的括号元叙述也必须被整对括号吃掉',
  );
  assert.equal(polish('（身为语言模型，我不能这样做。）开始吧。'), '开始吧。');
});

test('polish() 反向断言：正常文本与「AI 爱好者」这类非自述不得被误删', () => {
  // 修 PAREN_META / SELF_INTRO 时最容易误伤的边界，必须钉住。
  assert.equal(polish('（笑）今天天气不错。'), '（笑）今天天气不错。', '情绪/动作括号不是元叙述，不得删');
  assert.equal(polish('我是一个AI爱好者，今天在挑显卡。'), '我是一个AI爱好者，今天在挑显卡。', '「AI 爱好者」是用户自述，不是 AI 自述');
  // 单句前缀形态仍按原语义（只剥前缀，保留后半句）
  assert.equal(polish('作为一个AI，我没有真实情感。今天天气不错。'), '我没有真实情感。今天天气不错。');
});

test('polish()：按 maxChars 截断在标点处；moodTail 只在配置了该心情时才加', () => {
  const long = '一二三四五六，七八九十，十一十二，十三十四。';
  // maxChars=8 → 窗口 9 个字，从后往前找句末标点找不到，退到软标点「，」→ 保留 6 字 + 省略号
  assert.equal(polish(long, { maxChars: 8 }), '一二三四五六…');
  // maxChars=12 → 窗口 13 字，最后一个是「，」→ 同样切在逗号
  assert.equal(polish(long, { maxChars: 12 }), '一二三四五六，七八九十…');
  // 句号在窗口内时优先切在句号（保留句号，不加省略号）
  assert.equal(polish('一二三四五六。七八九十。十一十二。', { maxChars: 8 }), '一二三四五六。');
  // 预设默认上限：lively-companion 是 120 字
  assert.equal(PRESETS['lively-companion'].length.maxChars, 120, '若预设改了上限，这条断言应同步更新');
  const short = '嗯，我在。';
  assert.equal(polish(short, { preset: 'lively-companion' }), short, '未超限的文本不应被改动');

  // moodTail：lively-companion 只在 happy/excited/shy/sleepy/surprised 配了尾巴
  assert.equal(polish('你好呀', { preset: 'lively-companion', mood: 'happy' }), '你好呀～');
  assert.equal(polish('你好呀。', { preset: 'lively-companion', mood: 'happy' }), '你好呀～', '句末句号应被尾巴替换');
  assert.equal(polish('你好呀！', { preset: 'lively-companion', mood: 'happy' }), '你好呀！', '已有强情绪标点时不再追加');
  assert.equal(polish('你好呀', { preset: 'lively-companion', mood: 'idle' }), '你好呀', 'idle 没有配置尾巴');
  assert.equal(polish('你好呀', { preset: 'lively-companion', mood: 'happy', addMoodTail: false }), '你好呀');
  // 幂等：已经是尾巴结尾就不重复加
  assert.equal(polish('你好呀～', { preset: 'lively-companion', mood: 'happy' }), '你好呀～');

  // applyMoodTail / truncateAtSentence 的边界
  assert.equal(applyMoodTail('在的', ''), '在的', '空尾巴原样返回');
  assert.equal(applyMoodTail('在的。', '～'), '在的～');
  assert.equal(applyMoodTail('在的！', '～'), '在的！');
  assert.equal(truncateAtSentence('短', 10), '短', '未超限原样返回');
  assert.ok(truncateAtSentence('一二三四五六七八九十十一十二十三十四十五', 5).length <= 6);
});

test('splitBubbles()：按句末标点/换行切分，短碎片合并，超长在标点处再切，超过上限合并尾段', () => {
  assert.deepEqual(splitBubbles('你好呀。今天想聊什么？我一直都在！'), ['你好呀。今天想聊什么？', '我一直都在！']);
  assert.deepEqual(splitBubbles(''), []);
  assert.deepEqual(splitBubbles('   '), []);
  assert.deepEqual(splitBubbles(null), []);
  assert.deepEqual(splitBubbles('只有一句没有标点'), ['只有一句没有标点'], '无标点时整段一句');

  // 换行也算边界；合并规则见 index.js:277-285：
  //   prev.length < 8 || part.length < 4，且合并后不超 maxLen —— 只有这两种情况会并到前一句。
  //   '第一行。'(4) + '第二行。'(4) 合并后 8 字，既不满足 <8 也不满足 <4，于是 '第三行。' 另起一泡。
  // （依据：契约 §5 只规定 splitBubbles 返回 string[]，未规定「短句必须贪心合并」；此处按实现口径断言。）
  const lines = splitBubbles('第一行。\n第二行。\n第三行。');
  assert.deepEqual(lines, ['第一行。第二行。', '第三行。'], '合并阈值是「前段<8 字或后段<4 字」，8 字后不再继续吃下一句');

  // 短碎片合并：后一句 <4 字会并到前一句
  assert.deepEqual(splitBubbles('今天天气不错。嗯。'), ['今天天气不错。嗯。']);
  // 前一句 <8 字也会继续吃下一句（即便后一句不短）
  assert.deepEqual(splitBubbles('嗯。今天天气不错，我们出去走走吧。'), ['嗯。今天天气不错，我们出去走走吧。']);
  // 但合并后超过 maxLen 就必须停
  const noMerge = splitBubbles('嗯。今天天气不错，我们出去走走吧。', { maxLen: 10 });
  assert.ok(noMerge.length >= 2, `合并后超 maxLen 时应拆开，实际 ${JSON.stringify(noMerge)}`);
  for (const b of noMerge) assert.ok(b.length <= 10, `不得超 maxLen，实际 ${b.length}：${b}`);

  // 每句都长于 maxLen 时，超长句在标点处再切
  const parts = splitBubbles('一二三四五六，七八九十，十一十二。'.repeat(2), { maxLen: 12 });
  for (const b of parts) assert.ok(b.length <= 12, `每个气泡不得超过 maxLen=12，实际 ${b.length}：${b}`);
  assert.ok(parts.every((b) => b.trim() === b && b.length > 0), '气泡不得有首尾空白或空串');

  // maxBubbles 上限：超出的尾部被合并进最后一个气泡，总数不超过上限
  const capped = splitBubbles('一二三四五六七八九十。'.repeat(6), { maxLen: 12, maxBubbles: 3 });
  assert.equal(capped.length, 3, `maxBubbles=3 时必须恰好切成 3 段，实际 ${capped.length}`);
  assert.equal(capped.join(''), '一二三四五六七八九十。'.repeat(6), '合并尾段不得丢字');

  // Markdown 列表/代码块前缀被清理
  const md = splitBubbles('```js\nconst a = 1;\n```\n1. 第一步。\n2. 第二步。');
  assert.ok(md.every((b) => !b.includes('```')), `气泡里不应残留代码块围栏：${JSON.stringify(md)}`);
  assert.ok(md.every((b) => !/^\d+[.、)]\s/.test(b)), `气泡里不应残留列表编号：${JSON.stringify(md)}`);

  // 脏入参
  assert.deepEqual(splitBubbles('一句话。', { maxLen: 0, maxBubbles: 0 }), ['一句话。'], '非法上限应回落默认值');
  assert.ok(Array.isArray(splitBubbles(12345)));
});

test('listPresets()：返回内置预设的精简视图，含默认预设', () => {
  const list = listPresets();
  assert.ok(Array.isArray(list), 'listPresets() 必须返回数组');
  assert.ok(list.length >= PRESET_IDS.length, '至少包含全部内置预设');
  const ids = list.map((p) => p.id);
  assert.ok(ids.includes(DEFAULT_PRESET), '必须包含默认预设');
  for (const item of list) {
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.description, 'string');
  }
});

test('registerPreset()：注册后可被 getPreset/listPresets 取到，重名默认拒绝、override 才覆盖', () => {
  const before = listPresets().length;
  const card = { id: 'test-card-1', name: '测试卡', tone: '保持简短。' };
  const registered = registerPreset(card);
  assert.ok(registered, 'registerPreset 应返回注册结果（真值）');
  assert.equal(getPreset('test-card-1').name, '测试卡');

  const list = listPresets();
  assert.equal(list.length, before + 1, '注册后列表应多一项');
  assert.ok(list.some((p) => p.id === 'test-card-1'));

  // 重名：默认不允许静默覆盖内置预设
  const builtinName = PRESETS[DEFAULT_PRESET].name;
  registerPreset({ id: DEFAULT_PRESET, name: '想覆盖内置' });
  assert.equal(getPreset(DEFAULT_PRESET).name, builtinName, '重名注册默认必须被拒绝，不得覆盖内置预设');
  registerPreset({ id: DEFAULT_PRESET, name: '显式覆盖' }, { override: true });
  assert.equal(getPreset(DEFAULT_PRESET).name, '显式覆盖', 'override:true 时才允许覆盖');
  // 还原，避免影响同进程内其他测试文件
  registerPreset(PRESETS[DEFAULT_PRESET], { override: true });
  assert.equal(getPreset(DEFAULT_PRESET).name, builtinName);

  // 非法卡片
  assert.ok(!registerPreset(null));
  assert.ok(!registerPreset({ name: '没有 id' }));
});
