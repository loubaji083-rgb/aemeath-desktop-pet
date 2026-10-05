/**
 * 纯 Node 音频头解析（零依赖）。
 *
 * 只读取**文件头**来推断采样率 / 声道 / 时长，不解码音频、不写文件、不联网。
 * 支持：WAV（RIFF/WAVE）、FLAC（STREAMINFO）、MP3（尽力估算帧头）。
 * 其它格式（m4a/ogg/opus/webm）返回 { ok:false, reason:'unsupported-format' }，
 * 由调用方决定是警告还是失败 —— 不假装能解析。
 *
 * 为什么不用 ffmpeg：本仓库要求零依赖、零外部可执行文件，工具链必须在裸 Node 上跑得起来。
 */

export const SUPPORTED_EXTENSIONS = ['.wav', '.flac', '.mp3'];

export const HEADER_SUPPORTED_EXTENSIONS = ['.wav', '.flac', '.mp3', '.m4a', '.ogg', '.opus', '.webm'];

function fail(reason, message) {
  return { ok: false, reason, message };
}

/** 读 WAV 头 */
export function probeWav(buf) {
  if (buf.length < 44) return fail('invalid-header', '文件太小，不是有效的 WAV');
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    return fail('invalid-header', '不是 RIFF/WAVE 文件');
  }

  let offset = 12;
  let fmt = null;
  let dataSize = 0;
  let guard = 0;

  while (offset + 8 <= buf.length && guard < 256) {
    guard += 1;
    const id = buf.toString('latin1', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        blockAlign: buf.readUInt16LE(body + 12),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataSize = Math.min(size, Math.max(0, buf.length - body));
      break;
    }

    const advance = size + (size % 2);
    if (advance <= 0 && id !== 'data') break;
    offset = body + advance;
  }

  if (!fmt) return fail('invalid-header', 'WAV 缺少 fmt 数据块');
  if (!fmt.sampleRate || !fmt.channels) return fail('invalid-header', 'WAV 头里的采样率/声道数非法');

  const bytesPerSecond =
    fmt.byteRate ||
    fmt.sampleRate * fmt.channels * Math.max(8, fmt.bitsPerSample || fmt.blockAlign * 8 || 16) / 8;
  const duration = bytesPerSecond > 0 ? dataSize / bytesPerSecond : 0;

  return {
    ok: true,
    format: 'wav',
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample || 0,
    audioFormat: fmt.audioFormat,
    duration: Math.round(duration * 1000) / 1000,
    dataBytes: dataSize,
    estimated: false,
  };
}

/** 读 FLAC 头的 STREAMINFO */
export function probeFlac(buf) {
  if (buf.length < 42 || buf.toString('latin1', 0, 4) !== 'fLaC') {
    return fail('invalid-header', '不是 FLAC 文件（缺少 fLaC 标记）');
  }

  let offset = 4;
  let streamInfo = null;
  let guard = 0;

  while (offset + 4 <= buf.length && guard < 512) {
    guard += 1;
    const header = buf[offset];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
    const body = offset + 4;

    if (type === 0 && body + 18 <= buf.length) {
      // STREAMINFO 前 18 字节就够拿到采样率/声道/总样本数
      const b = (i) => buf[body + i];
      const sampleRate = (b(10) << 12) | (b(11) << 4) | (b(12) >> 4);
      const channels = ((b(12) >> 1) & 0x07) + 1;
      const bitsPerSample = (((b(12) & 0x01) << 4) | (b(13) >> 4)) + 1;
      const totalSamples =
        (b(13) & 0x0f) * 4294967296 + b(14) * 16777216 + b(15) * 65536 + b(16) * 256 + b(17);
      streamInfo = { sampleRate, channels, bitsPerSample, totalSamples };
    }

    if (isLast) break;
    offset = body + length;
  }

  if (!streamInfo || !streamInfo.sampleRate) return fail('invalid-header', 'FLAC 缺少可用的 STREAMINFO');

  const duration = streamInfo.totalSamples > 0 ? streamInfo.totalSamples / streamInfo.sampleRate : 0;
  return {
    ok: true,
    format: 'flac',
    sampleRate: streamInfo.sampleRate,
    channels: streamInfo.channels,
    bitsPerSample: streamInfo.bitsPerSample,
    duration: Math.round(duration * 1000) / 1000,
    totalSamples: streamInfo.totalSamples,
    estimated: false,
  };
}

const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MPEG1_RATES = [44100, 48000, 32000, 0];
const MPEG2_RATES = [22050, 24000, 16000, 0];
const MPEG25_RATES = [11025, 12000, 8000, 0];

/**
 * MP3 尽力估算：跳过 ID3v2，找到第一个合法帧头，按 CBR 位速率估算时长。
 * VBR 文件会不准，因此返回 estimated:true，仅用于给出数量级参考。
 */
export function probeMp3(buf) {
  let start = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size =
      ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + size;
  }

  const limit = Math.min(buf.length - 4, start + 200000); // 只在开头 200KB 里找帧头
  for (let i = start; i < limit; i += 1) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const b1 = buf[i + 1];
    const b2 = buf[i + 2];
    const versionBits = (b1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layerBits = (b1 >> 1) & 0x03; // 1=Layer3
    const bitrateIndex = (b2 >> 4) & 0x0f;
    const rateIndex = (b2 >> 2) & 0x03;
    if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      continue;
    }
    const rates = versionBits === 3 ? MPEG1_RATES : versionBits === 2 ? MPEG2_RATES : MPEG25_RATES;
    const sampleRate = rates[rateIndex];
    if (!sampleRate) continue;
    const bitrates = versionBits === 3 ? MPEG1_L3_BITRATES : MPEG2_L3_BITRATES;
    const bitrateKbps = bitrates[bitrateIndex];
    if (!bitrateKbps) continue;

    const audioBytes = Math.max(0, buf.length - i);
    const duration = (audioBytes * 8) / (bitrateKbps * 1000);
    return {
      ok: true,
      format: 'mp3',
      sampleRate,
      channels: ((b2 >> 6) & 0x03) === 3 ? 1 : 2,
      bitrateKbps,
      duration: Math.round(duration * 1000) / 1000,
      estimated: true,
      note: 'MP3 时长按首个帧头的位速率估算，VBR 文件会有偏差',
    };
  }

  return fail('invalid-header', '在文件头部 200KB 内没有找到合法的 MP3 帧头');
}

/**
 * 按扩展名分派解析。
 * @param {Buffer} buf
 * @param {string} ext 形如 '.wav'
 */
export function probeAudioBuffer(buf, ext) {
  const e = String(ext || '').toLowerCase();
  if (e === '.wav' || e === '.wave') return probeWav(buf);
  if (e === '.flac') return probeFlac(buf);
  if (e === '.mp3') return probeMp3(buf);
  return fail('unsupported-format', `未实现 ${e || '(无扩展名)'} 的头解析（不假装能解析，请用 WAV/FLAC/MP3）`);
}

export default probeAudioBuffer;
