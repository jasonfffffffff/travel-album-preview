// ZIP Store writer (no compression, dependency-free). Inputs must total <=32 MiB.
const encoder = new TextEncoder();
const table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export const ZIP_LIMIT = 32 * 1024 * 1024;
export function packPhotoBatches(photos) {
  const batches = []; let current = [], total = 0;
  for (const photo of photos) {
    if (!Number.isInteger(photo.bytes) || photo.bytes < 1 || photo.bytes > 4 * 1024 * 1024) throw new Error('备份遇到异常图片大小。');
    if (total + photo.bytes > ZIP_LIMIT || current.length >= 24) { batches.push(current); current = []; total = 0; }
    current.push(photo); total += photo.bytes;
  }
  if (current.length) batches.push(current);
  return batches;
}
export async function makeZip(entries, checkActive = () => {}) {
  if (entries.length > 1000 || entries.reduce((size, item) => size + item.blob.size, 0) > ZIP_LIMIT) throw new Error('本份备份超过 32MB 上限。');
  const parts = [], directory = []; let offset = 0, directorySize = 0;
  for (const entry of entries) {
    checkActive();
    if (!/^[a-zA-Z0-9_./-]+$/.test(entry.name) || entry.name.includes('..') || entry.name.startsWith('/')) throw new Error('无效的备份文件名。');
    const name = encoder.encode(entry.name);
    const crc = crc32(new Uint8Array(await entry.blob.arrayBuffer()));
    checkActive();
    const header = new Uint8Array(30 + name.length), view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(10, 0, true); view.setUint16(12, 33, true);
    view.setUint32(14, crc, true); view.setUint32(18, entry.blob.size, true); view.setUint32(22, entry.blob.size, true); view.setUint16(26, name.length, true); header.set(name, 30);
    const center = new Uint8Array(46 + name.length), cv = new DataView(center.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(14, 33, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, entry.blob.size, true); cv.setUint32(24, entry.blob.size, true); cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); center.set(name, 46);
    parts.push(header, entry.blob); directory.push(center); directorySize += center.length; offset += header.length + entry.blob.size;
  }
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, directorySize, true); ev.setUint32(16, offset, true);
  checkActive(); return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
