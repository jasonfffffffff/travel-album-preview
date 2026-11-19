import { unfoldPaper } from './paper-motion.js?v=1';
import { cityKey, citySpreads, printsPerSpread, orderPrintBatch } from './paper-book.js?v=4';
import { CONFIG } from './config.js?v=20261113-audit2';
import { AlbumApi, validateConfig, ApiError, PHOTO_MAX } from './api.js?v=20261113-audit2';
import { preparePhoto } from './photos.js?v=20261113-audit2';
import { makeZip, packPhotoBatches } from './zip.js?v=20261113-audit2';
import { OriginalDesign } from './design.js?v=20261119-spaces';

const $ = selector => document.querySelector(selector);
$('#boot-status').hidden = true;
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const action = (text, callback) => {
  const button = node('button', text); button.type = 'button';
  button.addEventListener('click', callback); return button;
};
let api, user = null, members = [], entries = [], photos = [], replies = [];
const notesPerWall = 6;
let wallPage = 0;
const notesGrid = $('#entries');
const noteSizes = new ResizeObserver(changes => {
  if (!notesGrid.offsetWidth) return;
  const gap = parseFloat(getComputedStyle(notesGrid).columnGap) || 0;
  for (const {target} of changes) {
    if (!target.isConnected) continue;
    const top = parseFloat(getComputedStyle(target).marginTop) || 0;
    // Six-pixel grid tracks let the next slip sit just below the shortest column.
    const rows = Math.ceil((target.offsetHeight + top + gap) / 6);
    target.style.setProperty('--pin-rows', String(rows));
  }
  notesGrid.dataset.arranged = '';
});
let epoch = 0, timer = null, syncing = false, signature = '';
let draft = null, saving = false, mutating = false, backupState = null;
let savedDiaryId = null;
let savedAlbumPhotoId = null;
let viewerState = null, observer = null, thumbnailJobs = [], thumbnailWorkers = 0, renderedCity = '';
function hasReplyDraft() {
  return [...document.querySelectorAll('textarea[data-reply-draft]')].some(field => field.value !== field.dataset.baseline);
}
function mayDiscardReplies() {
  return !hasReplyDraft() || confirm('翻页会清空当前未发送的留言改动，确定继续？');
}
const objectUrls = new Set(), thumbnailUrls = new Set();
const pendingPreviewUrls = new Set();
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function clearPendingPreviews() {
  for (const url of pendingPreviewUrls) revoke(url);
  pendingPreviewUrls.clear();
  $('#print-proof').replaceChildren();
}
const label = id => members.find(member => member.user_id === id)?.label || '画册成员';
function current(captured) {
  if (captured !== epoch || !user) throw new DOMException('会话已结束', 'AbortError');
}
function message(error) {
  if (error.name === 'AbortError') return '';
  if (error.name === 'TimeoutError') return '连接等待超时，操作结果尚未确认。请保留本页，恢复连接后检查再重试。';
  if (error instanceof TypeError) return '连接暂时中断。内容未确认保存，请保留本页，连接恢复后重试。';
  return error.message || '操作没有完成，请重试。';
}
function status(text) { $('#operation-status').textContent = text; }
function urlFor(blob, thumbnail = false) {
  const url = URL.createObjectURL(blob); objectUrls.add(url);
  if (thumbnail) thumbnailUrls.add(url); return url;
}
function revoke(url) {
  if (!url) return;
  URL.revokeObjectURL(url); objectUrls.delete(url); thumbnailUrls.delete(url);
}
function revokeAll() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear(); thumbnailUrls.clear();
}
function openDialog(dialog) { dialog.showModal(); document.body.classList.add('dialog-open'); }
function closeDialog(dialog) { dialog.close(); }
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('close', () => {
    if (!document.querySelector('dialog[open]')) document.body.classList.remove('dialog-open');
  });
}
const spaces = Array.from(document.querySelectorAll('#album > [data-space]'));
const spaceLinks = Array.from(document.querySelectorAll('.space-header [data-destination]'));
const spaceOffsets = new Map();
let activeSpace = '';
history.scrollRestoration = 'manual';
function spaceFromLocation() {
  const hash = location.hash.slice(1);
  return spaces.some(panel => panel.dataset.space === hash) ? hash : 'cover';
}
function showSpace(name, { record = true, focus = true, restore = false } = {}) {
  const panel = spaces.find(item => item.dataset.space === name);
  if (!panel) return;
  const changing = activeSpace !== name;
  if (activeSpace && changing) spaceOffsets.set(activeSpace, window.scrollY);
  if (record && location.hash !== '#' + name) history.pushState(null, '', '#' + name);
  activeSpace = name;
  for (const item of spaces) item.hidden = item !== panel;
  for (const link of spaceLinks) {
    if (link.dataset.destination === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('#album-tools').open = false;
  if (focus) {
    panel.focus({preventScroll:true});
    window.scrollTo({top: restore && changing ? spaceOffsets.get(name) || 0 : 0, behavior:'instant'});
  }
}
for (const link of spaceLinks) link.addEventListener('click', event => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  showSpace(link.dataset.destination, {restore:true});
});
window.addEventListener('hashchange', () => {
  if (user && activeSpace !== spaceFromLocation()) showSpace(spaceFromLocation(), {record:false, restore:true});
});
$('.skip').addEventListener('click', event => {
  event.preventDefault();
  const target = user ? spaces.find(panel => panel.dataset.space === activeSpace) : $('#main-content');
  target?.focus();
});
document.addEventListener('click', event => {
  const tools = $('#album-tools');
  if (tools.open && !tools.contains(event.target)) tools.open = false;
  for (const menu of document.querySelectorAll('.note-options[open]')) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
$('#album-tools').addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    $('#album-tools').open = false;
    $('#album-tools summary').focus();
  }
});
const original = new OriginalDesign({
  showSpace,
  compose: () => { showSpace('daily'); editEntry(); },
  bookData: () => ({entries,photos}),
  editTrip: (trip, kind='photos') => editEntry(null,{trip:trip?.key || '',name:trip?.name || '',kind}),
  viewPhoto: photo => showPhoto([photo],0),
  observePhoto: cover => observer?.observe(cover),
  onBookReady: () => { if (observer) renderSyncedArchive(); },
  logout: leave,
  openDialog,
  canOpen: () => activeSpace === 'cover' && !draft && !inputsActive()
});
$('#original-retry').addEventListener('click', () => {
  if (!user) return;
  const captured = epoch;
  void original.load(api, () => current(captured));
});

try {
  const config = validateConfig(CONFIG);
  if (!config) $('#unconfigured').hidden = false;
  else { api = new AlbumApi(config); $('#login').hidden = false; }
} catch (error) {
  $('#unconfigured').hidden = false;
  $('#unconfigured').append(node('p', message(error)));
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const email = $('#email').value.trim(), password = $('#password').value;
  $('#password').value = '';
  const button = event.submitter; button.disabled = true;
  $('#login-status').textContent = '正在核对账号…';
  const captured = ++epoch;
  try {
    const identity = await api.login(email, password);
    if (captured !== epoch) return;
    user = identity.user; members = identity.members;
    showSpace(spaceFromLocation(), {record:false, focus:false});
    $('#login-form').reset(); $('#login').hidden = true; $('#album').hidden = false;
    $('#identity').textContent = `${label(user.id)}，欢迎回来。`;
    $('#login-status').textContent = ''; signature = '';
    void original.load(api, () => current(captured));
    await sync(true);
    current(captured);
    timer = setInterval(() => { if (!document.hidden) sync(false); }, 15000);
  } catch (error) {
    if (captured === epoch) $('#login-status').textContent = message(error);
  } finally { if (captured === epoch) button.disabled = false; }
});

function clearSpaceState() {
  activeSpace = '';
  spaceOffsets.clear();
  wallPage = 0;
  noteSizes.disconnect();
  $('#album-tools').open = false;
  $('#identity').textContent = '';
  const travel = $('#travel-records');
  travel.ontoggle = null;
  travel.open = false;
  travel.hidden = true;
  travel.querySelector('summary').textContent = '旅行记录管理';
  $('#travel-record-list').replaceChildren();
  delete $('#synced-archive').dataset.month;
  delete $('#synced-archive').dataset.leaf;
  $('#city').replaceChildren(new Option('全部城市',''));
  savedDiaryId = null;
  savedAlbumPhotoId = null;
}
async function leave() {
  if (saving || mutating) {status('正在保存或清理内容，请完成后再退出。');return;}
  if ((draft || hasReplyDraft()) && !confirm('退出会清空本页未保存的文字和照片选择，确定退出？')) return;
  epoch += 1; clearInterval(timer); timer = null;
  original.clear();
  clearSpaceState();
  $('#trip-choice').replaceChildren();
  const exitingApi = api;
  user = null; members = []; entries = []; photos = []; replies = [];
  signature = ''; draft = null; backupState = null; viewerState = null;
  saving = false; mutating = false; syncing = false;
  observer?.disconnect(); observer = null; thumbnailJobs = [];
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  clearPendingPreviews();revokeAll(); $('#synced-archive').replaceChildren(); $('#large-photo').removeAttribute('src');
  $('#entries').replaceChildren(); $('#entry-form').reset(); $('#editor-photos').replaceChildren();
  $('#backup-link').replaceChildren(); $('#login-form').reset(); $('#operation-status').textContent = '';
  $('#login-status').textContent = ''; $('#login-form button').disabled = false;
  $('#album').hidden = true; $('#login').hidden = false;
  // Clear and abort requests synchronously, before any old continuation can render.
  await exitingApi.logout();
}
$('#logout').addEventListener('click', leave);
window.addEventListener('pagehide', () => {
  epoch += 1; clearInterval(timer); api?.clear(); revokeAll();
  original.clear();
  clearSpaceState();
  $('#trip-choice').replaceChildren();
  user = null; draft = null; backupState = null; viewerState = null; entries = []; photos = []; replies = []; members = [];
  thumbnailJobs=[]; observer?.disconnect(); $('#backup-link').replaceChildren(); $('#editor-photos').replaceChildren();
  $('#synced-archive').replaceChildren();clearPendingPreviews();$('#entries').replaceChildren(); $('#large-photo').removeAttribute('src'); $('#entry-form').reset(); $('#login-form').reset();
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
window.addEventListener('beforeunload', event => {
  if (draft || saving || hasReplyDraft()) {
    event.preventDefault(); event.returnValue = '';
  }
});
window.addEventListener('offline', () => {
  if (user) $('#sync-status').textContent = '目前离线；草稿仅在本页，尚未保存的内容请不要刷新。';
});
window.addEventListener('online', () => { if (user) sync(false); });
$('#refresh').addEventListener('click', () => sync(true));

function inputsActive() {
  return document.querySelector('dialog[open]') || hasReplyDraft() || document.activeElement?.matches('textarea[data-reply-draft]');
}
async function sync(manual = false) {
  if (!user || syncing || saving || mutating) return;
  const captured = epoch; syncing = true;
  try {
    const next = await Promise.all([
      api.all('album_entries','created_at.desc,id.asc'),
      api.all('album_photos','created_at.asc,id.asc'),
      api.all('album_replies','created_at.asc,id.asc')
    ]);
    current(captured);
    const nextSignature = JSON.stringify(next);
    entries = next[0]; photos = next[1]; replies = next[2];
    if (inputsActive()) {
      $('#sync-status').textContent = '已检查同步；当前输入已保留，结束编辑后更新画册显示。';
      return;
    }
    if (signature !== nextSignature || manual) { signature = nextSignature; render(); }
    $('#sync-status').textContent = `已同步 · ${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}（每 15 秒检查一次）`;
  } catch (error) {
    if (captured === epoch) $('#sync-status').textContent = message(error);
  } finally { if (captured === epoch) syncing = false; }
}

function loadPhotoImage(image, url) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      image.onload = image.onerror = null;
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('显示照片超时，请重试。')), 15000);
    image.onload = () => finish();
    image.onerror = () => finish(new Error('照片无法显示，请重试。'));
    image.src = url;
  });
}
function queueThumbnail(image, photo, captured) {
  thumbnailJobs.push({ image, photo, captured }); runThumbnail();
}
async function runThumbnail() {
  if (thumbnailWorkers >= 2 || !thumbnailJobs.length) return;
  const job = thumbnailJobs.shift(); thumbnailWorkers += 1;
  let url;
  try {
    current(job.captured);
    if (!job.image.isConnected) return;
    const blob = await api.download(job.photo.path);
    current(job.captured);
    if (!job.image.isConnected) return;
    url = urlFor(blob, true);
    await loadPhotoImage(job.image, url);
    current(job.captured);
    if (!job.image.isConnected) { revoke(url); return; }
    job.image.alt = '画册照片';
    job.image.hidden = false;
    job.image.parentElement.querySelector('span')?.remove();
  } catch (error) {
    revoke(url);
    if (job.captured === epoch && job.image.isConnected) {
      const cover = job.image.parentElement;
      cover.replaceChildren(node('span', '照片暂未加载，点这里重试'));
    }
  } finally { thumbnailWorkers -= 1; runThumbnail(); }
}
function isDiary(entry) {
  const trip = entry.scrapbook;
  return !cityKey(trip?.name) && trip?.kind !== 'photos' && trip?.kind !== 'note';
}
function setPrintProportion(element, photo) {
  if (photo.width > 0 && photo.height > 0) {
    const ratio = Math.min(3, Math.max(0.5, photo.width / photo.height));
    element.style.setProperty('--print-ratio', String(ratio));
  }
}
function render() {
  observer?.disconnect(); thumbnailJobs = [];
  noteSizes.disconnect();
  delete notesGrid.dataset.arranged;
  for (const url of [...thumbnailUrls]) revoke(url);
  const date = today();
  $('#empty .postmark').dateTime = date;
  $('#empty .postmark').textContent = date.replaceAll('-', '.');
  const selected = $('#city').value;
  const dailyEntries = [], travelEntries = [];
  for (const entry of entries) {
    if (isDiary(entry)) dailyEntries.push(entry);
    else travelEntries.push(entry);
  }
  const cities = [...new Set(dailyEntries.filter(entry=>!entry.deleting).flatMap(entry=>entry.cities))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
  $('#city').replaceChildren(new Option('全部城市',''), ...cities.map(city=>new Option(city,city)));
  if (cities.includes(selected)) $('#city').value = selected;
  renderedCity = $('#city').value;
  const receipt = savedDiaryId && dailyEntries.find(entry => entry.id === savedDiaryId);
  if (receipt && renderedCity && !receipt.cities.includes(renderedCity)) {
    $('#city').value = renderedCity = '';
  }
  const filtered = dailyEntries.filter(entry => !renderedCity || entry.cities.includes(renderedCity));
  const wallPages = Math.ceil(filtered.length / notesPerWall);
  if (receipt) wallPage = Math.floor(filtered.indexOf(receipt) / notesPerWall);
  wallPage = Math.max(0, Math.min(wallPage, wallPages - 1));
  $('#entry-count').textContent = filtered.length + ' 张便签';
  $('.wall-filter').hidden = dailyEntries.length === 0;
  $('#city').closest('label').hidden = cities.length === 0;
  $('#entries').replaceChildren();
  $('#empty').hidden = filtered.length !== 0;
  $('#wall-pager').hidden = wallPages < 2;
  $('#wall-newer').disabled = wallPage === 0;
  $('#wall-older').disabled = wallPage + 1 >= wallPages;
  $('#wall-range').textContent = wallPages ? (wallPage + 1) + ' / ' + wallPages : '';
  const tripManager = $('#travel-records');
  const tripList = $('#travel-record-list');
  tripList.replaceChildren();
  tripManager.hidden = travelEntries.length === 0;
  tripManager.querySelector('summary').textContent = '旅行记录管理（' + travelEntries.length + '）';
  let tripLimit = 0;
  function moreTripRecords() {
    tripList.querySelector('.more-trips')?.remove();
    for (const entry of travelEntries.slice(tripLimit, tripLimit + 12)) {
      const row = node('article', undefined, 'trip-log');
      const heading = node('h3', entry.scrapbook.name || entry.title || '旅行记录');
      const info = node('p', [entry.day, label(entry.owner_id), entry.scrapbook.kind === 'note' ? '手写卡' : '旅行照片'].filter(Boolean).join(' · '));
      row.append(heading, info);
      if (entry.body) row.append(node('p', entry.body, 'trip-log-body'));
      if (entry.owner_id === user.id) {
        const controls = node('div', undefined, 'entry-actions');
        if (!entry.deleting) controls.append(action('编辑', () => editEntry(entry)));
        controls.append(action(entry.deleting ? '继续删除' : '删除', () => deleteEntry(entry)));
        row.append(controls);
      }
      if (!entry.deleting) row.append(replySection(entry));
      tripList.append(row);
    }
    tripLimit += 12;
    if (tripLimit < travelEntries.length) {
      const more = action('再看 12 条旅行记录', moreTripRecords);
      more.className = 'more-trips'; tripList.append(more);
    }
  }
  tripManager.ontoggle = () => {
    if (user && tripManager.open && !tripLimit) moreTripRecords();
  };
  if (tripManager.open) moreTripRecords();
  const captured = epoch;
  observer = new IntersectionObserver((changes, coverObserver) => {
    for (const change of changes) if (change.isIntersecting) {
      coverObserver.unobserve(change.target);
      const photo = photos.find(item => item.id === change.target.dataset.cover);
      const image = change.target.querySelector('img');
      if (photo && image) queueThumbnail(image, photo, captured);
    }
  }, { rootMargin:'100px' });
  original.refreshBook();
  renderSyncedArchive();
  for (const entry of filtered.slice(wallPage * notesPerWall, (wallPage + 1) * notesPerWall)) {
    const article = node('article',undefined,'entry');
    article.dataset.paper = ['butter','blush','sage','ivory'][entry.id.charCodeAt(entry.id.length-1) % 4];
    article.id = 'entry-' + entry.id; article.tabIndex = -1;
    const mine = entry.owner_id === user.id;
    if (entry.deleting) {
      article.append(node('h2','这一页正在删除'),node('p',mine?'上次清理尚未结束，可以继续完成。':'这页内容正在由作者清理。','entry-text'));
      if (mine) article.append(action('继续删除',()=>deleteEntry(entry)));
      $('#entries').append(article); continue;
    }
    const attached = photos.filter(photo=>photo.entry_id===entry.id);
    if (attached.length) {
      const cover = action('',()=>showPhoto(attached,0)); cover.className='cover';cover.dataset.cover=attached[0].id;
      setPrintProportion(cover, attached[0]);
      cover.setAttribute('aria-label',`查看这一页的 ${attached.length} 张照片`);
      const image = node('img'); image.alt = ''; image.hidden = true;
      cover.append(image, node('span', '正在加载照片…')); article.append(cover); observer.observe(cover);
      if (attached.length > 1) cover.append(node('small', '1 / ' + attached.length, 'print-count'));
    }
    const meta = node('div', undefined, 'entry-meta');
    meta.append(node('span', label(entry.owner_id)));
    if (entry.day) {
      const date = node('time', entry.day.replaceAll('-', '.'), 'ink-date');
      date.dateTime = entry.day;
      meta.append(date);
    }
    if (mine) {
      const menu = node('details', undefined, 'note-options');
      const trigger = node('summary', '···');
      trigger.setAttribute('aria-label', '编辑或删除这张便签');
      const options = node('div');
      options.append(action('编辑便签', () => { menu.open = false; trigger.focus(); editEntry(entry); }),
        action('删除便签', () => { menu.open = false; trigger.focus(); deleteEntry(entry); }));
      menu.append(trigger, options);
      menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') { menu.open = false; trigger.focus(); }
      });
      meta.append(menu);
    }
    article.prepend(meta);
    if (entry.title) article.append(node('h3', entry.title, 'entry-title'));
    if (entry.body && (entry.body.length > 200 || entry.body.split('\n').length > 6)) {
      const full = node('details', undefined, 'note-full');
      const summary = node('summary');
      summary.append(node('span', entry.body, 'entry-excerpt'), node('span', '展开全文', 'read-note'), node('span', '收起全文', 'fold-note'));
      full.append(summary, node('p', entry.body, 'entry-text'));
      article.append(full);
    } else if (entry.body) {
      article.append(node('p', entry.body, 'entry-text'));
    }
    if (entry.cities.length) article.append(node('p',entry.cities.join(' / '),'entry-cities'));
    article.append(replySection(entry, true)); notesGrid.append(article);
  }
  for (const note of notesGrid.children) noteSizes.observe(note);
  if (savedDiaryId) {
    const receipt = document.getElementById('entry-' + savedDiaryId);
    if (receipt) {
      savedDiaryId = null;
      receipt.focus({preventScroll:true});
      receipt.scrollIntoView({block:'center', behavior:'instant'});
      receipt.classList.add('just-filed');
    }
  }
}
function renderSyncedArchive() {
  const archive = $('#synced-archive');
  function releasePrints(container) {
    for (const cover of container.querySelectorAll('.album-print')) {
      observer?.unobserve(cover);
      const src = cover.querySelector('img')?.src;
      if (thumbnailUrls.has(src)) revoke(src);
    }
  }
  releasePrints(archive);
  archive.replaceChildren();
  const heading = node('div', undefined, 'photo-archive-heading');
  heading.append(node('h2', '日常相册'));
  archive.append(heading);

  const attachments = new Map();
  for (const photo of photos) {
    if (!attachments.has(photo.entry_id)) attachments.set(photo.entry_id, []);
    attachments.get(photo.entry_id).push(photo);
  }
  const months = new Map();
  const daily = entries.filter(entry => !entry.deleting && isDiary(entry) && attachments.has(entry.id));
  daily.sort((a, b) => (b.day || '').localeCompare(a.day || '') || b.created_at.localeCompare(a.created_at));
  for (const entry of daily) {
    const month = entry.day?.slice(0, 7) || '';
    if (!months.has(month)) months.set(month, []);
    const attached = attachments.get(entry.id);
    attached.forEach((photo, index) => months.get(month).push({entry, attached, photo, index}));
  }

  const mount = node('div', undefined, 'album-mount');
  const sheet = node('section', undefined, 'album-sheet');
  mount.append(sheet);
  archive.append(mount);
  const add = action(months.size ? '＋ 收进照片' : '贴第一张日常照片', () => {
    if (editEntry()) $('#files').click();
  });
  if (!months.size) {
    delete archive.dataset.month;
    delete archive.dataset.leaf;
    add.className = 'album-insert';
    const aperture = node('span', '＋', 'album-aperture');
    aperture.setAttribute('aria-hidden', 'true');
    add.prepend(aperture);
    sheet.classList.add('unused-sheet');
    sheet.append(add);
    return;
  }
  add.className = 'album-add';
  heading.append(add);

  const monthLabel = key => key ? key.slice(0, 4) + ' 年 ' + Number(key.slice(5)) + ' 月' : '日期未填';
  let month = months.has(archive.dataset.month) ? archive.dataset.month : months.keys().next().value;
  let leaf = Number(archive.dataset.leaf) || 0;
  const perPage = 6;
  const savedIndex = savedAlbumPhotoId ? months.get(month).findIndex(item => item.photo.id === savedAlbumPhotoId) : -1;
  if (savedIndex >= 0) leaf = Math.floor(savedIndex / perPage);
  const indexBar = node('label', undefined, 'album-index');
  const monthPicker = node('select');
  indexBar.append(node('span', '月份'), monthPicker);
  for (const [key, pictures] of months) {
    monthPicker.append(new Option(monthLabel(key) + ' · ' + pictures.length + ' 张', key));
  }
  monthPicker.value = month;
  if (months.size > 1) heading.append(indexBar);

  const folio = node('div', undefined, 'album-folio');
  const pageTitle = node('h3');
  pageTitle.tabIndex = -1;
  const total = node('span');
  folio.append(pageTitle, total);
  const grid = node('div', undefined, 'album-prints');
  const navigation = node('nav', undefined, 'album-pagination');
  navigation.setAttribute('aria-label', '翻看这个月的照片');
  const previous = action('← 上一页', () => turn(leaf - 1));
  const next = action('下一页 →', () => turn(leaf + 1));
  const counter = node('output');
  counter.setAttribute('aria-live', 'polite');
  navigation.append(previous, counter, next);
  sheet.append(folio, grid, navigation);

  function turn(page) {
    leaf = page;
    display();
    pageTitle.focus({preventScroll:true});
    pageTitle.scrollIntoView({block:'nearest'});
  }
  monthPicker.onchange = () => {
    month = monthPicker.value;
    leaf = 0;
    display();
  };

  function display() {
    const pictures = months.get(month);
    const count = Math.ceil(pictures.length / perPage);
    leaf = Math.min(count - 1, Math.max(0, Math.trunc(leaf)));
    archive.dataset.month = month;
    archive.dataset.leaf = String(leaf);
    pageTitle.textContent = monthLabel(month);
    total.textContent = pictures.length + ' 张照片';
    previous.disabled = leaf === 0;
    next.disabled = leaf === count - 1;
    navigation.hidden = count === 1;
    counter.textContent = (leaf + 1) + ' / ' + count;
    releasePrints(grid);
    grid.replaceChildren();
    const prints = pictures.slice(leaf * perPage, (leaf + 1) * perPage);
    grid.dataset.count = String(prints.length);
    for (const {entry, attached, photo, index} of prints) {
      const figure = node('figure', undefined, 'archive-photo');
      const cover = action('', () => showPhoto(attached, index));
      cover.className = 'cover album-print';
      setPrintProportion(figure, photo);
      cover.dataset.cover = photo.id;
      cover.dataset.photo = photo.id;
      const title = entry.title || entry.cities.join('、');
      cover.setAttribute('aria-label', '放大' + (title || '日常') + '照片 ' + (index + 1));
      const image = node('img');
      image.alt = '';
      image.hidden = true;
      cover.append(image, node('span', '正在加载照片…'));
      const caption = node('figcaption');
      if (title) caption.append(node('strong', title));
      if (entry.day) {
        const day = node('time', entry.day.replaceAll('-', '.'));
        day.dateTime = entry.day;
        caption.append(day);
      }
      const back = action('看这张便签 ↗', () => {
        if (!mayDiscardReplies()) return;
        $('#city').value = '';
        const index = entries.filter(isDiary).findIndex(item => item.id === entry.id);
        wallPage = Math.max(0, Math.floor(index / notesPerWall));
        showSpace('daily');
        render();
        const target = document.getElementById('entry-' + entry.id);
        target?.focus({preventScroll:true});
        target?.scrollIntoView({block:'center'});
      });
      caption.append(back);
      figure.append(cover, caption);
      grid.append(figure);
      observer?.observe(cover);
    }
  }
  display();
  if (savedIndex >= 0) {
    const print = grid.querySelectorAll('.album-print')[savedIndex % perPage];
    savedAlbumPhotoId = null;
    if (activeSpace === 'photos') {
      print.focus({preventScroll:true});
      print.scrollIntoView({block:'nearest', behavior:'instant'});
    }
  }
}
$('#city').addEventListener('change', () => {
  if (!mayDiscardReplies()) { $('#city').value = renderedCity; return; }
  wallPage = 0;
  render();
});
function turnWall(delta) {
  if (!mayDiscardReplies()) return;
  wallPage += delta;
  render();
  const heading = $('#journal-title');
  heading.focus({preventScroll:true});
  heading.scrollIntoView({block:'start', behavior:'instant'});
}
$('#wall-newer').addEventListener('click', () => turnWall(-1));
$('#wall-older').addEventListener('click', () => turnWall(1));

function replySection(entry, onWall = false) {
  const list = replies.filter(reply=>reply.entry_id===entry.id);
  const section = node('details',undefined,'replies');
  const summary = node('summary');
  if (onWall && list.length) {
    const last = list.at(-1);
    const slip = node('span', undefined, 'reply-slip');
    slip.append(node('small', label(last.owner_id)), node('span', last.body));
    summary.append(slip);
  }
  const summaryText = onWall ? (list.length ? list.length + ' 句留言' : '留句话') : '留言 ' + list.length;
  summary.append(node('span', summaryText, 'reply-toggle'));
  section.append(summary);
  for (const reply of list) {
    const row = node('div',undefined,'reply'); row.append(node('small',label(reply.owner_id)),node('p',reply.body));
    if (reply.owner_id === user.id) {
      row.append(action('编辑留言',()=>{
        if(mutating||saving)return;
        const textarea=node('textarea');textarea.value=reply.body;textarea.dataset.replyDraft='edit';textarea.dataset.baseline=reply.body;textarea.maxLength=4000;textarea.rows=3;
        const hint=node('p','输入仅保留在本页。','reply-status');
        const save=action('保存留言',async()=>{
          if(mutating||saving)return;
          if(!textarea.value.trim()) {hint.textContent='请填写留言。';return;}
          const captured=epoch;save.disabled=true;mutating=true;
          try {await api.update('album_replies',reply.id,reply.version,{body:textarea.value.trim()});current(captured);textarea.dataset.baseline=textarea.value;await finishMutation('留言已保存。');}
          catch(error){if(captured===epoch)hint.textContent=message(error);}
          finally{if(captured===epoch){save.disabled=false;mutating=false;}}
        });
        row.replaceChildren(textarea,save,action('取消编辑',()=>{if(mayDiscardReplies())render();}),hint);textarea.focus();
      }),action('删除留言',async()=>{
        if(mutating||saving||!confirm('删除这条自己的留言？'))return;
        const captured=epoch;mutating=true;
        try{await api.remove('album_replies',reply.id,reply.version);current(captured);await finishMutation('留言已删除。');}
        catch(error){if(captured===epoch)status(message(error));}finally{if(captured===epoch)mutating=false;}
      }));
    }
    section.append(row);
  }
  const form=node('form',undefined,'reply-form');
  const textarea=node('textarea');textarea.rows=2;textarea.maxLength=4000;textarea.required=true;textarea.dataset.replyDraft='new';textarea.dataset.baseline='';textarea.placeholder='留一句话';textarea.setAttribute('aria-label','给这一页留言');
  const submit=node('button','发送留言');submit.type='submit';const hint=node('p',undefined,'reply-status');
  let pendingReplyId=crypto.randomUUID();
  form.append(textarea,submit,hint);form.addEventListener('submit',async event=>{
    event.preventDefault();if(mutating||saving||!textarea.value.trim())return;
    const captured=epoch;submit.disabled=true;mutating=true;
    try{const existing=await api.list('album_replies',`id=eq.${pendingReplyId}&select=id,body`);current(captured);if(existing.length&&existing[0].body!==textarea.value.trim())throw new ApiError('前一次留言已经发送。当前文字有改动，请先复制并刷新，再作为新留言发送。',409);if(!existing.length)await api.insert('album_replies',{id:pendingReplyId,entry_id:entry.id,owner_id:user.id,body:textarea.value.trim()});current(captured);pendingReplyId=crypto.randomUUID();textarea.value='';await finishMutation('留言已发送。');}
    catch(error){if(captured===epoch)hint.textContent=message(error);}
    finally{if(captured===epoch){submit.disabled=false;mutating=false;}}
  });section.append(form);return section;
}
async function finishMutation(text) { mutating=false;status(text);signature='';await sync(true); }

function lockEditor(locked) {
  for(const input of $('#entry-form').querySelectorAll('input,textarea,select,button')) input.disabled=locked;
}
function editEntry(entry=null, trip=null, origin=null) {
  if (saving || mutating) return;
  if (draft && !confirm('放弃当前未完成的编辑，打开另一页？')) return;
  clearPendingPreviews();lockEditor(false);$('#entry-form').reset();$('#save-status').textContent='';
  draft={id:entry?.id||crypto.randomUUID(),version:entry?.version??null,exists:!!entry,pending:[],dirty:false};
  draft.trip=trip || entry?.scrapbook || null;
  draft.savedPrints=entry?.scrapbook?.prints || [];
  draft.batch=crypto.randomUUID();
  const guided=!!draft.trip;
  $('#editor').classList.toggle('writing-letter', !guided);
  $('.letterhead').hidden = guided;
  $('#entry-details').open = guided;
  $('#entry-details summary').hidden = guided;
  $('.upload-info').open = false;
  $('.upload-info').hidden = guided && draft.trip.kind === 'note';
  $('#trip-fields').hidden=!guided;
  $('#print-proof').hidden=!guided || draft.trip.kind==='note';
  $('#title').closest('label').hidden=guided;
  $('#cities').closest('label').hidden=guided;
  $('#body').closest('label').hidden=guided && draft.trip.kind!=='note';
  $('#files').closest('label').hidden=guided && draft.trip.kind==='note';
  if(guided) {
    const choices=[...(original.trips?.values() || [])].map(t=>new Option(t.name,t.key));
    $('#trip-choice').replaceChildren(...choices,new Option('新增城市',''));
    $('#trip-choice').value=cityKey(draft.trip.name);
    $('#trip-name-label').hidden=!!$('#trip-choice').value;
    if (!$('#trip-choice').value) $('#trip-name').value=draft.trip.name || '';
  }
  $('#title').value=entry?.title||'';$('#body').value=entry?.body||'';$('#day').max=today();$('#day').value=entry ? (entry.day||'') : today();$('#cities').value=entry?.cities.join('，')||'';
  updateLetterDate();
  $('#editor-title').textContent = entry ? '编辑便签' : '写张便签';
  $('#save-entry').textContent = guided ? '保存这一页' : '贴到墙上';
  $('#save-entry').disabled = false;
  $('#draft-status').textContent='草稿只留在当前页面，刷新和退出后会清空。';
  if(guided) $('#editor-title').textContent=draft.trip.kind==='note'?'写一张手写卡':draft.trip.name?'把照片贴进'+draft.trip.name:'新增城市页';
  renderEditorPhotos();openDialog($('#editor'));
  if (!guided) {
    $('#body').focus({preventScroll:true});
    unfoldPaper($('#editor'), origin);
  }
  return true;
}
function updateLetterDate() {
  const date = $('#day').value;
  const mark = $('.letterhead .postmark');
  mark.dateTime = date;
  mark.textContent = date.replaceAll('-', '.');
  mark.hidden = !date;
}
$('#day').addEventListener('input', updateLetterDate);
$('#empty').addEventListener('click',event=>editEntry(null, null, event.currentTarget.getBoundingClientRect()));
$('#new-entry').addEventListener('click',()=>editEntry());
function renderEditorPhotos() {
  clearPendingPreviews();
  $('#editor-photos').replaceChildren();
  for (const pending of draft?.pending || []) {
    const frame=node('figure',undefined,'pending-photo');
    const image=node('img');image.alt=pending.file.name;
    const url=urlFor(pending.file);pendingPreviewUrls.add(url);image.src=url;
    const caption=node('figcaption',pending.done?'已上传':pending.file.name);
    const remove=action('移除',()=>{if(saving||mutating)return;draft.pending=draft.pending.filter(item=>item!==pending);draft.dirty=true;renderEditorPhotos();});
    if(draft.trip) {
      image.addEventListener('load',()=>{
        if(draft?.pending.includes(pending)) {pending.wide=image.naturalWidth>image.naturalHeight*1.15;renderProof();}
      });
      const words=node('input'); words.maxLength=90;words.value=pending.caption||'';
      words.placeholder='在白边写一句话';words.setAttribute('aria-label',words.placeholder);
      words.oninput=()=>{pending.caption=words.value;renderProof();};
      const move=(delta)=>{
        const list=draft.pending, index=list.indexOf(pending), to=index+delta;
        if(to<0 || to>=list.length)return;
        list.splice(index,1);list.splice(to,0,pending);draft.dirty=true;renderEditorPhotos();
      };
      const before=action('前移',()=>move(-1)), after=action('后移',()=>move(1));
      before.disabled=draft.pending[0]===pending;after.disabled=draft.pending.at(-1)===pending;
      const main=action(pending.main?'主照片 ✓':'设为主照片',()=>{
        draft.pending.forEach(p=>{p.main=p===pending;p.detail=p===pending?false:p.detail;});
        draft.dirty=true;renderEditorPhotos();
      });
      const detail=action(pending.detail?'已夹入纸袋':'夹入纸袋',()=>{
        pending.detail=!pending.detail;if(pending.detail)pending.main=false;
        draft.dirty=true;renderEditorPhotos();
      });
      pending.preview=url;
      frame.append(image,words,before,after,main,detail,remove);$('#editor-photos').append(frame);
      continue;
    }
    frame.append(image,caption,remove);$('#editor-photos').append(frame);
  }
  renderProof();
  const attached=photos.filter(photo=>photo.entry_id===draft?.id);
  for (let index=0;index<attached.length;index++) {
    const photo=attached[index];
    $('#editor-photos').append(action(`查看照片 ${index+1}`,()=>showPhoto(attached,index)),action(`删除照片 ${index+1}`,async()=>{
      if(saving||mutating||!confirm('删除这张画册照片？这会立即同步，无法撤销。'))return;
      const captured=epoch;mutating=true;
      try{
        // Claim an entry revision before removing an object: stale editors cannot delete photos.
        const claimed=await api.update('album_entries',draft.id,draft.version,{updated_at:new Date().toISOString()});current(captured);draft.version=claimed.version;
        await api.deleteObjects([photo.path]);current(captured);
        await api.remove('album_photos',photo.id);current(captured);
        photos=photos.filter(item=>item.id!==photo.id);draft.savedPrints=draft.savedPrints.filter(item=>item.id!==photo.id);renderEditorPhotos();$('#save-status').textContent='这张照片已删除。';signature='';
      }catch(error){if(captured===epoch)$('#save-status').textContent=message(error);}
      finally{if(captured===epoch)mutating=false;}
    }));
  }
}
function renderProof() {
  const proof=$('#print-proof');
  proof.replaceChildren();
  if(!draft?.trip || draft.trip.kind==='note' || !draft.pending.length)return;
  proof.append(node('h3','排版预览'));
  const selected = $('#trip-choice').value || cityKey($('#trip-name').value);
  const prints = original.trips?.get(selected)?.prints || [];
  const before = Math.floor(prints.length / printsPerSpread);
  const old = prints.slice(before * printsPerSpread).map(item => ({...item, saved:true}));
  const leaves = node('div', undefined, 'proof-pages');
  for (const [index, spread] of citySpreads([...old, ...orderPrintBatch(draft.pending)]).entries()) {
    for (const [side, group] of spread.entries()) {
      const page = node('div', undefined, 'proof-page ' + (side ? 'right-page' : 'left-page'));
      page.append(node('p', '第 ' + (before + index + 1) + ' 跨 · ' + (side ? '右页' : '左页'), 'proof-heading'));
      const layout = node('div', undefined, 'city-photo-layout');
      for (const item of group) {
        const figure = node('figure', undefined, 'folio-photo' + (item.wide ? ' landscape' : '') + (item.detail ? ' detail-print' : ''));
        const img = node('img');
        img.alt = '';
        if (item.saved && !item.original) {
          const cover = node('div', undefined, 'folio-image');
          img.hidden = true;
          cover.append(img, node('span', '已贴照片', 'proof-placeholder'));
          figure.append(cover);
          cover.dataset.cover = item.photo.id;
          observer?.observe(cover);
        } else {
          img.src = item.original ? original.urls.get(item.original.file) : item.preview;
          figure.append(img);
        }
        if (item.caption) figure.append(node('figcaption', item.caption));
        layout.append(figure);
      }
      page.append(layout);
      leaves.append(page);
    }
  }
  proof.append(leaves);
}
$('#trip-choice').addEventListener('change',()=>{ $('#trip-name-label').hidden=!!$('#trip-choice').value; renderProof(); });
$('#trip-name').addEventListener('input',renderProof);
$('#entry-form').addEventListener('input',()=>{if(draft){draft.dirty=true;$('#draft-status').textContent='本页有未保存的改动；刷新或退出会丢失。';}});
$('#files').addEventListener('change',()=>{
  if(!draft)return;
  if($('#files').files.length>6){$('#files').value='';$('#save-status').textContent='一次最多选择 6 张照片。';return;}
  const chosen=[...$('#files').files];
  if(!chosen.length)return;
  if(draft.trip && draft.pending.length+chosen.length>6){$('#save-status').textContent='每次最多贴六张，保存后可以继续补。';return;}
  const added=chosen.map(file=>({id:crypto.randomUUID(),file,done:false,caption:''}));
  draft.pending=draft.trip?[...draft.pending,...added]:added;
  $('#files').value='';
  draft.dirty=true;renderEditorPhotos();
});
function mayCloseEditor() {
  if(saving||mutating){$('#save-status').textContent='操作尚未结束，请稍等。';return false;}
  if(draft?.dirty&&!confirm('关闭会清空这次未保存的改动，确定关闭？'))return false;
  clearPendingPreviews();draft=null;$('#entry-form').reset();$('#editor-photos').replaceChildren();return true;
}
$('#close-editor').addEventListener('click',()=>{if(mayCloseEditor())closeDialog($('#editor'));});
$('#editor').addEventListener('cancel',event=>{if(!mayCloseEditor())event.preventDefault();});
$('#editor').addEventListener('close', () => { if (user) sync(); });

$('#entry-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!draft||saving||mutating)return;
  const cities=[...new Set($('#cities').value.split(/[,，]/).map(city=>city.trim()).filter(Boolean))];
  if(cities.length>8||cities.some(city=>city.length>30)){$('#save-status').textContent='最多 8 个城市，每个不超过 30 字。';return;}
  if($('#day').value > today()){$('#save-status').textContent='发生日期不能晚于今天。';return;}
  const content={title:$('#title').value.trim(),body:$('#body').value,day:$('#day').value||null,cities};
  if(draft.trip) {
    const selected=$('#trip-choice').value;
    const name=original.trips?.get(selected)?.name || $('#trip-name').value.trim();
    const key=cityKey(name);
    if(!key){$('#save-status').textContent='填一个城市名。';return;}
    const note=draft.trip.kind==='note';
    if(note && !content.body.trim()){$('#save-status').textContent='在卡片上写一句回忆。';return;}
    if(!note && !draft.pending.length && !draft.savedPrints.length){$('#save-status').textContent='先选一张要贴进画册的照片。';return;}
    content.title=name+(note?' · 手写卡':' · 旅行照片');
    content.cities=[name];
    content.scrapbook={trip:key,name,kind:note?'note':'photos',prints:[...draft.savedPrints,
      ...orderPrintBatch(draft.pending).map(({id,caption,main,wide,detail})=>({id,batch:draft.batch,caption:caption||'',main:!!main,wide:!!wide,detail:!!detail}))]};
  }
  if(!content.title&&!content.body.trim()&&!draft.pending.length&&!photos.some(photo=>photo.entry_id===draft.id)){$('#save-status').textContent='写几句话，或选择一张照片再保存。';return;}
  const captured=epoch,editing=draft;
  saving=true;lockEditor(true);$('#save-status').textContent='正在保存文字…';
  try{
    if(!editing.exists){
      // A prior connection loss may have committed this exact ID; do not duplicate an entry.
      const existing=await api.list('album_entries',`id=eq.${editing.id}&select=*`);current(captured);
      if(existing.length){
        if(existing[0].version!==1||existing[0].deleting)throw new ApiError('此前保存的这一页已被其他设备修改，请复制当前输入后刷新，不能覆盖云端改动。',409);
        editing.exists=true;editing.version=1;
      }
    }
    let row;
    if(editing.exists)row=await api.update('album_entries',editing.id,editing.version,content);
    else row=(await api.insert('album_entries',{id:editing.id,owner_id:user.id,...content}))[0];
    current(captured);editing.exists=true;editing.version=row.version;
    for(let index=0;index<editing.pending.length;index++){
      const pending=editing.pending[index];if(pending.done)continue;
      $('#save-status').textContent=`文字已保存，正在处理照片 ${index+1}/${editing.pending.length}…`;
      const existing=await api.list('album_photos',`id=eq.${pending.id}&select=*`);current(captured);
      if(existing.length){pending.done=true;continue;}
      const prepared=await preparePhoto(pending.file);current(captured);
      const path=`${user.id}/${editing.id}/${pending.id}.jpg`;
      try{await api.upload(path,prepared.blob);}
      catch(error){if(!(error instanceof ApiError&&error.status===409))throw error;}
      current(captured);
      await api.insert('album_photos',{id:pending.id,entry_id:editing.id,owner_id:user.id,path,mime:prepared.mime,bytes:prepared.bytes,width:prepared.width,height:prepared.height});
      current(captured);pending.done=true;
    }
    current(captured);
    if (content.scrapbook && editing.pending.length) original.latestPrint = content.scrapbook.prints.at(-1).id;
    if (content.scrapbook) showSpace('travel', {focus:false});
    else if (activeSpace === 'photos' && editing.pending.length) {
      $('#synced-archive').dataset.month = content.day?.slice(0, 7) || '';
      savedAlbumPhotoId = editing.pending[0].id;
    } else {
      showSpace('daily', {focus:false});
      savedDiaryId = editing.id;
    }
    clearPendingPreviews();
    draft = null;
    $('#entry-form').reset();
    saving = false;
    closeDialog($('#editor'));
    status(content.scrapbook ? '这一页已保存到旅行画册。' : activeSpace === 'photos' ? '照片已收进日常相册。' : '便签已贴到墙上。');
    signature = '';
    await sync(true);
  }catch(error){
    if(captured===epoch){
      $('#save-status').textContent=`${editing.exists?'文字可能已经保存，部分照片尚未完成。':''}${message(error)}\n请保留本页；重试会跳过已确认上传的照片。`;
      $('#draft-status').textContent='保存尚未全部完成，请不要刷新或退出。';editing.dirty=true;
    }
  }finally{if(captured===epoch){saving=false;lockEditor(false);}}
});

async function deleteEntry(entry) {
  if(mutating||saving||!confirm(entry.deleting?'继续清理并永久删除这一页？':'永久删除这一页及其照片和留言？请先导出想保留的内容。'))return;
  const captured=epoch;mutating=true;status('正在认领删除并清理照片…');
  try{
    let claimed=entry;
    if(!entry.deleting){claimed=await api.update('album_entries',entry.id,entry.version,{deleting:true});current(captured);}
    const paths=await api.listObjects(claimed);current(captured);
    for(let offset=0;offset<paths.length;offset+=50){await api.deleteObjects(paths.slice(offset,offset+50));current(captured);}
    const attached=await api.list('album_photos',`entry_id=eq.${entry.id}&select=*`);current(captured);
    for(const photo of attached){await api.remove('album_photos',photo.id);current(captured);}
    await api.remove('album_entries',entry.id,claimed.version);current(captured);
    await finishMutation('这一页已删除。');
  }catch(error){if(captured===epoch){status(`${message(error)} 如出现“正在删除”，可点击“继续删除”完成清理。`);mutating=false;signature='';await sync(true);}}
  finally{if(captured===epoch)mutating=false;}
}

const photoNav=node('div',undefined,'photo-nav');
const previous=action('上一张',()=>loadLarge(-1)),next=action('下一张',()=>loadLarge(1));
const retryPhoto = action('重试加载', () => loadLarge(0));
retryPhoto.hidden = true;
photoNav.append(previous, next, retryPhoto); $('#photo-viewer').append(photoNav);
async function showPhoto(attached,index){viewerState={photos:attached,index,url:null,request:0};openDialog($('#photo-viewer'));await loadLarge(0);}
async function loadLarge(delta){
  if(!viewerState)return;
  const state=viewerState,captured=epoch;state.index=Math.max(0,Math.min(state.photos.length-1,state.index+delta));
  const request=++state.request;previous.disabled=state.index===0;next.disabled=state.index===state.photos.length-1;
  const title = `照片 ${state.index + 1}/${state.photos.length}`;
  const active = () => captured === epoch && viewerState === state && request === state.request;
  revoke(state.url); state.url = null; $('#large-photo').removeAttribute('src');
  retryPhoto.hidden = true;
  $('#photo-title').textContent = title + ' · 正在读取';
  let url;
  try {
    const blob = await api.download(state.photos[state.index].path);
    if (!active()) return;
    url = state.url = urlFor(blob);
    const photo = node('img'); photo.id = 'large-photo'; photo.alt = '画册照片';
    await loadPhotoImage(photo, url);
    if (!active()) return;
    $('#large-photo').replaceWith(photo);
    $('#photo-title').textContent = title;
  } catch (error) {
    revoke(url);
    if (state.url === url) state.url = null;
    if (!active()) return;
    let failure = message(error) || '读取中断，请重试。';
    if (error.name === 'TimeoutError') failure = '读取照片超时，请检查网络后重试。';
    if (error instanceof TypeError) failure = '照片连接暂时中断，请检查网络后重试。';
    $('#photo-title').textContent = title + ' · ' + failure;
    retryPhoto.hidden = false;
  }
}
$('#close-photo').addEventListener('click',()=>closeDialog($('#photo-viewer')));
$('#photo-viewer').addEventListener('close',()=>{revoke(viewerState?.url);viewerState=null;$('#large-photo').removeAttribute('src');});

$('#export').addEventListener('click',async()=>{
  if(mutating||saving)return;
  const captured=epoch;$('#backup-link').replaceChildren();$('#backup-status').textContent='正在读取备份清单…';$('#download-json').disabled=true;$('#download-photos').hidden=true;
  backupState={index:0,batches:[],snapshot:null,url:null,busy:false,stamp:null};openDialog($('#backup'));
  const state=backupState;
  try{
    const snapshot=await Promise.all([api.all('album_entries'),api.all('album_photos'),api.all('album_replies')]);current(captured);if(backupState!==state)return;
    state.snapshot={format:'travel-album-v1',exported_at:new Date().toISOString(),photo_format:'compressed JPEG/WebP, not camera originals',entries:snapshot[0],photos:snapshot[1],replies:snapshot[2]};
    state.batches=packPhotoBatches(snapshot[1]);state.stamp=JSON.stringify(snapshot);
    $('#download-json').disabled=false;$('#download-photos').hidden=!state.batches.length;
    $('#download-photos').textContent=`准备照片第 1/${state.batches.length} 份`;
    $('#backup-status').textContent=`共 ${snapshot[0].length} 页、${snapshot[1].length} 张照片。先下载日记，再逐份下载照片。`;
  }catch(error){if(captured===epoch&&backupState===state)$('#backup-status').textContent=message(error);}
});
function readyDownload(blob,name){
  const state=backupState;revoke(state.url);$('#backup-link').replaceChildren();
  state.url=urlFor(blob);const link=node('a',`保存 ${name}`);link.href=state.url;link.download=name;
  $('#backup-link').append(link);link.focus();
}
$('#download-json').addEventListener('click',()=>{
  if(!backupState?.snapshot)return;
  const content=JSON.stringify(backupState.snapshot,null,2);
  if(new Blob([content]).size>8*1024*1024){$('#backup-status').textContent='日记超过单次 8MB 上限，请联系管理员分批导出。';return;}
  readyDownload(new Blob([content],{type:'application/json'}),'album-journal.json');
});
$('#download-photos').addEventListener('click',async()=>{
  const state=backupState;if(!state?.snapshot||state.busy||state.index>=state.batches.length)return;
  const captured=epoch,index=state.index;state.busy=true;$('#download-photos').disabled=true;$('#download-json').disabled=true;
  revoke(state.url);state.url=null;$('#backup-link').replaceChildren();
  const check=()=>{current(captured);if(backupState!==state)throw new DOMException('备份已关闭','AbortError');};
  try{
    // Recheck data revisions before each batch. Export is a documented quiescent snapshot, not a DB transaction.
    const fresh=await Promise.all([api.all('album_entries'),api.all('album_photos'),api.all('album_replies')]);check();
    if(JSON.stringify(fresh)!==state.stamp)throw new Error('导出期间画册发生变动，请关闭后重新开始备份。');
    const items=[];
    for(const photo of state.batches[index]){
      $('#backup-status').textContent=`第 ${index+1}/${state.batches.length} 份：正在读取照片 ${items.length+1}/${state.batches[index].length}…`;
      const blob=await api.download(photo.path);check();
      if(blob.size!==photo.bytes)throw new Error('照片大小与记录不一致，备份已停止，请联系管理员检查。');
      items.push({name:`photos/${photo.entry_id}/${photo.id}.${photo.mime==='image/webp'?'webp':'jpg'}`,blob});
    }
    const zip=await makeZip(items,check);check();
    readyDownload(zip,`album-photos-${String(index+1).padStart(3,'0')}.zip`);state.index+=1;
    $('#backup-status').textContent=`第 ${index+1} 份已准备好，请点击保存链接。保存后再准备下一份。`;
    $('#download-photos').hidden=state.index>=state.batches.length;
    $('#download-photos').textContent=`准备照片第 ${state.index+1}/${state.batches.length} 份`;
  }catch(error){if(captured===epoch&&backupState===state)$('#backup-status').textContent=message(error);}
  finally{if(captured===epoch&&backupState===state){state.busy=false;$('#download-photos').disabled=false;$('#download-json').disabled=false;}}
});
$('#close-backup').addEventListener('click',()=>closeDialog($('#backup')));
$('#backup').addEventListener('close',()=>{revoke(backupState?.url);backupState=null;$('#backup-link').replaceChildren();});
