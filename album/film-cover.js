// The sleeve moves in frame-sized steps. Its images come from the signed-in book.
export function mountFilmCover(root, { originalURL, observePhoto, openCity, compose }) {
  const brand = root.querySelector('.brand > span');
  const title = brand.firstChild.textContent.trim();
  const subtitle = brand.querySelector('small').textContent;
  const dedication = root.querySelector('.overline').textContent;
  const clock = root.querySelector('.together-ticket');
  const cover = document.createElement('section');
  cover.className = 'album-cover';
  cover.setAttribute('aria-labelledby', 'space-title');
  cover.innerHTML = `
    <div class="cover-copy">
      <p class="cover-dedication"></p>
      <h1 id="space-title"></h1>
      <p class="cover-subtitle"></p>
      <div class="cover-actions"><button type="button" class="open-city"></button><button type="button" class="cover-write">写下今天</button></div>
    </div>
    <div class="reel-stage">
      <div class="film-window" role="group" aria-label="城市底片，左右拖动或按方向键选择城市" tabindex="0"><div class="film-track"></div></div>
      <div class="reel-controls">
        <button type="button" class="reel-prev" aria-label="上一格底片">←</button>
        <output aria-live="polite"></output>
        <button type="button" class="reel-next" aria-label="下一格底片">→</button>
      </div>
    </div>`;
  cover.querySelector('h1').textContent = title;
  cover.querySelector('.cover-dedication').textContent = dedication;
  cover.querySelector('.cover-subtitle').textContent = subtitle;
  cover.querySelector('.cover-copy').append(clock);
  root.replaceChildren(...root.querySelectorAll('link'), cover);
  const viewport = cover.querySelector('.film-window');
  const track = cover.querySelector('.film-track');
  const open = cover.querySelector('.open-city');
  const previous = cover.querySelector('.reel-prev');
  const next = cover.querySelector('.reel-next');
  const output = cover.querySelector('output');
  const motion = matchMedia('(prefers-reduced-motion:reduce)');
  let frames = [], selected = 0, signature = '', pointer = null, travelled = false;
  cover.querySelector('.cover-write').addEventListener('click', compose);
  const activeFrame = () => track.children[selected];
  const step = () => track.children[1] ? track.children[1].offsetLeft - track.children[0].offsetLeft : track.firstElementChild?.offsetWidth || 1;
  function position(offset = 0) {
    track.style.transform = 'translateX(' + (-selected * step() + offset) + 'px)';
  }
  function show(index) {
    if (!frames.length) return;
    selected = Math.max(0, Math.min(index, frames.length - 1));
    const city = frames[selected];
    previous.disabled = selected === 0;
    next.disabled = selected === frames.length - 1;
    open.textContent = city.key === 'next-trip' ? '翻到画册末页　↗' : '翻开' + city.name + '　↗';
    output.textContent = (selected + 1).toString().padStart(2, '0') + ' / ' + frames.length.toString().padStart(2, '0') + '　' + city.name;
    Array.from(track.children).forEach((frame, i) => {
      frame.setAttribute('aria-current', String(i === selected));
      frame.tabIndex = i === selected ? 0 : -1;
      frame.setAttribute('aria-label', (i === selected ? '翻开' : '选中') + frames[i].name);
    });
    position();
  }
  function enter() {
    const city = frames[selected];
    if (city) openCity(city.key, activeFrame().querySelector('img'));
  }
  open.onclick = enter;
  previous.onclick = () => show(selected - 1);
  next.onclick = () => show(selected + 1);
  viewport.onkeydown = event => {
    if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    show(selected + (event.key === 'ArrowRight' ? 1 : -1));
    activeFrame()?.focus({ preventScroll:true });
  };
  viewport.onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0) return;
    pointer = { id:event.pointerId, x:event.clientX, y:event.clientY };
    travelled = false;
  };
  viewport.onpointermove = event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    if (!travelled) {
      if (Math.abs(dx) < 7) return;
      if (Math.abs(dy) > Math.abs(dx)) { pointer = null; return; }
      travelled = true;
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('pulling');
    }
    const edge = selected === 0 && dx > 0 || selected === frames.length - 1 && dx < 0;
    position(edge ? dx * .15 : dx);
  };
  function release(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    pointer = null;
    viewport.classList.remove('pulling');
    if (!travelled) return;
    const move = event.type === 'pointerup' && Math.abs(dx) > Math.min(48, step() * .2);
    show(selected + (move ? -Math.sign(dx) * Math.max(1, Math.round(Math.abs(dx) / step())) : 0));
  }
  viewport.onpointerup = release;
  viewport.onpointercancel = release;
  viewport.ondragstart = event => event.preventDefault();
  track.onclick = event => {
    if (travelled && event.detail) { travelled = false; return; }
    const frame = event.target.closest('.film-cell');
    if (!frame) return;
    const index = Array.from(track.children).indexOf(frame);
    if (index === selected) enter();
    else show(index);
  };
  const observer = new ResizeObserver(() => position());
  observer.observe(viewport);

  function update(trips) {
    const cities = [...trips.values(), {key:'next-trip', name:'下一趟', prints:[]}];
    const key = JSON.stringify(cities.map(city => [city.key, city.name, city.prints[0]?.original?.file || city.prints[0]?.photo?.id]));
    if (key !== signature) {
      const oldCity = frames[selected]?.key;
      frames = cities;
      signature = key;
      const cells = cities.map((city, i) => {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'film-cell';
        const opening = document.createElement('span');
        opening.className = 'film-image';
        const print = city.prints[0];
        if (print) {
          const image = document.createElement('img');
          image.alt = city.name + '旅行照片';
          image.draggable = false;
          if (print.original) image.src = originalURL(print.original.file);
          else {
            opening.dataset.cover = print.photo.id;
            image.hidden = true;
          }
          opening.append(image);
        } else {
          opening.textContent = city.key === 'next-trip' ? '待拍' : city.name;
          cell.classList.add('unexposed');
        }
        const caption = document.createElement('span');
        caption.className = 'film-caption';
        const number = document.createElement('b');
        number.textContent = String(i + 1).padStart(2, '0');
        caption.append(number, document.createTextNode(city.name));
        cell.append(opening, caption);
        return cell;
      });
      track.replaceChildren(...cells);
      show(Math.max(0, cities.findIndex(city => city.key === oldCity)));
    }
    for (const opening of track.querySelectorAll('[data-cover]')) {
      if (!opening.querySelector('img')) {
        const image = document.createElement('img');
        image.hidden = true;
        image.draggable = false;
        image.alt = '旅行照片';
        opening.prepend(image);
      }
      observePhoto(opening);
    }
  }
  function reveal() {
    if (!motion.matches) viewport.animate([
      { transform:'translate(24%, -5%) rotate(-9deg)', opacity:.2 },
      { transform:'translate(0) rotate(-5deg)', opacity:1 }
    ], {duration:750,easing:'cubic-bezier(.16,.72,.2,1)'});
  }
  return {update, reveal, enter, dispose(){observer.disconnect();}};
}
