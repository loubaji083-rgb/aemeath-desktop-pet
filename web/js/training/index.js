/**
 * Training —— 声音训练工具链（契约 §6）。
 *
 * 定位（用户已确认的边界，务必保持）：
 *  - 本仓库**只提供流程，不提供权重，不提供音频**；
 *  - 不做任何声音克隆推理，不下载任何预训练模型，不爬取任何音频素材；
 *  - 训练数据规范见 voice-training/SCHEMA.md；
 *  - 训练数据与产物全部落在 voice-training/data/（已 gitignore，不进仓库）；
 *  - 训练后端是**外部 HTTP 端点**，由用户自行部署并自行确认素材授权与当地法律。
 *
 * 本模块只做：清单校验（纯函数）、模板生成、音频元信息探测、外部后端对接、产物元数据导出。
 * 注意：submitJob 只上传**元数据**，绝不上传音频二进制（隐私默认值）。
 */

import { emit, AppEvents } from '../core/events.js';
import { DEFAULTS, Settings } from '../core/settings.js';

export const VERSION = '1.0.0';
export const SCHEMA_VERSION = 1;

/** 默认校验规则（纯常量；可被 validateManifest 的第二个参数覆盖） */
export const DEFAULT_RULES = Object.freeze({
  minClipSeconds: DEFAULTS['train.minClipSeconds'],
  maxClipSeconds: DEFAULTS['train.maxClipSeconds'],
  minSampleRate: 16000,
  targetSampleRate: DEFAULTS['train.targetSampleRate'],
  maxChannels: 1,
  minClipCount: 10,
  allowedExtensions: ['.wav', '.flac', '.mp3', '.m4a', '.ogg', '.opus', '.webm'],
  /** 这些字符串出现在 license 字段里视为「没填」 */
  placeholderValues: [
    'todo',
    'tbd',
    'n/a',
    'na',
    'none',
    'unknown',
    'placeholder',
    '待填',
    '待定',
    '未填写',
    '无',
    '未知',
    '示例',
  ],
});

const CONSENT_FORMS = ['written', 'verbal-recorded', 'self', 'other'];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPlaceholder(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return true;
  return DEFAULT_RULES.placeholderValues.some((p) => {
    // 用「非字母数字/汉字边界」包住占位词，这样：
    //   '待填'        → 命中（整串）
    //   '来源：待填'  → 命中（后缀形态 —— 这是回归哨兵 tests/training.test.mjs:181 的用例）
    //   '来源：todo'  → 命中
    //   'todo list'   → 命中
    //   '没有版权'    → 不命中（'无' 左侧是汉字，不算边界；避免把正常中文误判成占位）
    // 注意：不能用 `\b` —— 它对汉字不生效（'待填' 两侧都是 \W，\b 无法定位）。
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'u');
    return re.test(s);
  });
}

function pushError(list, code, field, message, index) {
  list.push(index === undefined ? { code, field, message } : { code, field, message, index });
}

/** 归一化相对路径：统一分隔符、去掉 ./ 前缀 */
export function normalizeClipPath(file) {
  return String(file ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

/**
 * 校验一份数据集清单（纯函数，可单测，无 DOM / 无网络依赖）。
 *
 * @param {object} manifest
 * @param {{
 *   minClipSeconds?:number, maxClipSeconds?:number, minSampleRate?:number,
 *   maxChannels?:number, minClipCount?:number, allowedExtensions?:string[],
 *   strictDurations?:boolean, requireClips?:boolean,
 * }} [options]
 * @returns {{ ok:boolean, errors:Array<object>, warnings:Array<object>, stats:object }}
 */
export function validateManifest(manifest, options = {}) {
  const rules = { ...DEFAULT_RULES, ...options };
  const errors = [];
  const warnings = [];

  const stats = {
    speakers: 0,
    clips: 0,
    totalDurationSec: 0,
    avgDurationSec: 0,
    minDurationSec: 0,
    maxDurationSec: 0,
    languages: [],
    sampleRates: {},
    channels: {},
    duplicateHashes: 0,
    estimatedTrainingMinutes: 0,
  };

  if (!isPlainObject(manifest)) {
    pushError(errors, 'manifest-not-object', 'manifest', '清单必须是一个 JSON 对象');
    return { ok: false, errors, warnings, stats };
  }

  // —— 顶层字段 ——
  if (manifest.schemaVersion === undefined) {
    warnings.push({
      code: 'schema-version-missing',
      field: 'schemaVersion',
      message: `缺少 schemaVersion，建议填写 ${SCHEMA_VERSION}`,
    });
  } else if (Number(manifest.schemaVersion) !== SCHEMA_VERSION) {
    pushError(
      errors,
      'schema-version-unsupported',
      'schemaVersion',
      `不支持的清单版本 ${manifest.schemaVersion}，当前工具链只认 ${SCHEMA_VERSION}`,
    );
  }

  if (!String(manifest.name ?? '').trim()) {
    pushError(errors, 'name-missing', 'name', '缺少数据集名称 name');
  }

  if (!String(manifest.language ?? '').trim()) {
    pushError(errors, 'language-missing', 'language', '缺少语言标记 language（如 zh-CN）');
  } else {
    stats.languages.push(String(manifest.language).trim());
  }

  if (isPlaceholder(manifest.license)) {
    pushError(
      errors,
      'license-missing',
      'license',
      '缺少有效的素材授权说明 license：必须写明素材来源、授权范围与授权人（不接受 TODO/待填/未知 等占位值）',
    );
  }

  // —— 授权与告知同意（红线：必须有） ——
  const consent = manifest.consent;
  if (!isPlainObject(consent)) {
    pushError(
      errors,
      'consent-missing',
      'consent',
      '缺少 consent 对象：必须声明「声音为本人或已获得书面授权」，并记录授权范围',
    );
  } else {
    if (consent.obtained !== true) {
      pushError(
        errors,
        'consent-not-obtained',
        'consent.obtained',
        'consent.obtained 必须为 true：只能使用本人声音或已获得明确书面授权的声音',
      );
    }
    if (!String(consent.form ?? '').trim()) {
      warnings.push({
        code: 'consent-form-missing',
        field: 'consent.form',
        message: `建议记录授权形式 consent.form（可选值：${CONSENT_FORMS.join(' / ')}）`,
      });
    }
    if (!String(consent.scope ?? '').trim()) {
      warnings.push({
        code: 'consent-scope-missing',
        field: 'consent.scope',
        message: '建议写明授权范围 consent.scope（例如「仅本地个人使用，不再分发」）',
      });
    }
  }

  // —— 说话人 ——
  const speakers = Array.isArray(manifest.speakers) ? manifest.speakers : null;
  const speakerIds = new Set();
  if (!speakers) {
    pushError(errors, 'speakers-not-array', 'speakers', 'speakers 必须是数组');
  } else if (speakers.length === 0) {
    pushError(errors, 'speakers-empty', 'speakers', 'speakers 不能为空，至少需要一个说话人（如 speaker-a）');
  } else {
    stats.speakers = speakers.length;
    speakers.forEach((speaker, i) => {
      if (!isPlainObject(speaker)) {
        pushError(errors, 'speaker-not-object', `speakers[${i}]`, '说话人必须是对象', i);
        return;
      }
      const id = String(speaker.id ?? '').trim();
      if (!id) {
        pushError(errors, 'speaker-id-missing', `speakers[${i}].id`, '说话人缺少 id', i);
      } else if (!/^[a-z0-9][a-z0-9_-]{1,39}$/i.test(id)) {
        pushError(
          errors,
          'speaker-id-invalid',
          `speakers[${i}].id`,
          `说话人 id「${id}」非法：只能用字母/数字/下划线/连字符，2-40 位，且不能以符号开头`,
          i,
        );
      } else if (speakerIds.has(id.toLowerCase())) {
        pushError(errors, 'speaker-id-duplicate', `speakers[${i}].id`, `说话人 id 重复：${id}`, i);
      } else {
        speakerIds.add(id.toLowerCase());
      }
      if (!String(speaker.language ?? '').trim()) {
        warnings.push({
          code: 'speaker-language-missing',
          field: `speakers[${i}].language`,
          message: '建议为每个说话人标注语言',
          index: i,
        });
      }
      if (isPlainObject(speaker.consent) && speaker.consent.obtained === false) {
        pushError(
          errors,
          'speaker-consent-not-obtained',
          `speakers[${i}].consent.obtained`,
          `说话人 ${id || i} 的 consent.obtained 为 false：没有授权就不能用于训练`,
          i,
        );
      }
    });
  }

  // —— 音频片段 ——
  const clips = Array.isArray(manifest.clips) ? manifest.clips : null;
  const seenFiles = new Map();
  const seenHashes = new Map();
  const durations = [];

  if (!clips) {
    pushError(errors, 'clips-not-array', 'clips', 'clips 必须是数组');
  } else if (clips.length === 0) {
    const entry = {
      code: 'clips-empty',
      field: 'clips',
      message: 'clips 为空：结构合法，但还没有可训练的数据（用 make-manifest.mjs 扫描 data/ 生成）',
    };
    if (rules.requireClips) pushError(errors, entry.code, entry.field, entry.message);
    else warnings.push(entry);
  } else {
    stats.clips = clips.length;
    clips.forEach((clip, i) => {
      if (!isPlainObject(clip)) {
        pushError(errors, 'clip-not-object', `clips[${i}]`, '音频片段必须是对象', i);
        return;
      }

      const rel = normalizeClipPath(clip.file);
      if (!rel) {
        pushError(errors, 'clip-file-missing', `clips[${i}].file`, '缺少音频文件相对路径 file', i);
      } else if (/^[a-z]:\//i.test(rel) || rel.startsWith('/')) {
        pushError(
          errors,
          'clip-file-absolute',
          `clips[${i}].file`,
          `file 必须是相对 voice-training/data/ 的相对路径，不允许绝对路径：${rel}`,
          i,
        );
      } else if (rel.split('/').includes('..')) {
        pushError(errors, 'clip-file-escape', `clips[${i}].file`, `file 不允许跳出 data/ 目录：${rel}`, i);
      } else {
        const lower = rel.toLowerCase();
        const okExt = rules.allowedExtensions.some((ext) => lower.endsWith(ext));
        if (!okExt) {
          pushError(
            errors,
            'clip-file-extension',
            `clips[${i}].file`,
            `不支持的音频格式（允许：${rules.allowedExtensions.join(' ')}）：${rel}`,
            i,
          );
        }
        if (seenFiles.has(lower)) {
          pushError(
            errors,
            'clip-file-duplicate',
            `clips[${i}].file`,
            `同一个文件被登记了多次（第 ${seenFiles.get(lower) + 1} 条与第 ${i + 1} 条）：${rel}`,
            i,
          );
        } else {
          seenFiles.set(lower, i);
        }
      }

      const speakerRef = String(clip.speaker ?? '').trim();
      if (!speakerRef) {
        pushError(errors, 'clip-speaker-missing', `clips[${i}].speaker`, '缺少 speaker 字段', i);
      } else if (speakers && speakerIds.size > 0 && !speakerIds.has(speakerRef.toLowerCase())) {
        pushError(
          errors,
          'clip-speaker-unknown',
          `clips[${i}].speaker`,
          `speaker「${speakerRef}」不在 speakers 列表里`,
          i,
        );
      }

      const duration = Number(clip.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        pushError(errors, 'clip-duration-invalid', `clips[${i}].duration`, '缺少有效的时长 duration（秒）', i);
      } else {
        durations.push(duration);
        const tooShort = duration < Number(rules.minClipSeconds);
        const tooLong = duration > Number(rules.maxClipSeconds);
        if (tooShort || tooLong) {
          const message = `时长 ${duration.toFixed(2)}s 超出建议区间 ${rules.minClipSeconds}-${rules.maxClipSeconds}s`;
          if (rules.strictDurations) pushError(errors, 'clip-duration-out-of-range', `clips[${i}].duration`, message, i);
          else warnings.push({ code: 'clip-duration-out-of-range', field: `clips[${i}].duration`, message, index: i });
        }
      }

      if (clip.sampleRate === undefined || clip.sampleRate === null) {
        warnings.push({
          code: 'clip-sample-rate-missing',
          field: `clips[${i}].sampleRate`,
          message: '建议标注采样率 sampleRate，便于统一重采样到目标采样率',
          index: i,
        });
      } else {
        const sr = Number(clip.sampleRate);
        if (!Number.isFinite(sr) || sr <= 0) {
          pushError(errors, 'clip-sample-rate-invalid', `clips[${i}].sampleRate`, 'sampleRate 非法', i);
        } else {
          stats.sampleRates[String(sr)] = (stats.sampleRates[String(sr)] || 0) + 1;
          if (sr < rules.minSampleRate) {
            pushError(
              errors,
              'clip-sample-rate-too-low',
              `clips[${i}].sampleRate`,
              `采样率 ${sr}Hz 低于最低要求 ${rules.minSampleRate}Hz`,
              i,
            );
          }
        }
      }

      if (clip.channels === undefined || clip.channels === null) {
        warnings.push({
          code: 'clip-channels-missing',
          field: `clips[${i}].channels`,
          message: '建议标注声道数 channels（训练数据应为单声道）',
          index: i,
        });
      } else {
        const ch = Number(clip.channels);
        stats.channels[String(ch)] = (stats.channels[String(ch)] || 0) + 1;
        if (ch > Number(rules.maxChannels)) {
          warnings.push({
            code: 'clip-not-mono',
            field: `clips[${i}].channels`,
            message: `建议先降为单声道（当前 ${ch} 声道）`,
            index: i,
          });
        }
      }

      if (!String(clip.text ?? '').trim()) {
        warnings.push({
          code: 'clip-text-missing',
          field: `clips[${i}].text`,
          message: '缺少转写文本 text：多数训练方案需要文本-音频对齐，缺转写会显著影响质量',
          index: i,
        });
      }

      const hash = String(clip.sha256 ?? clip.hash ?? '').trim().toLowerCase();
      if (hash) {
        if (seenHashes.has(hash)) {
          stats.duplicateHashes += 1;
          pushError(
            errors,
            'clip-hash-duplicate',
            `clips[${i}].sha256`,
            `内容重复（与第 ${seenHashes.get(hash) + 1} 条同哈希）：同一段音频不要重复入训`,
            i,
          );
        } else {
          seenHashes.set(hash, i);
        }
      }
    });

    if (clips.length < Number(rules.minClipCount)) {
      warnings.push({
        code: 'clips-few',
        field: 'clips',
        message: `样本量偏少（${clips.length} 条 < 建议 ${rules.minClipCount} 条）：微调通常需要 10 分钟以上干净语音`,
      });
    }
  }

  if (durations.length) {
    const total = durations.reduce((a, b) => a + b, 0);
    stats.totalDurationSec = Math.round(total * 100) / 100;
    stats.avgDurationSec = Math.round((total / durations.length) * 100) / 100;
    stats.minDurationSec = Math.round(Math.min(...durations) * 100) / 100;
    stats.maxDurationSec = Math.round(Math.max(...durations) * 100) / 100;
    stats.estimatedTrainingMinutes = Math.round((total / 60) * 100) / 100;
  }

  return { ok: errors.length === 0, errors, warnings, stats };
}

/**
 * 生成清单模板（纯函数）。
 * 默认 clips 为空：模板本身通过结构校验，但会带一条 clips-empty 警告。
 *
 * @param {{ name?:string, language?:string, speakerIds?:string[], clips?:Array<object> }} [opts]
 */
export function createManifestTemplate(opts = {}) {
  const name = String(opts.name || 'my-voice-dataset').trim();
  const language = String(opts.language || 'zh-CN').trim();
  const speakerIds = Array.isArray(opts.speakerIds) && opts.speakerIds.length ? opts.speakerIds : ['speaker-a'];
  const speakers = speakerIds.map((id) => ({
    id: String(id),
    displayName: `示例说话人 ${String(id).toUpperCase()}`,
    language,
    // 占位说明：真实使用时必须改成你自己声音，或已获得书面授权的声音
    isSelf: true,
    consent: {
      obtained: true,
      form: 'written',
      date: '',
      scope: '仅用于本地个人桌宠语音模型训练，不再分发',
    },
  }));

  return {
    schemaVersion: SCHEMA_VERSION,
    name,
    language,
    license:
      '示例占位：请改写为真实授权说明，例如「说话人本人书面授权，仅用于本地个人非商业用途，不再分发」',
    consent: {
      obtained: true,
      subject: speakers[0]?.id || 'speaker-a',
      form: 'written',
      date: '',
      scope: '仅用于本地个人桌宠语音模型训练，不再分发',
      note: '只能使用本人声音或已获得明确书面授权的声音；请勿使用任何第三方作品/声优的声音素材。',
    },
    speakers,
    clips: Array.isArray(opts.clips) ? opts.clips : [],
    notes:
      '本文件只是清单模板，不含任何音频。音频放在 voice-training/data/<speaker>/ 下（data/** 已被 .gitignore 排除）。',
  };
}

/**
 * 探测一份音频文件的元信息（需要 WebAudio）。
 * @param {File|Blob} file
 * @returns {Promise<{ok:boolean, duration?:number, sampleRate?:number, channels?:number, peakDb?:number, name?:string, size?:number, reason?:string, message?:string}>}
 */
export async function probeAudio(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    return { ok: false, reason: 'not-a-file', message: 'probeAudio 需要一个 File/Blob' };
  }
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioCtx !== 'function') {
    return { ok: false, reason: 'no-webaudio', message: '当前环境没有 WebAudio（AudioContext）' };
  }

  let arrayBuffer = null;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch (err) {
    return { ok: false, reason: 'read-failed', message: `读取文件失败：${err?.message || err}` };
  }

  const ctx = new AudioCtx();
  try {
    const audio = await ctx.decodeAudioData(arrayBuffer);
    const channels = audio.numberOfChannels;
    const length = audio.length;
    let peak = 0;
    // 长音频按步长抽样算峰值，避免几十万次循环卡住 UI（峰值估算足够）
    const step = Math.max(1, Math.floor(length / 200000));
    for (let c = 0; c < channels; c += 1) {
      const data = audio.getChannelData(c);
      for (let i = 0; i < data.length; i += step) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
    }
    const peakDb = peak > 0 ? Math.round(20 * Math.log10(peak) * 100) / 100 : -100;
    return {
      ok: true,
      duration: Math.round(audio.duration * 1000) / 1000,
      sampleRate: audio.sampleRate,
      channels,
      peakDb,
      name: file.name || '',
      size: file.size || 0,
      type: file.type || '',
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'decode-failed',
      message: `WebAudio 无法解码该文件（可能是格式不受支持或文件损坏）：${err?.message || err}`,
    };
  } finally {
    try {
      await ctx.close?.();
    } catch {
      /* ignore */
    }
  }
}

/** 只保留元数据，杜绝任何音频二进制流出去 */
function stripClip(clip) {
  if (!isPlainObject(clip)) return null;
  return {
    file: normalizeClipPath(clip.file),
    speaker: String(clip.speaker ?? ''),
    text: String(clip.text ?? ''),
    duration: Number(clip.duration) || 0,
    sampleRate: Number(clip.sampleRate) || 0,
    channels: Number(clip.channels) || 0,
    sha256: String(clip.sha256 ?? clip.hash ?? ''),
  };
}

function stripManifest(manifest) {
  if (!isPlainObject(manifest)) return null;
  const { clips, ...rest } = manifest;
  return { ...rest, clips: Array.isArray(clips) ? clips.map(stripClip).filter(Boolean) : [] };
}

async function postJson(url, payload, { timeoutMs = 30000, fetchImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, reason: 'no-fetch', message: '当前环境没有可用的 fetch' };
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: 'http-error',
        status: res.status,
        detail: data?.message || data?.error || `HTTP ${res.status}`,
      };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, reason: 'request-failed', detail: err?.message || String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 向外部训练后端提交任务。
 * 只提交元数据（清单 + 片段信息 + 训练参数），**不上传音频**。
 *
 * @param {{ endpoint?:string, manifest?:object, clips?:Array<object>, options?:object, fetchImpl?:Function, timeoutMs?:number }} params
 * @returns {Promise<{ok:boolean, reason?:string, jobId?:string, status?:number, data?:object, errors?:Array<object>}>}
 */
export async function submitJob({ endpoint, manifest, clips, options, fetchImpl, timeoutMs } = {}) {
  const url = String(endpoint || Settings.get('train.endpoint', '') || '').trim();
  if (!url) {
    return {
      ok: false,
      reason: 'no-endpoint',
      message: '未配置训练后端端点（设置 → 声音训练 → 训练端点）；本仓库不提供任何训练服务与权重',
    };
  }

  const check = validateManifest(manifest);
  if (!check.ok) {
    return { ok: false, reason: 'invalid-manifest', errors: check.errors, warnings: check.warnings };
  }

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'aemeath-voice-training-job',
    manifest: stripManifest(manifest),
    clips: (Array.isArray(clips) ? clips : manifest.clips || []).map(stripClip).filter(Boolean),
    options: isPlainObject(options) ? options : {},
    client: {
      name: 'aemeath-desktop-pet',
      version: VERSION,
      note: '仅提交元数据，不含任何音频二进制；音频是否上传由用户在自己的训练后端决定',
    },
  };

  const res = await postJson(url, payload, { fetchImpl, timeoutMs });
  if (!res.ok) return res;

  const data = res.data || {};
  const jobId = data.jobId || data.id || data.job_id || '';
  emit(AppEvents.TOAST, { text: jobId ? `已提交训练任务：${jobId}` : '已提交训练任务', kind: 'ok', ms: 3200 });
  return { ok: true, status: res.status, jobId: String(jobId), data, warnings: check.warnings };
}

/**
 * 轮询训练任务状态。
 * @param {{ endpoint?:string, jobId?:string, fetchImpl?:Function, timeoutMs?:number }} params
 */
export async function pollJob({ endpoint, jobId, fetchImpl, timeoutMs = 15000 } = {}) {
  const base = String(endpoint || Settings.get('train.queueEndpoint', '') || Settings.get('train.endpoint', '') || '').trim();
  if (!base || !jobId) {
    return { ok: false, reason: 'no-endpoint', message: '缺少训练后端端点或 jobId' };
  }
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, reason: 'no-fetch', message: '当前环境没有可用的 fetch' };
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const clean = base.replace(/\/+$/, '');
  const urls = [
    `${clean}/${encodeURIComponent(jobId)}`,
    `${clean}?jobId=${encodeURIComponent(jobId)}`,
  ];

  try {
    let last = null;
    for (const url of urls) {
      try {
        const res = await fetchFn(url, { method: 'GET', signal: controller ? controller.signal : undefined });
        if (res.status === 404 || res.status === 405) {
          last = { ok: false, reason: 'http-error', status: res.status };
          continue;
        }
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (!res.ok) {
          return { ok: false, reason: 'http-error', status: res.status, detail: data?.message || `HTTP ${res.status}` };
        }
        return {
          ok: true,
          status: res.status,
          jobId: String(jobId),
          state: data?.state || data?.status || 'unknown',
          progress: Number.isFinite(Number(data?.progress)) ? Number(data.progress) : null,
          data,
        };
      } catch (err) {
        last = { ok: false, reason: 'request-failed', detail: err?.message || String(err) };
      }
    }
    return last || { ok: false, reason: 'request-failed', detail: '轮询失败' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 导出训练产物元数据（recipe）：**不含音频、不含权重**，可安全分享/备份。
 *
 * @param {object} manifest
 * @param {{ backend?:string, options?:object, includeTranscript?:boolean }} [opts]
 */
export function exportRecipe(manifest, opts = {}) {
  const options = isPlainObject(opts.options) ? opts.options : {};
  const check = validateManifest(manifest);
  const m = isPlainObject(manifest) ? manifest : {};
  const clips = Array.isArray(m.clips) ? m.clips : [];

  return {
    kind: 'aemeath-voice-training-recipe',
    schemaVersion: SCHEMA_VERSION,
    toolVersion: VERSION,
    generatedAt: new Date().toISOString(),
    backend: String(opts.backend || options.backend || 'external-http'),
    dataset: {
      name: String(m.name || ''),
      language: String(m.language || ''),
      clipCount: clips.length,
      speakerCount: Array.isArray(m.speakers) ? m.speakers.length : 0,
      totalDurationSec: check.stats.totalDurationSec,
      avgDurationSec: check.stats.avgDurationSec,
      minDurationSec: check.stats.minDurationSec,
      maxDurationSec: check.stats.maxDurationSec,
      speakers: (Array.isArray(m.speakers) ? m.speakers : []).map((s) => ({
        id: String(s?.id || ''),
        language: String(s?.language || ''),
      })),
      clips: clips.map((clip) => {
        const base = stripClip(clip);
        if (!base) return null;
        if (!opts.includeTranscript) delete base.text; // 默认不导出转写文本，降低隐私暴露面
        return base;
      }).filter(Boolean),
    },
    license: String(m.license || ''),
    consent: isPlainObject(m.consent) ? { ...m.consent } : null,
    training: {
      targetSampleRate: Number(options.targetSampleRate || DEFAULTS['train.targetSampleRate']),
      minClipSeconds: Number(options.minClipSeconds || DEFAULTS['train.minClipSeconds']),
      maxClipSeconds: Number(options.maxClipSeconds || DEFAULTS['train.maxClipSeconds']),
      epochs: options.epochs ?? null,
      batchSize: options.batchSize ?? null,
      learningRate: options.learningRate ?? null,
      extra: isPlainObject(options.extra) ? options.extra : {},
    },
    validation: {
      ok: check.ok,
      errorCount: check.errors.length,
      warningCount: check.warnings.length,
    },
    privacy: {
      containsAudio: false,
      containsModelWeights: false,
      containsTranscript: !!opts.includeTranscript,
      note: '本文件只有元数据；音频与权重永远不进仓库，也不会被本模块上传。',
    },
    disclaimer:
      '本工具链只提供流程。请确认素材为本人声音或已获得书面授权，并自行核实当地关于声音权与个人信息保护的法律要求。',
  };
}

export const Training = {
  version: VERSION,
  SCHEMA_VERSION,
  DEFAULT_RULES,
  validateManifest,
  createManifestTemplate,
  probeAudio,
  submitJob,
  pollJob,
  exportRecipe,
};

export default Training;
