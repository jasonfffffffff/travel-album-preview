import { PHOTO_MAX } from './api.js';

export async function preparePhoto(file) {
  if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) {
    throw new Error('请选择 20MB 内的 JPEG、PNG 或 WebP；HEIC 请先在手机里转换。');
  }
  let source, url;
  try {
    if (typeof createImageBitmap === 'function') source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    else {
      url = URL.createObjectURL(file); source = new Image();
      source.src = url; await source.decode();
    }
    const w = source.width || source.naturalWidth;
    const h = source.height || source.naturalHeight;
    if (!w || !h || w * h > 50000000) throw new Error('图片尺寸过大，请先缩小后上传。');
    const ratio = Math.min(1, 2048 / Math.max(w, h));
    const width = Math.max(1, Math.round(w * ratio));
    const height = Math.max(1, Math.round(h * ratio));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('此浏览器不能处理图片，请换用系统浏览器。');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height); ctx.drawImage(source, 0, 0, width, height);
    const encode = quality => new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    let blob = await encode(.86);
    if (blob && blob.size > PHOTO_MAX) blob = await encode(.68);
    canvas.width = 1; canvas.height = 1;
    if (!blob || blob.size > PHOTO_MAX || blob.type !== 'image/jpeg') throw new Error('压缩后仍超过 4MB，请换一张较小的图片。');
    return { blob, width, height, mime: 'image/jpeg', bytes: blob.size };
  } finally { source?.close?.(); if (url) URL.revokeObjectURL(url); }
}
