// 只读 ZIP 中央目录 + inflateRaw。Node 自带 zlib，不必引 jszip/adm-zip。
// GDELT 每 15 分钟下发的是 .zip 里的单个 CSV，够用了。
import { inflateRawSync } from 'node:zlib';

/** @param {Uint8Array} buf  @returns {{name:string,data:Buffer}[]} */
export function unzipAll(buf) {
  const u8 = Buffer.from(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength ?? buf.length);
  // 从尾部找 EOCD（End of Central Directory, 签名 PK\x05\x06）
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (u8.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到 EOCD）');
  const count = u8.readUInt16LE(eocd + 10);
  let off = u8.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (u8.readUInt32LE(off) !== 0x02014b50) break;          // 中央目录项签名 PK\x01\x02
    const method = u8.readUInt16LE(off + 10);
    const compSize = u8.readUInt32LE(off + 20);
    const nameLen = u8.readUInt16LE(off + 28);
    const extraLen = u8.readUInt16LE(off + 30);
    const commentLen = u8.readUInt16LE(off + 32);
    const localOff = u8.readUInt32LE(off + 42);
    const name = u8.toString('utf8', off + 46, off + 46 + nameLen);
    // 跳到本地头，取真实的数据起点（本地头的名字/扩展长度与中央目录可能不同）
    const lNameLen = u8.readUInt16LE(localOff + 26);
    const lExtraLen = u8.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 ${method}（${name}）`);
    out.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export const unzipFirst = (buf) => unzipAll(buf)[0];

/**
 * 流式解析一行 CSV（支持双引号包裹与 "" 转义）。不处理换行在引号内的多行记录 —— 
 * GDELT 的 SOURCEURL 不含裸换行，够用；若要通用请换成熟实现。
 */
export function parseCsvLine(line, out = []) {
  out.length = 0;
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else q = false }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c;
  }
  out.push(cur);
  return out;
}
