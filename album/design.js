import { unfoldPaper } from './paper-motion.js?v=1';
import { mountFilmCover } from './film-cover.js?v=2';
import { bindBook, cityKey, citySpreads } from './paper-book.js?v=4';
import { DESIGN_LOCK } from './design-lock.js?v=20261113-audit2';
import { makeZip } from './zip.js?v=20261113-audit2';

const $ = selector => document.querySelector(selector);
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
  constructor({ compose, logout, openDialog, canOpen, showSpace, bookData, editTrip, viewPhoto, observePhoto, onBookReady }) {
    Object.assign(this, {compose, showSpace, bookData, editTrip, viewPhoto, observePhoto, onBookReady});
    this.openDialog = openDialog;
    this.canOpen = canOpen;
    this.attempt = 0;
    this.urls = new Map();
    this.roots = new Map();
    for (const id of ['original-intro', 'original-note', 'original-archive']) {
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
    const reader = $('#trip-card');
    $('#close-trip-card').onclick = () => reader.close();
    reader.addEventListener('close', () => {
      $('#card-memories').replaceChildren();
      $('#trip-card-title').textContent = '';
      $('#write-trip-card').onclick = null;
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
    const note = this.mountSection('original-note', design.dailyNote);
    const postcardImage = note.querySelector('.note-postcard img');
    if (postcardImage) {
      $('#empty .postcard-picture').replaceChildren(postcardImage.cloneNode());
      const stamp = postcardImage.cloneNode();
      stamp.alt = '';
      $('#editor-stamp').replaceChildren(stamp);
    }
    const archive = this.mountSection('original-archive');
    archive.append(this.folio(design, photos));
    $('#original-story').hidden = false;
    $('#journal-title').hidden = false;
    document.body.classList.add('original-ready');
    this.onBookReady();
  }

  mountSection(id, markup) {
    const root = this.roots.get(id);
    const css = element('link');
    css.rel = 'stylesheet';
    css.href = './original-journal.css?v=20261119-archive';
    root.replaceChildren(css);
    if (id === 'original-archive' || id === 'original-intro') {
      const skin = css.cloneNode();
      skin.href = id === 'original-archive' ? './paper.css?v=5' : './film-cover.css?v=1';
      root.append(skin);
    }
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
    this.cover = mountFilmCover(intro, {
      originalURL: file => this.urls.get(file),
      observePhoto: this.observePhoto,
      openCity: (key, from) => this.openCity(key, from),
      compose: this.compose,
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

  folio(design, backupPhotos) {
    const album = element('section');
    album.id = 'album';
    const months = element('div');
    months.id = 'months';
    const title = element('header', 'folio-title');
    title.append(element('h2', null, design.captions.title === '时光相册' ? '旅行画册' : design.captions.title), element('p', null, design.captions.subtitle));
    this.originals = design.photos;
    this.bookSlot = element('div');
    this.refreshBook();
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
    months.append(title, this.bookSlot, actions);
    album.append(months);
    return album;
  }

  refreshBook() {
    if (!this.bookSlot) return;
    this.pager?.dispose();
    const trips = new Map();
    const city = name => {
      const key = cityKey(name);
      if (!trips.has(key)) trips.set(key, { key, name: name.trim(), prints: [], notes: [] });
      return trips.get(key);
    };
    for (const photo of this.originals) city(photo.city).prints.push({ original: photo });
    const { entries, photos } = this.bookData();
    const byId = new Map(photos.map(photo => [photo.id, photo]));
    for (const entry of [...entries].reverse()) {
      const meta = entry.scrapbook;
      if (entry.deleting || !cityKey(meta?.name)) continue;
      const trip = city(meta.name);
      if (entry.body) trip.notes.push(entry);
      if (!Array.isArray(meta.prints)) continue;
      for (const print of meta.prints) {
        const photo = byId.get(print?.id);
        if (photo?.entry_id === entry.id) trip.prints.push({ ...print, photo });
      }
    }
    this.trips = trips;
    this.cover?.update(trips);
    const pages = [];
    for (const trip of trips.values()) {
      const spreads = citySpreads(trip.prints);
      for (const [index, spread] of spreads.entries()) {
        for (const [side, prints] of spread.entries()) {
          const sheet = element('article', 'scrap-page trip-sheet');
          sheet.dataset.trip = trip.key;
          if (side && !prints.length) sheet.classList.add('pocket-page');
          sheet.dataset.key = index === 0 && side === 0 ? trip.key : JSON.stringify([trip.key, index, side]);
          sheet.setAttribute('aria-label', trip.name + '，第' + (index + 1) + '跨，' + (side ? '右页' : '左页'));
          const heading = element('h3', 'trip-title', trip.name);
          sheet.append(heading);
          if (spreads.length > 1) sheet.append(element('span', 'trip-page-number', (index + 1) + ' / ' + spreads.length));
          const composition = element('div', 'city-photo-layout');
          composition.append(...prints.map(item => this.makePrint(item, trip.name)));
          sheet.append(composition);
          if (side && index === spreads.length - 1) {
            const add = this.emptyPrint('把这趟的照片贴进来', () => this.editTrip(trip));
            add.setAttribute('aria-label', '给' + trip.name + '补照片');
            if (prints.length) add.classList.add('refill-print');
            sheet.append(add);
          } else {
            const controls = element('div', 'trip-page-controls');
            controls.append(button('＋ 补照片', 'trip-text-button', () => this.editTrip(trip)));
            sheet.append(controls);
          }
          if (side && index === 0) sheet.append(this.pocket(trip));
          if (this.latestPrint && prints.some(item => item.photo?.id === this.latestPrint)) {
            this.pageKey = sheet.dataset.key;
            this.latestPrint = null;
          }
          pages.push(sheet);
        }
      }
    }
    const last = element('article', 'scrap-page final');
    last.dataset.key = 'next-trip';
    last.append(this.emptyPrint('下一张，我们以后再拍', () => this.editTrip(null)));
    pages.push(last);
    pages.forEach((page, index) => page.classList.add(index % 2 ? 'right-page' : 'left-page'));
    const wrapper=element('div','scrapbook');
    const table=element('div','linen-table');
    if (pages.length > trips.size * 2 + 1) table.classList.add('thick-book');
    const desk=element('div','book-desk');
    desk.tabIndex=0;desk.setAttribute('role','group');desk.setAttribute('aria-label','旅行手账，左右翻页');
    const nav=element('nav','book-nav');
    const output=element('output');output.setAttribute('aria-live','polite');
    nav.append(element('button',null,'← 上一页'),output,element('button',null,'下一页 →'));
    const tabs = element('nav', 'city-tabs');
    tabs.setAttribute('aria-label', '按城市翻到跨页');
    const firstPages = new Map(pages.map((page, i) => [page.dataset.key, i]));
    for (const trip of trips.values()) {
      const tab = button(trip.name, 'city-tab', () => this.pager.jump(firstPages.get(trip.key)));
      tab.dataset.trip = trip.key;
      tabs.append(tab);
    }
    desk.append(...pages);
    table.append(desk);
    wrapper.append(tabs, table, nav);
    this.bookSlot.replaceChildren(wrapper);
    const index=pages.findIndex(p=>p.dataset.key===this.pageKey);
    this.pager = bindBook(desk, pages, nav, Math.max(index, 0), key => {
      this.pageKey = key;
      const city = pages[firstPages.get(key)]?.dataset.trip;
      for (const tab of tabs.children) {
        if (tab.dataset.trip === city) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
      }
    });
  }

  openCity(key, from) {
    const desk = this.bookSlot?.querySelector('.book-desk');
    if (!desk) return;
    const first = Array.from(desk.children).findIndex(page => page.dataset.key === key);
    if (first < 0) return;
    const start = from?.getBoundingClientRect();
    this.showSpace('travel', {focus:false});
    this.pager.jump(first);
    const page = desk.children[first];
    desk.focus({preventScroll:true});
    const table = desk.parentElement;
    table.scrollIntoView({block:table.offsetHeight < window.innerHeight ? 'center' : 'start', behavior:'instant'});
    if (!start || !start.width || start.bottom < 0 || start.top > window.innerHeight || !from.complete || !from.naturalWidth || matchMedia('(prefers-reduced-motion:reduce)').matches) return;
    const target = page.querySelector('.folio-image');
    if (!target) return;
    const end = target.getBoundingClientRect();
    if (!end.width || !end.height) return;
    this.printFlight?.cancel();
    const print = from.cloneNode();
    print.alt = '';
    print.className = 'travelling-print';
    print.setAttribute('aria-hidden', 'true');
    Object.assign(print.style, {left:end.left+'px', top:end.top+'px', width:end.width+'px', height:end.height+'px'});
    $('#album').append(print);
    const move = 'translate(' + (start.left-end.left) + 'px,' + (start.top-end.top) + 'px) scale(' + start.width/end.width + ',' + start.height/end.height + ')';
    const flight = print.animate([
      {transform:move,opacity:1},
      {transform:'translate(0) scale(1)',opacity:1,offset:.83},
      {transform:'translate(0) scale(1)',opacity:0}
    ], {duration:650,easing:'cubic-bezier(.24,.72,.28,1)'});
    this.printFlight = flight;
    flight.finished.catch(() => {}).finally(() => {
      print.remove();
      if (this.printFlight === flight) this.printFlight = null;
    });
  }

  makePrint(item, tripName) {
    if (item.original) return this.folioPhoto(item.original);
    const figure = element('figure', 'folio-photo trip-upload' + (item.wide ? ' landscape' : '') + (item.detail ? ' detail-print' : ''));
    const expand = button('', 'folio-image', () => this.viewPhoto(item.photo));
    expand.setAttribute('aria-label', '查看' + (item.caption || tripName) + '照片');
    const img = element('img');
    img.alt = '';
    img.hidden = true;
    expand.dataset.cover = item.photo.id;
    expand.append(img, element('span', null, '正在载入…'));
    this.observePhoto(expand);
    figure.append(expand, element('figcaption', null, item.caption || ''));
    return figure;
  }

  emptyPrint(text,click) {
    const frame=button('', 'blank-print',click);
    frame.append(element('span','blank-window','＋'),element('span','blank-caption',text));
    return frame;
  }

  pocket(trip) {
    const box = element('div', 'paper-pocket');
    const read = button('', 'note-card', event => {
      if (suppressClick && event.detail) { suppressClick = false; return; }
      this.readCard(trip, read.getBoundingClientRect());
    });
    read.setAttribute('aria-label', '抽出' + trip.name + '的手写卡');
    read.setAttribute('aria-haspopup', 'dialog');
    read.append(element('small', null, '抽出手写卡 ↑'), element('span', null, trip.notes.at(-1)?.body || '这趟旅程，我还记得……'));
    let drag = null, suppressClick = false;
    const finish = event => {
      if (event.pointerId !== drag?.id) return;
      const lift = drag.lift;
      const origin = read.getBoundingClientRect();
      drag = null;
      read.classList.remove('lifting');
      read.style.removeProperty('--lift');
      if (lift > 6) suppressClick = true;
      if (event.type === 'pointerup' && lift >= 24) this.readCard(trip, origin);
    };
    read.onpointerdown = event => {
      if (!event.isPrimary || event.button !== 0) return;
      event.stopPropagation();
      suppressClick = false;
      drag = {id:event.pointerId, y:event.clientY, lift:0};
      read.setPointerCapture(event.pointerId);
    };
    read.onpointermove = event => {
      if (event.pointerId !== drag?.id) return;
      drag.lift = Math.min(70, Math.max(0, drag.y - event.clientY));
      read.classList.add('lifting');
      read.style.setProperty('--lift', -drag.lift + 'px');
    };
    read.onpointerup = finish;
    read.onpointercancel = finish;
    const write = button('写一张卡', 'pocket-front', () => this.editTrip(trip, 'note'));
    box.append(read, write);
    return box;
  }

  readCard(trip, origin) {
    const reader = $('#trip-card');
    if (reader.open) return;
    $('#trip-card-title').textContent = trip.name;
    const memories = $('#card-memories');
    memories.replaceChildren();
    if (trip.notes.length) {
      for (const note of trip.notes) {
        const message = element('article');
        if (note.day) {
          const time = element('time', null, note.day.replaceAll('-', '.'));
          time.dateTime = note.day;
          message.append(time);
        }
        message.append(element('p', null, note.body));
        memories.append(message);
      }
    } else {
      memories.append(element('p', 'unwritten-card', '这趟旅程，我还记得……'));
    }
    const write = $('#write-trip-card');
    write.textContent = trip.notes.length ? '再写一张卡' : '写下第一张卡';
    write.onclick = () => { reader.close(); this.editTrip(trip, 'note'); };
    this.openDialog(reader);
    memories.scrollTop = 0;
    unfoldPaper(reader, origin);
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
    if (focus) {
      const active = $('[data-space]:not([hidden])');
      if (active) scrollToSection(active);
      if (active?.dataset.space === 'cover') this.cover?.reveal();
    }
  }

  clear() {
    this.attempt += 1;
    this.closeGift(false);
    this.gift = null;
    this.cover?.dispose();
    this.cover = null;
    this.printFlight?.cancel();
    if ($('#trip-card').open) $('#trip-card').close();
    $('#card-memories').replaceChildren();
    $('#trip-card-title').textContent = '';
    $('#write-trip-card').onclick = null;
    clearInterval(this.clock);
    this.pager?.dispose();
    this.pager=this.bookSlot=this.pageKey=this.latestPrint=this.trips=this.originals=null;
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
    $('#original-recovery').hidden = true;
    $('#original-retry').hidden = true;
    $('#original-status').textContent = '';
    $('#empty .postcard-picture').replaceChildren();
    $('#editor-stamp').replaceChildren();
    document.body.classList.remove('original-ready');
  }
}
