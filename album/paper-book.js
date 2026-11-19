export function cityKey(name) {
  if (typeof name !== 'string') return '';
  const normalized = name.trim().normalize('NFC');
  return normalized ? 'city:' + normalized.toLocaleLowerCase('zh-CN') : '';
}

export const printsPerSpread = 4;

export function citySpreads(prints) {
  const pages = [];
  for (let offset = 0; offset < prints.length; offset += printsPerSpread) {
    pages.push(prints.slice(offset, offset + printsPerSpread));
  }
  return (pages.length ? pages : [[]]).map(group => [
    group.filter((_, index) => index % 2 === 0),
    group.filter((_, index) => index % 2 === 1),
  ]);
}

export function orderPrintBatch(prints) {
  const featured = prints.findIndex(print => print.main);
  if (featured < 1) return prints;
  return [prints[featured], ...prints.slice(0, featured), ...prints.slice(featured + 1)];
}

export function bindBook(desk, pages, nav, initial, remember) {
  const [prev, next] = nav.querySelectorAll('button');
  const count = nav.querySelector('output');
  const mobile = matchMedia('(max-width:700px)');
  const reduce = matchMedia('(prefers-reduced-motion:reduce)');
  let start = 0, turn = null, gesture = null, frame = 0, suppress = false;
  const step = () => mobile.matches ? 1 : 2;
  function paint(index) {
    start = Math.floor(Math.max(0, Math.min(index, pages.length - 1)) / step()) * step();
    pages.forEach((p, i) => { p.hidden = i < start || i >= start + step(); });
    count.textContent = (step() === 1 ? start + 1 : (start + 1) + '–' + Math.min(start + 2,pages.length)) + ' / ' + pages.length;
    prev.disabled = start === 0;
    next.disabled = start + step() >= pages.length;
    remember(pages[Math.max(start, Math.min(index, start + step() - 1, pages.length - 1))].dataset.key);
  }
  function clear() {
    cancelAnimationFrame(frame);
    turn?.overlay.remove();
    turn = null;
  }
  function jump(index) { clear(); gesture = null; paint(index); }
  function begin(direction) {
    const old = start, target = old + direction * step();
    if (target < 0 || target >= pages.length) return false;
    const single = step() === 1, forward = direction > 0;
    const from = single ? (forward ? old : target) : old + (forward ? 1 : 0);
    const to = single ? null : target + (forward ? 0 : 1);
    const overlay = document.createElement('div');
    overlay.className = 'curl-layer';
    overlay.inert = true;
    overlay.setAttribute('aria-hidden','true');
    const clone = i => {
      const el = pages[i].cloneNode(true);
      el.hidden = false;
      el.querySelectorAll('img').forEach(img => { img.loading = 'eager'; });
      return el;
    };
    const stationaryIndex = single || forward ? old : old + 1;
    if ((!single || !forward) && pages[stationaryIndex]) {
      const stationary = clone(stationaryIndex);
      stationary.classList.add('stationary');
      stationary.style.left = single || forward ? '0' : '50%';
      overlay.append(stationary);
    }
    const width = desk.clientWidth / step(), slices = [], n = 12;
    for (let j=0;j<n;j++) {
      const strip = document.createElement('div');
      strip.className = 'curl-strip';
      strip.style.width = (width/n + 0.7) + 'px';
      const k = forward || single ? j : n-1-j;
      for (const [side, idx] of [from,to].entries()) {
        if (idx == null || !pages[idx]) continue;
        const face = document.createElement('div');
        face.className = 'curl-face' + (side ? ' reverse' : '');
        const paper = clone(idx);
        paper.style.width = width + 'px';
        paper.style.left = -(side ? n-1-k : k)*width/n + 'px';
        face.append(paper); strip.append(face);
      }
      overlay.append(strip); slices.push(strip);
    }
    paint(target); desk.append(overlay);
    turn = {old,target,forward,single,width,slices,overlay,p:0};
    draw(0);
    return true;
  }
  function draw(progress) {
    const t=turn;
    if (!t) return;
    t.p=progress;
    const dir=t.single || t.forward ? 1 : -1;
    const p=t.single && !t.forward ? 1-progress : progress;
    let x=t.single ? 0 : t.width, z=0;
    t.slices.forEach((strip,j) => {
      const u=(j+0.5)/t.slices.length;
      const angle=Math.PI*p + .94*Math.sin(Math.PI*p)*(u-.28);
      const segment=t.width/t.slices.length;
      const dx=dir*Math.cos(angle)*segment, dz=Math.sin(angle)*segment;
      strip.style.transform='translate3d('+ (dir>0?x:x+dx) +'px,0,'+(dir>0?z:z+dz)+'px) rotateY('+(-dir*angle)+'rad)';
      for(const face of strip.children) face.style.filter='brightness('+(1-.24*Math.abs(Math.sin(angle)))+')';
      x+=dx; z+=dz;
    });
    t.overlay.style.setProperty('--cast',String(Math.sin(Math.PI*p)*.34));
  }
  function finish(commit) {
    if (!turn) return;
    const from=turn.p, end=commit?1:0, target=commit?turn.target:turn.old;
    const began=performance.now(), duration=160+340*Math.abs(end-from);
    function tick(now) {
      const t=Math.min(1,(now-began)/duration);
      draw(from+(end-from)*(1-(1-t)**3));
      if(t<1) frame=requestAnimationFrame(tick);
      else jump(target);
    }
    frame=requestAnimationFrame(tick);
  }
  function move(dir) {
    if(turn) jump(turn.target);
    if(reduce.matches) jump(start+dir*step());
    else if(begin(dir)) finish(true);
  }
  prev.onclick=()=>move(-1); next.onclick=()=>move(1);
  desk.onkeydown=e=>{
    if(!['ArrowLeft','ArrowRight'].includes(e.key)) return;
    e.preventDefault(); desk.focus({preventScroll:true}); move(e.key==='ArrowRight'?1:-1);
  };
  desk.ondragstart=e=>e.preventDefault();
  desk.onpointerdown=e=>{
    if(!e.isPrimary || e.button!==0) return;
    if(turn) jump(turn.target);
    gesture={x:e.clientX,y:e.clientY,id:e.pointerId}; suppress=false;
  };
  desk.onpointermove=e=>{
    if(!gesture || gesture.id!==e.pointerId) return;
    const dx=e.clientX-gesture.x, dy=e.clientY-gesture.y;
    if(!gesture.dir) {
      if(Math.abs(dx)<8 || Math.abs(dx)<Math.abs(dy)*1.3) return;
      gesture.dir=dx<0?1:-1;
      if(!reduce.matches && !begin(gesture.dir)){gesture=null;return;}
      desk.setPointerCapture(e.pointerId); suppress=true;
    }
    if(turn) draw(Math.min(.995,Math.max(0,-dx*gesture.dir/(desk.clientWidth/step()*.83))));
  };
  desk.onpointerup=e=>{
    if(!gesture || gesture.id!==e.pointerId) return;
    const dx=e.clientX-gesture.x, dir=gesture.dir;
    const commit=dir && -dx*dir>Math.min(55,desk.clientWidth*.13);
    gesture=null;
    if(turn) finish(commit);
    else if(commit) move(dir);
  };
  desk.onpointercancel=()=>{ gesture=null; if(turn) finish(false); };
  desk.addEventListener('click',e=>{if(suppress && e.detail){e.stopPropagation();suppress=false;}},true);
  const resize=()=>jump(start);
  mobile.addEventListener('change',resize);
  paint(initial);
  return {jump,dispose(){clear();mobile.removeEventListener('change',resize);}};
}
