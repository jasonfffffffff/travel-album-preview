import { PHOTO_MAX } from './api.js?v=20261113-audit1';

export async function preparePhoto(file) {
  if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) {
    throw new Error('请选择 20MB 内的 JPEG、PNG 或 WebP；HEIC 请先在手机里转换。');
  }
  let source, url;
  try {
    url = URL.createObjectURL(file); source = new Image();
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(new Error('读取图片超时，请重新选择照片。')),15000);
      const finish=error=>{clearTimeout(timer);source.onload=source.onerror=null;error?reject(error):resolve();};
      source.onload=()=>finish();source.onerror=()=>finish(new Error('这张图片无法读取，请换一张 JPEG、PNG 或 WebP。'));
      source.src=url;
    });
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
    const encode = quality => new Promise((resolve,reject) => {
      const timer=setTimeout(()=>reject(new Error('图片压缩超时，请重试。')),15000);
      try { canvas.toBlob(blob=>{clearTimeout(timer);resolve(blob);}, 'image/jpeg', quality); }
      catch(error){clearTimeout(timer);reject(error);}
    });
    let blob = await encode(.86);
    if (blob && blob.size > PHOTO_MAX) blob = await encode(.68);
    canvas.width = 1; canvas.height = 1;
    if (!blob || blob.size > PHOTO_MAX || blob.type !== 'image/jpeg') throw new Error('压缩后仍超过 4MB，请换一张较小的图片。');
    return { blob, width, height, mime: 'image/jpeg', bytes: blob.size };
  } finally { source?.close?.(); if (url) URL.revokeObjectURL(url); }
}
