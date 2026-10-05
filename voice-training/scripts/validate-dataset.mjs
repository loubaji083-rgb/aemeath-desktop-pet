#!/usr/bin/env node
/**
 * validate-dataset.mjs —— 用户自备声音数据集校验（纯 Node，零依赖）。
 *
 * 它做什么：
 *   1. 读清单 JSON，做字段/授权/一致性的结构校验；
 *   2. 遍历清单里的每条音频，检查文件是否存在；
 *   3. 只读**文件头**解析 WAV / FLAC / MP3 的采样率、声道、时长，并与清单声明核对；
 *   4. 用 sha256 查重（同一段音频重复入训会污染数据集）；
 *   5. 打印「通过 / 失败 / 警告」三类清单与统计，并用退出码表达结果。
 *
 * 它不做什么（重要）：
 *   - 不下载任何模型权重、不下载任何音频、不爬取任何素材；
 *   - 不联网、不解码音频、不写任何文件（纯只读校验）；
 *   - 不训练、不推理、不做声音克隆。
 *
 * 退出码：0 通过 / 1 有错误 / 2 用法错误 / 3 找不到数据目录或清单 / 70 内部错误
 *
 * 用法见 `node voice-training/scripts/validate-dataset.mjs --help`
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeAudioBuffer, HEADER_SUPPORTED_EXTENSIONS } from './lib/audio-probe.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');

export const EXIT = { OK: 0, ERRORS: 1, USAGE: 2, MISSING: 3, INTERNAL: 70 };

export const SCHEMA_VERSION = 1;

export const RULES = {
  minClipSeconds: 3,
  maxClipSeconds: 15,
  minSampleRate: 16000,
  targetSampleRate: 22050,
  maxChannels: 1,
  minClipCount: 10,
  allowedExtensions: ['.wav', '.flac', '.mp3', '.m4a', '.ogg', '.opus', '.webm'],
  placeholderValues: ['todo', 'tbd', 'n/a', 'na', 'none', 'unknown', 'placeholder', '待填', '待定', '未填写', '无', '未知', '示例'],
};

const HELP = `声音训练数据集校验（validate-dataset.mjs）

用法：
  node voice-training/scripts/validate-dataset.mjs [选项]

选项：
  --data <dir>           数据目录，默认 voice-training/data
  --manifest <file>      清单文件，默认依次尝试
                         voice-training/manifests/dataset.manifest.json、<data>/manifest.json
  --min-seconds <n>      单条音频最短时长（秒），默认 ${RULES.minClipSeconds}
  --max-seconds <n>      单条音频最长时长（秒），默认 ${RULES.maxClipSeconds}
  --min-sample-rate <n>  最低采样率（Hz），默认 ${RULES.minSampleRate}
  --strict-durations     时长越界按错误处理（默认只警告）
  --json                 以 JSON 输出结果（便于接入 CI）
  --quiet                只输出总结
  --help, -h             显示本帮助

退出码：
  0 通过   1 校验失败   2 用法错误   3 找不到数据目录/清单   70 内部错误

说明：
  本脚本只读取本地文件头，不联网、不解码音频、不写文件，更不会下载任何模型权重或音频素材。
  数据规范见 voice-training/SCHEMA.md。`;

function parseArgs(argv) {
  const opts = {
    dataDir: join(REPO_ROOT, 'voice-training', 'data'),
    manifest: '',
    minSeconds: RULES.minClipSeconds,
    maxSeconds: RULES.maxClipSeconds,
    minSampleRate: RULES.minSampleRate,
    strictDurations: false,
    json: false,
    quiet: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const need = (name) => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`选项 ${name} 缺少参数值`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--data':
        opts.dataDir = resolve(process.cwd(), need('--data'));
        break;
      case '--manifest':
        opts.manifest = resolve(process.cwd(), need('--manifest'));
        break;
      case '--min-seconds':
        opts.minSeconds = Number(need('--min-seconds'));
        break;
      case '--max-seconds':
        opts.maxSeconds = Number(need('--max-seconds'));
        break;
      case '--min-sample-rate':
        opts.minSampleRate = Number(need('--min-sample-rate'));
        break;
      case '--strict-durations':
        opts.strictDurations = true;
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

function isPlaceholder(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return true;
  // 用「非字母数字/汉字边界」包住占位词做子串匹配，这样：
  //   '待填'        → 命中（整串）
  //   '来源：待填'  → 命中（后缀形态 —— 用户写「来源：待填」比只写「待填」自然得多，
  //                   早先只判 s === p / startsWith(p+'：') 会漏掉这种变相占位，等于红线可被绕过）
  //   '来源：todo'  → 命中
  //   'todo list'   → 命中
  //   '没有版权'    → 不命中（'无' 左侧是汉字，不算边界；避免把正常中文误判成占位）
  // 注意：不能用 `\b` —— 它对汉字不生效（'待填' 两侧都是 \W，\b 无法定位）。
  // 本函数与 web/js/training/index.js 的 isPlaceholder() 是**有意的双份实现**（一个跑在浏览器、
  // 一个跑在 Node CLI），改一处必须同步改另一处；tests/toolchain.test.mjs 会对两者同时下断言。
  const hit = (fragment) => RULES.placeholderValues.some((p) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'u');
    return re.test(fragment);
  });
  if (hit(s)) return true;
  // 「占位标签 + 冒号 + 正文」形态（`示例占位：请改写为…`）：整串的边界检测测不出来，
  // 因为标签右侧紧跟着冒号后的汉字（'示例' 后面是 '占'）。只查冒号左边的**标签**：
  //   · 标签以占位词开头（右侧不再要求边界），且
  //   · 标签足够短（上限见下）—— 避免把「来源：原始录音」这种正常写法误杀。
  const cut = s.search(/[：:]/);
  if (cut > 0) {
    const label = s.slice(0, cut).trim();
    if (label && label.length <= 12 && RULES.placeholderValues.some((p) => label.startsWith(p))) {
      return true;
    }
  }
  return false;
}

function normalizeRelPath(file) {
  return String(file ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function findManifest(explicit, dataDir) {
  if (explicit) return existsSync(explicit) ? explicit : '';
  const candidates = [
    join(REPO_ROOT, 'voice-training', 'manifests', 'dataset.manifest.json'),
    join(dataDir, 'manifest.json'),
  ];
  return candidates.find((p) => existsSync(p)) || '';
}

/** 结构校验（与 web/js/training/index.js 的 validateManifest 规则一致） */
function validateStructure(manifest, opts) {
  const errors = [];
  const warnings = [];
  const stats = {
    speakers: 0,
    clips: 0,
    totalDurationSec: 0,
    avgDurationSec: 0,
    minDurationSec: 0,
    maxDurationSec: 0,
    sampleRates: {},
    channels: {},
  };

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push({ code: 'manifest-not-object', field: 'manifest', message: '清单必须是一个 JSON 对象' });
    return { errors, warnings, stats };
  }

  if (manifest.schemaVersion === undefined) {
    warnings.push({ code: 'schema-version-missing', field: 'schemaVersion', message: `缺少 schemaVersion，建议填 ${SCHEMA_VERSION}` });
  } else if (Number(manifest.schemaVersion) !== SCHEMA_VERSION) {
    errors.push({ code: 'schema-version-unsupported', field: 'schemaVersion', message: `不支持的清单版本 ${manifest.schemaVersion}` });
  }

  if (!String(manifest.name ?? '').trim()) {
    errors.push({ code: 'name-missing', field: 'name', message: '缺少数据集名称 name' });
  }
  if (!String(manifest.language ?? '').trim()) {
    errors.push({ code: 'language-missing', field: 'language', message: '缺少语言标记 language（如 zh-CN）' });
  }
  if (isPlaceholder(manifest.license)) {
    errors.push({
      code: 'license-missing',
      field: 'license',
      message: '缺少有效的素材授权说明 license：必须写明素材来源、授权范围与授权人（不接受占位值）',
    });
  }

  const consent = manifest.consent;
  if (!consent || typeof consent !== 'object' || Array.isArray(consent)) {
    errors.push({
      code: 'consent-missing',
      field: 'consent',
      message: '缺少 consent 对象：必须声明声音为本人或已获得书面授权，并记录授权范围',
    });
  } else {
    if (consent.obtained !== true) {
      errors.push({
        code: 'consent-not-obtained',
        field: 'consent.obtained',
        message: 'consent.obtained 必须为 true：只能使用本人声音或已获得明确书面授权的声音',
      });
    }
    if (!String(consent.form ?? '').trim()) {
      warnings.push({ code: 'consent-form-missing', field: 'consent.form', message: '建议记录授权形式 consent.form' });
    }
    if (!String(consent.scope ?? '').trim()) {
      warnings.push({ code: 'consent-scope-missing', field: 'consent.scope', message: '建议写明授权范围 consent.scope' });
    }
  }

  const speakers = Array.isArray(manifest.speakers) ? manifest.speakers : null;
  const speakerIds = new Set();
  if (!speakers) {
    errors.push({ code: 'speakers-not-array', field: 'speakers', message: 'speakers 必须是数组' });
  } else if (speakers.length === 0) {
    errors.push({ code: 'speakers-empty', field: 'speakers', message: 'speakers 不能为空，至少需要一个说话人' });
  } else {
    stats.speakers = speakers.length;
    speakers.forEach((speaker, i) => {
      if (!speaker || typeof speaker !== 'object') {
        errors.push({ code: 'speaker-not-object', field: `speakers[${i}]`, message: '说话人必须是对象', index: i });
        return;
      }
      const id = String(speaker.id ?? '').trim();
      if (!id) {
        errors.push({ code: 'speaker-id-missing', field: `speakers[${i}].id`, message: '说话人缺少 id', index: i });
      } else if (!/^[a-z0-9][a-z0-9_-]{1,39}$/i.test(id)) {
        errors.push({
          code: 'speaker-id-invalid',
          field: `speakers[${i}].id`,
          message: `说话人 id「${id}」非法（只允许字母/数字/下划线/连字符，2-40 位）`,
          index: i,
        });
      } else if (speakerIds.has(id.toLowerCase())) {
        errors.push({ code: 'speaker-id-duplicate', field: `speakers[${i}].id`, message: `说话人 id 重复：${id}`, index: i });
      } else {
        speakerIds.add(id.toLowerCase());
      }
      if (speaker.consent && typeof speaker.consent === 'object' && speaker.consent.obtained === false) {
        errors.push({
          code: 'speaker-consent-not-obtained',
          field: `speakers[${i}].consent.obtained`,
          message: `说话人 ${id || i} 的 consent.obtained 为 false：没有授权就不能用于训练`,
          index: i,
        });
      }
    });
  }

  const clips = Array.isArray(manifest.clips) ? manifest.clips : null;
  const seenFiles = new Map();
  if (!clips) {
    errors.push({ code: 'clips-not-array', field: 'clips', message: 'clips 必须是数组' });
  } else if (clips.length === 0) {
    warnings.push({
      code: 'clips-empty',
      field: 'clips',
      message: 'clips 为空：结构合法，但还没有可训练的数据（先跑 make-manifest.mjs 扫描 data/）',
    });
  } else {
    stats.clips = clips.length;
    const durations = [];
    clips.forEach((clip, i) => {
      if (!clip || typeof clip !== 'object') {
        errors.push({ code: 'clip-not-object', field: `clips[${i}]`, message: '音频片段必须是对象', index: i });
        return;
      }
      const rel = normalizeRelPath(clip.file);
      if (!rel) {
        errors.push({ code: 'clip-file-missing', field: `clips[${i}].file`, message: '缺少音频文件相对路径 file', index: i });
      } else if (/^[a-z]:\//i.test(rel) || rel.startsWith('/')) {
        errors.push({ code: 'clip-file-absolute', field: `clips[${i}].file`, message: `file 必须是相对 data/ 的相对路径：${rel}`, index: i });
      } else if (rel.split('/').includes('..')) {
        errors.push({ code: 'clip-file-escape', field: `clips[${i}].file`, message: `file 不允许跳出 data/ 目录：${rel}`, index: i });
      } else {
        const lower = rel.toLowerCase();
        if (!RULES.allowedExtensions.some((ext) => lower.endsWith(ext))) {
          errors.push({
            code: 'clip-file-extension',
            field: `clips[${i}].file`,
            message: `不支持的音频格式（允许：${RULES.allowedExtensions.join(' ')}）：${rel}`,
            index: i,
          });
        }
        if (seenFiles.has(lower)) {
          errors.push({
            code: 'clip-file-duplicate',
            field: `clips[${i}].file`,
            message: `同一文件被登记多次（第 ${seenFiles.get(lower) + 1} 条与第 ${i + 1} 条）：${rel}`,
            index: i,
          });
        } else {
          seenFiles.set(lower, i);
        }
      }

      const speakerRef = String(clip.speaker ?? '').trim();
      if (!speakerRef) {
        errors.push({ code: 'clip-speaker-missing', field: `clips[${i}].speaker`, message: '缺少 speaker 字段', index: i });
      } else if (speakerIds.size > 0 && !speakerIds.has(speakerRef.toLowerCase())) {
        errors.push({ code: 'clip-speaker-unknown', field: `clips[${i}].speaker`, message: `speaker「${speakerRef}」不在 speakers 列表里`, index: i });
      }

      const duration = Number(clip.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        errors.push({ code: 'clip-duration-invalid', field: `clips[${i}].duration`, message: '缺少有效的时长 duration（秒）', index: i });
      } else {
        durations.push(duration);
        if (duration < opts.minSeconds || duration > opts.maxSeconds) {
          const message = `时长 ${duration.toFixed(2)}s 超出建议区间 ${opts.minSeconds}-${opts.maxSeconds}s`;
          if (opts.strictDurations) {
            errors.push({ code: 'clip-duration-out-of-range', field: `clips[${i}].duration`, message, index: i });
          } else {
            warnings.push({ code: 'clip-duration-out-of-range', field: `clips[${i}].duration`, message, index: i });
          }
        }
      }

      if (clip.sampleRate === undefined || clip.sampleRate === null) {
        warnings.push({ code: 'clip-sample-rate-missing', field: `clips[${i}].sampleRate`, message: '建议标注采样率', index: i });
      } else {
        const sr = Number(clip.sampleRate);
        if (!Number.isFinite(sr) || sr <= 0) {
          errors.push({ code: 'clip-sample-rate-invalid', field: `clips[${i}].sampleRate`, message: 'sampleRate 非法', index: i });
        } else {
          stats.sampleRates[String(sr)] = (stats.sampleRates[String(sr)] || 0) + 1;
          if (sr < opts.minSampleRate) {
            errors.push({
              code: 'clip-sample-rate-too-low',
              field: `clips[${i}].sampleRate`,
              message: `采样率 ${sr}Hz 低于最低要求 ${opts.minSampleRate}Hz`,
              index: i,
            });
          }
        }
      }

      if (clip.channels === undefined || clip.channels === null) {
        warnings.push({ code: 'clip-channels-missing', field: `clips[${i}].channels`, message: '建议标注声道数', index: i });
      } else {
        const ch = Number(clip.channels);
        stats.channels[String(ch)] = (stats.channels[String(ch)] || 0) + 1;
        if (ch > RULES.maxChannels) {
          warnings.push({ code: 'clip-not-mono', field: `clips[${i}].channels`, message: `建议降为单声道（当前 ${ch} 声道）`, index: i });
        }
      }

      if (!String(clip.text ?? '').trim()) {
        warnings.push({
          code: 'clip-text-missing',
          field: `clips[${i}].text`,
          message: '缺少转写文本：多数方案需要文本-音频对齐',
          index: i,
        });
      }
    });

    if (clips.length < RULES.minClipCount) {
      warnings.push({
        code: 'clips-few',
        field: 'clips',
        message: `样本量偏少（${clips.length} 条 < 建议 ${RULES.minClipCount} 条）`,
      });
    }

    if (durations.length) {
      const total = durations.reduce((a, b) => a + b, 0);
      stats.totalDurationSec = Math.round(total * 100) / 100;
      stats.avgDurationSec = Math.round((total / durations.length) * 100) / 100;
      stats.minDurationSec = Math.round(Math.min(...durations) * 100) / 100;
      stats.maxDurationSec = Math.round(Math.max(...durations) * 100) / 100;
    }
  }

  return { errors, warnings, stats };
}

/** 对每条音频做文件级校验：存在性 / 头解析 / 与声明核对 / 查重 */
function validateFiles(manifest, dataDir, opts, structureErrors) {
  const errors = [];
  const warnings = [];
  const clipReport = [];
  const seenHashes = new Map();
  const fileErrorIndexes = new Set(
    structureErrors.filter((e) => typeof e.index === 'number' && e.field.startsWith('clips[')).map((e) => e.index),
  );

  const clips = Array.isArray(manifest?.clips) ? manifest.clips : [];
  clips.forEach((clip, i) => {
    const rel = normalizeRelPath(clip?.file);
    if (!rel) {
      clipReport.push({ index: i, file: '(缺少 file)', status: 'fail', reason: '缺少 file 字段' });
      return;
    }

    const abs = resolve(dataDir, rel);
    const inside = abs === resolve(dataDir) || abs.startsWith(resolve(dataDir) + sep);
    if (!inside) {
      clipReport.push({ index: i, file: rel, status: 'fail', reason: '路径越界（不在 data/ 内）' });
      errors.push({ code: 'file-outside-data', field: `clips[${i}].file`, message: `文件路径越界：${rel}`, index: i });
      return;
    }

    if (!existsSync(abs) || !statSync(abs).isFile()) {
      clipReport.push({ index: i, file: rel, status: 'fail', reason: '文件不存在' });
      errors.push({ code: 'file-not-found', field: `clips[${i}].file`, message: `找不到文件：${rel}`, index: i });
      return;
    }

    const buf = readFileSync(abs);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const ext = extname(abs).toLowerCase();
    const probe = probeAudioBuffer(buf, ext);
    const notes = [];
    let status = fileErrorIndexes.has(i) ? 'warn' : 'pass';

    if (!probe.ok) {
      if (probe.reason === 'unsupported-format') {
        warnings.push({
          code: 'probe-unsupported',
          field: `clips[${i}].file`,
          message: `${rel}：${probe.message}`,
          index: i,
        });
        notes.push('未解析头（格式不支持）');
      } else {
        errors.push({
          code: 'audio-header-invalid',
          field: `clips[${i}].file`,
          message: `${rel}：${probe.message}`,
          index: i,
        });
        status = 'fail';
        notes.push(probe.message);
      }
    } else {
      // 与清单声明核对
      if (Number.isFinite(Number(clip.sampleRate)) && Number(clip.sampleRate) > 0) {
        if (Number(clip.sampleRate) !== probe.sampleRate) {
          warnings.push({
            code: 'sample-rate-mismatch',
            field: `clips[${i}].sampleRate`,
            message: `${rel}：清单声明 ${clip.sampleRate}Hz，实际 ${probe.sampleRate}Hz`,
            index: i,
          });
          notes.push(`采样率不符(声明${clip.sampleRate}/实际${probe.sampleRate})`);
        }
      }
      if (Number.isFinite(Number(clip.channels)) && Number(clip.channels) > 0) {
        if (Number(clip.channels) !== probe.channels) {
          warnings.push({
            code: 'channels-mismatch',
            field: `clips[${i}].channels`,
            message: `${rel}：清单声明 ${clip.channels} 声道，实际 ${probe.channels} 声道`,
            index: i,
          });
          notes.push('声道数不符');
        }
      }
      const declaredDuration = Number(clip.duration);
      if (Number.isFinite(declaredDuration) && declaredDuration > 0) {
        const diff = Math.abs(declaredDuration - probe.duration);
        if (diff > Math.max(0.25, probe.duration * 0.05)) {
          warnings.push({
            code: 'duration-mismatch',
            field: `clips[${i}].duration`,
            message: `${rel}：清单声明 ${declaredDuration}s，实际 ${probe.duration}s${probe.estimated ? '（MP3 估算值）' : ''}`,
            index: i,
          });
          notes.push('时长不符');
        }
      }
      // 以真实头为准做阈值检查
      if (probe.sampleRate && probe.sampleRate < opts.minSampleRate) {
        errors.push({
          code: 'audio-sample-rate-too-low',
          field: `clips[${i}].file`,
          message: `${rel}：实际采样率 ${probe.sampleRate}Hz 低于 ${opts.minSampleRate}Hz`,
          index: i,
        });
        status = 'fail';
      }
      if (probe.channels > RULES.maxChannels) {
        warnings.push({
          code: 'audio-not-mono',
          field: `clips[${i}].file`,
          message: `${rel}：实际 ${probe.channels} 声道，建议先降为单声道`,
          index: i,
        });
        notes.push('非单声道');
      }
      if (probe.duration && (probe.duration < opts.minSeconds || probe.duration > opts.maxSeconds)) {
        const message = `${rel}：实际时长 ${probe.duration}s 超出建议区间 ${opts.minSeconds}-${opts.maxSeconds}s`;
        if (opts.strictDurations) {
          errors.push({ code: 'audio-duration-out-of-range', field: `clips[${i}].file`, message, index: i });
          status = 'fail';
        } else {
          warnings.push({ code: 'audio-duration-out-of-range', field: `clips[${i}].file`, message, index: i });
          notes.push('时长越界');
        }
      }
    }

    if (seenHashes.has(sha256)) {
      errors.push({
        code: 'audio-duplicate-content',
        field: `clips[${i}].file`,
        message: `${rel} 与第 ${seenHashes.get(sha256) + 1} 条内容完全相同（sha256 ${sha256.slice(0, 12)}…）`,
        index: i,
      });
      status = 'fail';
      notes.push('内容重复');
    } else {
      seenHashes.set(sha256, i);
    }

    if (clip.sha256 && String(clip.sha256).toLowerCase() !== sha256) {
      warnings.push({
        code: 'sha256-mismatch',
        field: `clips[${i}].sha256`,
        message: `${rel}：清单里的 sha256 与文件实际哈希不一致（文件可能被改过）`,
        index: i,
      });
      notes.push('哈希不符');
    }

    if (status === 'pass' && notes.length) status = 'warn';
    clipReport.push({
      index: i,
      file: rel,
      status,
      notes,
      probe: probe.ok ? probe : null,
      sha256,
      size: buf.length,
    });
  });

  return { errors, warnings, clipReport };
}

function formatProbe(probe) {
  if (!probe) return '';
  const parts = [];
  if (probe.duration) parts.push(`${probe.duration}s${probe.estimated ? '(估算)' : ''}`);
  if (probe.sampleRate) parts.push(`${probe.sampleRate}Hz`);
  if (probe.channels) parts.push(`${probe.channels}ch`);
  if (probe.bitsPerSample) parts.push(`${probe.bitsPerSample}bit`);
  return parts.join(' ');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[用法错误] ${err.message}\n`);
    console.error(HELP);
    process.exit(EXIT.USAGE);
  }

  if (opts.help) {
    console.log(HELP);
    process.exit(EXIT.OK);
  }

  for (const [key, value] of [
    ['--min-seconds', opts.minSeconds],
    ['--max-seconds', opts.maxSeconds],
    ['--min-sample-rate', opts.minSampleRate],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      console.error(`[用法错误] ${key} 必须是正数`);
      process.exit(EXIT.USAGE);
    }
  }

  const dataDir = opts.dataDir;
  if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
    console.error(`[数据目录不存在] ${dataDir}`);
    console.error('请创建 voice-training/data/ 并把你自己拥有授权的音频放进去（data/** 已被 .gitignore 排除）。');
    process.exit(EXIT.MISSING);
  }

  const manifestPath = findManifest(opts.manifest, dataDir);
  if (!manifestPath) {
    console.error(`[清单文件不存在] 已尝试：${opts.manifest || 'voice-training/manifests/dataset.manifest.json 与 <data>/manifest.json'}`);
    console.error('请先运行：node voice-training/scripts/make-manifest.mjs');
    process.exit(EXIT.MISSING);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`[清单解析失败] ${manifestPath}\n${err.message}`);
    process.exit(EXIT.ERRORS);
  }

  const structure = validateStructure(manifest, opts);
  const files = validateFiles(manifest, dataDir, opts, structure.errors);

  const errors = [...structure.errors, ...files.errors];
  const warnings = [...structure.warnings, ...files.warnings];
  const result = {
    ok: errors.length === 0,
    dataDir,
    manifest: manifestPath,
    errorCount: errors.length,
    warningCount: warnings.length,
    errors,
    warnings,
    stats: structure.stats,
    clips: files.clipReport,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? EXIT.OK : EXIT.ERRORS);
  }

  const line = '─'.repeat(64);
  console.log(line);
  console.log('声音训练数据集校验（只读·离线·零依赖）');
  console.log(line);
  console.log(`数据目录：${dataDir}`);
  console.log(`清单文件：${manifestPath}`);
  console.log(`数据集名：${manifest?.name ?? '(缺失)'}   语言：${manifest?.language ?? '(缺失)'}`);
  console.log(
    `规则：单条 ${opts.minSeconds}-${opts.maxSeconds}s · 最低 ${opts.minSampleRate}Hz · 单声道 · 时长越界${opts.strictDurations ? '按错误' : '按警告'}`,
  );

  if (!opts.quiet) {
    console.log('');
    console.log('—— 逐条音频 ——');
    if (!files.clipReport.length) console.log('  (无音频条目)');
    for (const item of files.clipReport) {
      const tag = item.status === 'pass' ? '通过' : item.status === 'warn' ? '警告' : '失败';
      const meta = formatProbe(item.probe);
      const note = item.notes?.length ? `  ← ${item.notes.join('；')}` : '';
      console.log(`  [${tag}] ${item.file}${meta ? `  ${meta}` : ''}${note}`);
    }
  }

  console.log('');
  console.log('—— 错误 ——');
  if (!errors.length) console.log('  (无)');
  for (const e of errors) console.log(`  [${e.code}] ${e.field}: ${e.message}`);

  console.log('');
  console.log('—— 警告 ——');
  if (!warnings.length) console.log('  (无)');
  for (const w of warnings) console.log(`  [${w.code}] ${w.field}: ${w.message}`);

  const s = structure.stats;
  console.log('');
  console.log(
    `统计：说话人 ${s.speakers} · 片段 ${s.clips} · 总时长 ${s.totalDurationSec}s · 平均 ${s.avgDurationSec}s · 区间 ${s.minDurationSec}-${s.maxDurationSec}s`,
  );
  console.log('');
  console.log(`结果：${result.ok ? '通过（结构+音频均合格）' : `失败（${errors.length} 个错误）`}；警告 ${warnings.length} 条`);
  console.log('提醒：仓库只提供工具链，不提供任何权重与音频；请确认素材为本人声音或已获书面授权，并自行核实当地法律。');
  console.log(line);

  process.exit(result.ok ? EXIT.OK : EXIT.ERRORS);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error('[内部错误]', err?.stack || err);
    process.exit(EXIT.INTERNAL);
  }
}

export { validateStructure, validateFiles, findManifest, HELP };
