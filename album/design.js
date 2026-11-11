import { DESIGN_LOCK } from './design-lock.js';
import { makeZip } from './zip.js';

const $ = selector => document.querySelector(selector);
const emptyFallback = '这里还是空白。写一页日常，或上传第一张旅途照片。';
const layouts = ['sea-photo', 'forest-photo', 'huzhou-photo', 'suzhou-photo', 'banna-photo'];

export async function readDesign(blob) {
  if (blob.size !== DESIGN_LOCK.bytes) throw new Error('原画册文件大小与发布版本不符。');
  const bytes = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hex !== DESIGN_LOCK.sha256) throw new Error('原画册文件与发布版本不符。');
  const design = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (design.version !== 1 || !layouts.every((layout, index) => design.photos[index]?.layout === layout)) {
    throw new Error('原画册的版式版本不符。');
  }
  return design;
}

function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function button(text, className, click) {
  const result = element('button', className, text);
  result.type = 'button';
  result.addEventListener('click', click);
  return result;
}

function image(url, alt) {
  const result = element('img');
  result.src = url;
  result.alt = alt;
  result.decoding = 'async';
  result.loading = 'lazy';
  return result;
}

function decode(asset) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(asset.data);
  const binary = atob(asset.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function scrollToSection(target) {
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'start' });
}

export class OriginalDesign {
  constructor({ compose, logout, openDialog, canOpen }) {
    this.compose = compose;
    this.openDialog = openDialog;
    this.canOpen = canOpen;
    this.attempt = 0;
    this.urls = new Map();
    this.roots = new Map();
    for (const id of ['original-intro', 'original-note', 'original-travel', 'original-archive']) {
      this.roots.set(id, document.getElementById(id).attachShadow({ mode: 'open' }));
    }
    $('#original-skip').addEventListener('click', () => this.closeGift(true));
    $('#original-story').addEventListener('click', () => this.openGift());
    $('#original-logout').addEventListener('click', logout);
    const viewer = $('#original-viewer');
    $('#original-photo-close').addEventListener('click', () => viewer.close());
    viewer.addEventListener('close', () => {
      $('#original-photo').removeAttribute('src');
      $('#original-photo').alt = '';
      $('#original-photo-title').textContent = '原旅行照片';
    });
    window.addEventListener('message', event => {
      if (event.origin === 'null' && event.source === this.frame?.contentWindow &&
          event.data?.type === 'album:open-journal') this.closeGift(true);
    });
  }

  async load(api, checkSession) {
    this.clear();
    const attempt = this.attempt;
    $('#original-recovery').hidden = false;
    $('#original-retry').hidden = true;
    $('#original-status').textContent = '正在加载原画册…';
    try {
      const blob = await api.downloadDesign();
      checkSession();
      if (attempt !== this.attempt) return;
      const design = await readDesign(blob);
      checkSession();
      if (attempt !== this.attempt) return;
      this.mount(design);
      $('#original-recovery').hidden = true;
      $('#original-status').textContent = '';
      if (this.canOpen()) this.openGift();
    } catch (error) {
      if (attempt !== this.attempt || error.name === 'AbortError') return;
      this.clear();
      $('#original-recovery').hidden = false;
      $('#original-retry').hidden = false;
      $('#original-status').textContent = '暂时无法加载原画册。你可以继续查看和添加同步日常。';
    }
  }

  mount(design) {
    this.gift = design.gift;
    const photos = [];
    for (const [name, asset] of Object.entries(design.assets)) {
      if (asset.mime === 'font/woff2') {
        const attempt = this.attempt;
        const font = new FontFace('Journal Hand', decode(asset));
        font.load().then(() => {
          if (attempt === this.attempt) {
            document.fonts.add(font);
            this.font = font;
          }
        }).catch(() => { /* The original CSS has a local typeface fallback. */ });
        continue;
      }
      const blob = new Blob([decode(asset)], { type: asset.mime });
      this.urls.set(name, URL.createObjectURL(blob));
      if (design.photos.some(photo => photo.file === name)) photos.push({ name, blob });
    }
    this.mountIntro(design);
    this.mountSection('original-note', design.dailyNote);
    const travel = this.mountSection('original-travel', design.travelIntro);
    travel.append(this.travelDirectory(design.photos));
    const archive = this.mountSection('original-archive');
    archive.append(this.folio(design, photos));
    $('#original-story').hidden = false;
    $('#journal-title').hidden = false;
    $('#empty').textContent = '还没有新增日常。原旅行照片可以在下方相册翻阅。';
    document.body.classList.add('original-ready');
  }

  mountSection(id, markup) {
    const root = this.roots.get(id);
    const css = element('link');
    css.rel = 'stylesheet';
    css.href = './original-journal.css';
    root.replaceChildren(css);
    if (markup) {
      const template = element('template');
      // Only the byte-for-byte pinned private design reaches the DOM.
      template.innerHTML = markup;
      for (const img of template.content.querySelectorAll('[data-auth-src]')) {
        img.src = this.urls.get(img.dataset.authSrc);
        img.removeAttribute('data-auth-src');
      }
      root.append(template.content);
    }
    root.host.hidden = false;
    return root;
  }

  mountIntro(design) {
    const intro = this.mountSection('original-intro', design.intro);
    const targets = {
      daily: '#journal-start',
      travel: '#original-travel',
      album: '#original-archive',
    };
    for (const link of intro.querySelectorAll('[data-section]')) {
      link.addEventListener('click', () => scrollToSection($(targets[link.dataset.section])));
    }
    for (const add of intro.querySelectorAll('.new-entry')) add.addEventListener('click', this.compose);
    intro.querySelector('.masthead .brand')?.addEventListener('click', event => {
      event.preventDefault();
      scrollToSection($('#journal-start'));
    });
    const start = Date.parse(design.clockStart);
    const days = intro.querySelector('#together-days');
    const time = intro.querySelector('#together-time');
    const tick = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
      days.textContent = Math.floor(seconds / 86400).toLocaleString('zh-CN');
      time.textContent = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
        .map(part => String(part).padStart(2, '0')).join(':');
    };
    tick();
    this.clock = setInterval(tick, 1000);
  }

  travelDirectory(photos) {
    const directory = element('div', 'trip-directory');
    const first = new Map();
    for (const photo of photos) if (!first.has(photo.city)) first.set(photo.city, photo);
    for (const photo of first.values()) {
      const card = button('', 'trip-card', () => {
        const frame = this.roots.get('original-archive').querySelector('.' + photo.layout);
        scrollToSection(frame.querySelector('button'));
      });
      const cover = element('div', 'trip-cover');
      const pic = image(this.urls.get(photo.file), '');
      if (photo.layout === 'huzhou-photo') pic.className = 'seed-huzhou';
      cover.append(pic);
      card.append(cover, element('strong', null, photo.city));
      directory.append(card);
    }
    return directory;
  }

  folio(design, backupPhotos) {
    const album = element('section');
    album.id = 'album';
    const months = element('div');
    months.id = 'months';
    const title = element('header', 'folio-title');
    title.append(element('h2', null, design.captions.title), element('p', null, design.captions.subtitle));
    const [sea, forest, huzhou, suzhou, banna] = design.photos.map(photo => this.folioPhoto(photo));
    const opening = element('div', 'folio-opening');
    opening.append(title, sea, forest);
    const middle = element('section', 'folio-instant-pair');
    middle.append(huzhou, suzhou);
    const closing = element('section', 'folio-closing');
    closing.append(banna, element('p', 'folio-ending', design.captions.ending));
    const actions = element('div', 'folio-actions');
    const status = element('span');
    status.setAttribute('role', 'status');
    const download = button('导出原旅行照片', 'text-button', async () => {
      const attempt = this.attempt;
      const active = () => {
        if (attempt !== this.attempt) throw new DOMException('会话已结束', 'AbortError');
      };
      download.disabled = true;
      status.textContent = '正在整理照片…';
      try {
        const blob = await makeZip(backupPhotos, active);
        active();
        const url = URL.createObjectURL(blob);
        this.urls.set('export-' + url, url);
        const link = element('a', null, '下载原旅行照片 ZIP');
        link.href = url;
        link.download = 'travel-photos.zip';
        status.replaceChildren(link);
      } catch (error) {
        if (error.name !== 'AbortError') status.textContent = '暂时无法导出，请重试。';
      } finally {
        download.disabled = !!status.querySelector('a');
      }
    });
    actions.append(download, status);
    months.append(opening, middle, closing, actions);
    album.append(months);
    return album;
  }

  folioPhoto(photo) {
    const figure = element('figure', 'folio-photo ' + photo.layout);
    const url = this.urls.get(photo.file);
    const expand = button('', 'folio-image', () => {
      $('#original-photo').src = url;
      $('#original-photo').alt = photo.city + '原旅行照片';
      $('#original-photo-title').textContent = photo.city;
      this.openDialog($('#original-viewer'));
    });
    expand.setAttribute('aria-label', '查看' + photo.city + '照片');
    const pic = image(url, photo.city + '旅行照片');
    const sizes = [[1535, 2048], [1536, 2048], [1468, 2048], [1263, 2048], [1535, 2048]];
    [pic.width, pic.height] = sizes[layouts.indexOf(photo.layout)];
    expand.append(pic);
    figure.append(expand, element('figcaption', null, photo.city));
    return figure;
  }

  openGift() {
    if (!this.gift || this.frame) return;
    const frame = element('iframe');
    frame.title = '原设计故事与信';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    frame.srcdoc = this.gift;
    this.frame = frame;
    $('#original-frame').append(frame);
    $('#original-gift').hidden = false;
    $('.page').inert = true;
    $('.skip').inert = true;
    $('#original-skip').focus({ preventScroll: true });
    document.body.classList.add('original-gift-open');
  }

  closeGift(focus) {
    this.frame?.remove();
    this.frame = null;
    $('#original-gift').hidden = true;
    $('.page').inert = false;
    $('.skip').inert = false;
    document.body.classList.remove('original-gift-open');
    if (focus) scrollToSection($('#original-intro'));
  }

  clear() {
    this.attempt += 1;
    this.closeGift(false);
    this.gift = null;
    clearInterval(this.clock);
    if (this.font) document.fonts.delete(this.font);
    this.font = null;
    for (const root of this.roots.values()) {
      root.host.hidden = true;
      root.replaceChildren();
    }
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    const viewer = $('#original-viewer');
    if (viewer.open) viewer.close();
    $('#original-photo').removeAttribute('src');
    $('#original-photo').alt = '';
    $('#original-photo-title').textContent = '原旅行照片';
    $('#original-story').hidden = true;
    $('#journal-title').hidden = true;
    $('#original-recovery').hidden = true;
    $('#original-retry').hidden = true;
    $('#original-status').textContent = '';
    $('#empty').textContent = emptyFallback;
    document.body.classList.remove('original-ready');
  }
}
