#!/usr/bin/env node
/**
 * make-manifest.mjs —— 扫描你的声音素材目录，生成/更新训练清单（纯 Node，零依赖）。
 *
 * 它做什么：
 *   1. 遍历 voice-training/data/（可换），找出所有音频文件；
 *   2. 只读**文件头**解析采样率 / 声道数 / 时长（WAV / FLAC / MP3，其余格式标注为未解析）；
 *   3. 算 sha256（训练集查重靠它，重复片段会污染数据集）；
 *   4. 写出符合《数据集规范》的 manifest JSON，并**保留你手填过的字段**。
 *
 * 它不做什么（重要）：
 *   - 不下载任何模型权重、不下载任何音频、不爬取任何素材；
 *   - 不联网、不解码音频、不转码、不裁剪；
 *   - 不训练、不推理、不做声音克隆；
 *   - 不生成任何音频。
 *
 * 幂等性（重要，别怕重跑）：
 *   如果输出清单已经存在，本脚本会**读回它**并把下列由你手写的字段原样保留：
 *     name / language / license / consent / speakers[].displayName / speakers[].consent
 *     / clips[].text / clips[].speaker / clips[].split
 *   只刷新「由文件本身决定」的字段：file / duration / sampleRate / channels / sha256 /
 *   bitsPerSample / bytes / probedAt。
 *   也就是说：**先跑本脚本生成骨架 → 手填 license 与 consent → 再跑一次刷新数据，你填的授权说明不会被冲掉。**
 *
 * 退出码：0 成功 / 1 有不可忽略的问题 / 2 用法错误 / 3 找不到数据目录 / 70 内部错误
 *
 * 用法：
 *   node voice-training/scripts/make-manifest.mjs [选项]
 *   node voice-training/scripts/make-manifest.mjs --help
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeAudioBuffer, HEADER_SUPPORTED_EXTENSIONS } from './lib/audio-probe.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');

export const EXIT = { OK: 0, ERRORS: 1, USAGE: 2, MISSING: 3, INTERNAL: 70 };

/** 与 web/js/training/index.js 的 SCHEMA_VERSION 必须保持一致 */
export const SCHEMA_VERSION = 1;

const AUDIO_EXTENSIONS = ['.wav', '.flac', '.mp3', '.m4a', '.ogg', '.opus', '.webm'];

/** 这些目录名不是说话人 */
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'output', 'outputs', 'tmp', 'cache']);

const HELP = `扫描素材目录，生成/更新声音训练清单（make-manifest.mjs）

用法：
  node voice-training/scripts/make-manifest.mjs [选项]

选项：
  --data <dir>        素材目录，默认 voice-training/data
  --out <file>        输出清单，默认 voice-training/manifests/dataset.manifest.json
  --name <name>       数据集名称（首次生成时写入；已存在则沿用清单里的）
  --language <tag>    语言标签，默认 zh-CN
  --speaker <id>      单说话人模式：把 data/ 下所有音频都算作这个 id
                      （默认按子目录名当说话人 id；data/ 根目录下的文件算 speaker-a）
  --dry-run           只报告，不写文件
  --check             不写文件；若清单与磁盘不一致则以退出码 1 结束（可放 CI）
  --json              以 JSON 打印摘要（便于脚本消费）
  --quiet             只打印总结
  --help, -h          显示本帮助

退出码：
  0 成功   1 有问题（--check 不一致 / 探测失败）   2 用法错误   3 找不到数据目录   70 内部错误

说明：
  本脚本只读本地文件头，不联网、不转码、不写音频，也不会下载任何模型权重或素材。
  数据规范见 voice-training/SCHEMA.md。
  清单里的 license 与 consent 是**红线字段**，脚本只能给你占位模板，必须由你本人改写为真实授权说明；
  未填真实授权说明的清单会被 validate-dataset.mjs 与插件「训练」面板拒绝。`;

function parseArgs(argv) {
  const opts = {
    dataDir: join(REPO_ROOT, 'voice-training', 'data'),
    outFile: join(REPO_ROOT, 'voice-training', 'manifests', 'dataset.manifest.json'),
    name: '',
    language: 'zh-CN',
    speaker: '',
    dryRun: false,
    check: false,
    json: false,
    quiet: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const need = (flag) => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`选项 ${flag} 缺少参数值`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--data':
        opts.dataDir = resolve(process.cwd(), need('--data'));
        break;
      case '--out':
        opts.outFile = resolve(process.cwd(), need('--out'));
        break;
      case '--name':
        opts.name = need('--name');
        break;
      case '--language':
        opts.language = need('--language');
        break;
      case '--speaker':
        opts.speaker = need('--speaker');
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--check':
        opts.check = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`未知选项：${arg}`);
    }
  }
  return opts;
}

/** 递归收集音频文件，返回 [{ abs, rel, speakerId }]（rel 用 / 分隔，相对 dataDir） */
export function collectAudioFiles(dataDir, forcedSpeakerId = '') {
  const found = [];

  const walk = (dir, depth) => {
    if (depth > 6) return; // 防御：别掉进奇怪的深目录
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!AUDIO_EXTENSIONS.includes(ext)) continue;

      const rel = relative(dataDir, abs).split(sep).join('/');
      // 说话人判定：--speaker 强制；否则取相对路径的第一级目录名；根目录下的文件归 speaker-a
      const parts = rel.split('/');
      const speakerId = forcedSpeakerId || (parts.length > 1 ? parts[0] : 'speaker-a');
      found.push({ abs, rel, speakerId, ext });
    }
  };

  walk(dataDir, 0);
  // 稳定排序：清单 diff 才不会因为目录枚举顺序而乱跳
  found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return found;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 读一个音频文件并探测元信息；失败不抛异常，返回 ok:false */
export function probeFile(abs, ext) {
  let buf;
  try {
    buf = readFileSync(abs);
  } catch (err) {
    return { ok: false, reason: 'read-failed', message: `读取失败：${err?.message || err}` };
  }
  const digest = sha256(buf);
  const info = probeAudioBuffer(buf, ext);
  if (!info || info.ok !== true) {
    return {
      ok: false,
      reason: info?.reason || 'probe-failed',
      message: info?.message || '无法从文件头解析音频参数',
      sha256: digest,
      bytes: buf.length,
      headerParsed: HEADER_SUPPORTED_EXTENSIONS.includes(ext),
    };
  }
  return { ok: true, ...info, sha256: digest, bytes: buf.length };
}

/**
 * 生成清单对象。
 * @param {object} opts { dataDir, name, language, speaker, previous }
 * @returns {{ manifest: object, report: object }}
 */
export function buildManifest(opts) {
  const { dataDir, speaker = '' } = opts;
  const previous = opts.previous && typeof opts.previous === 'object' ? opts.previous : null;

  const files = collectAudioFiles(dataDir, speaker);
  const previousClips = new Map();
  if (previous && Array.isArray(previous.clips)) {
    for (const clip of previous.clips) {
      if (clip && typeof clip.file === 'string') {
        previousClips.set(clip.file.split(sep).join('/'), clip);
      }
    }
  }

  const probeFailures = [];
  const duplicates = new Map(); // sha256 -> [rel...]
  const clips = [];

  for (const file of files) {
    const probe = probeFile(file.abs, file.ext);
    const old = previousClips.get(file.rel) || null;
    const clip = {
      file: file.rel,
      speaker: (old && String(old.speaker || '').trim()) || file.speakerId,
    };
    if (probe.ok) {
      clip.duration = probe.duration;
      clip.sampleRate = probe.sampleRate;
      clip.channels = probe.channels;
      if (probe.bitsPerSample) clip.bitsPerSample = probe.bitsPerSample;
      clip.sha256 = probe.sha256;
      clip.bytes = probe.bytes;
      if (duplicates.has(probe.sha256)) duplicates.get(probe.sha256).push(file.rel);
      else duplicates.set(probe.sha256, [file.rel]);
    } else {
      // 探测失败也要把条目写进清单：让校验脚本把它报成错误/警告，而不是静默漏掉一个文件
      clip.probeError = probe.reason;
      if (probe.sha256) clip.sha256 = probe.sha256;
      if (probe.bytes) clip.bytes = probe.bytes;
      probeFailures.push({ file: file.rel, reason: probe.reason, message: probe.message });
    }
    // 你手写的逐条文本标注要保留
    if (old && typeof old.text === 'string' && old.text) clip.text = old.text;
    if (old && typeof old.split === 'string' && old.split) clip.split = old.split;
    clips.push(clip);
  }

  const speakerOrder = [];
  const speakerSeen = new Set();
  for (const clip of clips) {
    const id = String(clip.speaker || '').trim();
    if (id && !speakerSeen.has(id)) {
      speakerSeen.add(id);
      speakerOrder.push(id);
    }
  }

  const previousSpeakers = new Map();
  if (previous && Array.isArray(previous.speakers)) {
    for (const s of previous.speakers) {
      if (s && typeof s.id === 'string') previousSpeakers.set(s.id, s);
    }
  }

  const speakers = speakerOrder.map((id) => {
    const old = previousSpeakers.get(id);
    if (old) return { ...old, id };
    return {
      id,
      displayName: id === 'speaker-a' && speaker ? id : `说话人 ${id}`,
      language: opts.language || 'zh-CN',
      isSelf: true,
      consent: {
        obtained: true,
        form: 'written',
        date: '',
        scope: '仅用于本地个人桌宠语音模型训练，不再分发',
      },
    };
  });

  // name / license / consent：你若在旧清单里填过，就沿用；否则给占位模板（会被校验脚本拒绝，逼你填）
  const name = (previous && String(previous.name || '').trim()) || opts.name || 'my-voice-dataset';
  const license =
    (previous && String(previous.license || '').trim()) ||
    '示例占位：请改写为真实授权说明，例如「说话人本人书面授权，仅用于本地个人非商业用途，不再分发」';
  const consent =
    previous && previous.consent && typeof previous.consent === 'object'
      ? previous.consent
      : {
          obtained: true,
          subject: speakers[0]?.id || 'speaker-a',
          form: 'written',
          date: '',
          scope: '仅用于本地个人桌宠语音模型训练，不再分发',
          note: '只能使用本人声音或已获得明确书面授权的声音；请勿使用任何第三方作品/声优的声音素材。',
        };

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    name,
    language: (previous && String(previous.language || '').trim()) || opts.language || 'zh-CN',
    license,
    consent,
    speakers,
    clips,
    notes:
      (previous && typeof previous.notes === 'string' && previous.notes) ||
      '本清单不含音频本身。音频放在 voice-training/data/<说话人>/ 下（voice-training/data/** 已被 .gitignore 排除）。license 与 consent 是红线字段，必须由你本人填真实授权说明。',
  };

  const totalDurationSec = clips.reduce((sum, c) => sum + (Number(c.duration) || 0), 0);
  const report = {
    dataDir,
    outFile: opts.outFile || '',
    fileCount: files.length,
    clipCount: clips.length,
    speakerIds: speakerOrder,
    totalDurationSec: Math.round(totalDurationSec * 1000) / 1000,
    probeFailures,
    duplicateGroups: [...duplicates.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([hash, list]) => ({ sha256: hash, files: list })),
    keptFields: previous
      ? {
          name: !!(previous.name && String(previous.name).trim()),
          license: !!(previous.license && String(previous.license).trim()),
          consent: !!(previous.consent && typeof previous.consent === 'object'),
          speakerDisplayNames: previousSpeakers.size > 0,
        }
      : null,
  };

  return { manifest, report };
}

/** 比较两份清单的「由文件决定」的部分是否一致（--check 用） */
export function manifestsInSync(a, b) {
  const pick = (m) => {
    if (!m || !Array.isArray(m.clips)) return [];
    return m.clips
      .map((c) => [c.file, c.sha256 || '', c.sampleRate || 0, c.channels || 0])
      .sort((x, y) => (x[0] < y[0] ? -1 : 1));
  };
  return JSON.stringify(pick(a)) === JSON.stringify(pick(b));
}

function readJsonSafe(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`清单不是合法 JSON：${file}（${err?.message || err}）`);
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${err.message}`);
    console.error('跑 `node voice-training/scripts/make-manifest.mjs --help` 看用法。');
    return EXIT.USAGE;
  }

  if (opts.help) {
    console.log(HELP);
    return EXIT.OK;
  }

  if (!existsSync(opts.dataDir) || !statSync(opts.dataDir).isDirectory()) {
    console.error(`✗ 找不到素材目录：${opts.dataDir}`);
    console.error('  请先创建它，把你的录音放进去（例如 voice-training/data/speaker-a/*.wav）。');
    console.error('  数据规范见 voice-training/SCHEMA.md。');
    return EXIT.MISSING;
  }

  let result;
  try {
    result = buildManifest({
      ...opts,
      previous: readJsonSafe(opts.outFile),
    });
  } catch (err) {
    console.error(`✗ 内部错误：${err?.stack || err}`);
    return EXIT.INTERNAL;
  }

  const { manifest, report } = result;

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, summary: report }, null, 2));
  } else if (!opts.quiet) {
    console.log('扫描素材目录…');
    console.log(`  目录        ${report.dataDir}`);
    console.log(`  音频文件    ${report.fileCount} 个`);
    console.log(`  说话人      ${report.speakerIds.join(', ') || '（无）'}`);
    console.log(`  总时长      ${report.totalDurationSec}s`);
    if (report.keptFields) {
      const k = report.keptFields;
      console.log(
        `  保留手填    name=${k.name ? '是' : '否'} license=${k.license ? '是' : '否'} ` +
          `consent=${k.consent ? '是' : '否'} 说话人信息=${k.speakerDisplayNames ? '是' : '否'}`,
      );
    }
    if (report.probeFailures.length) {
      console.log(`  ⚠ ${report.probeFailures.length} 个文件无法从文件头解析（已写进清单并标 probeError）：`);
      for (const f of report.probeFailures.slice(0, 10)) {
        console.log(`    - ${f.file}：${f.message}`);
      }
    }
    if (report.duplicateGroups.length) {
      console.log(`  ⚠ 发现 ${report.duplicateGroups.length} 组重复音频（同一内容出现多次，会污染训练集）：`);
      for (const g of report.duplicateGroups.slice(0, 10)) {
        console.log(`    - ${g.files.join(' == ')}`);
      }
    }
  }

  if (opts.check) {
    const previous = readJsonSafe(opts.outFile);
    if (!previous) {
      console.error(`✗ --check：清单不存在（${opts.outFile}）`);
      return EXIT.ERRORS;
    }
    if (!manifestsInSync(previous, manifest)) {
      console.error('✗ --check：清单与磁盘上的音频不一致，请重跑 make-manifest.mjs');
      return EXIT.ERRORS;
    }
    if (!opts.quiet && !opts.json) console.log(`✅ 清单与磁盘一致：${opts.outFile}`);
    return report.probeFailures.length ? EXIT.ERRORS : EXIT.OK;
  }

  if (opts.dryRun) {
    if (!opts.quiet && !opts.json) console.log('（--dry-run：没有写文件）');
    return report.probeFailures.length ? EXIT.ERRORS : EXIT.OK;
  }

  try {
    const dir = dirname(opts.outFile);
    if (!existsSync(dir)) {
      // 只建清单目录，不碰素材目录
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(opts.outFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error(`✗ 写清单失败：${err?.message || err}`);
    return EXIT.INTERNAL;
  }

  if (!opts.quiet && !opts.json) {
    console.log(`✅ 已写出清单：${opts.outFile}`);
    console.log(`   片段 ${report.clipCount} 条 · 总时长 ${report.totalDurationSec}s`);
    console.log('');
    console.log('下一步（必须做，否则清单会被拒绝）：');
    console.log(`  1. 打开 ${opts.outFile}，把 license 改成你的真实授权说明；`);
    console.log('  2. 填好 consent（授权形式、日期、范围）与每个说话人的信息；');
    console.log('  3. 跑校验：node voice-training/scripts/validate-dataset.mjs');
  }

  // 探测失败算「有问题」，但清单已经写出来了（用户能看到哪几条坏了）
  return report.probeFailures.length ? EXIT.ERRORS : EXIT.OK;
}

// 只有被当作脚本直接执行时才跑 main（被 import 时保持纯函数）
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exit(main());
}
