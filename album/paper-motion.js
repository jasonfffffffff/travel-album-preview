// Grow a real sheet from the paper the reader picked up.
export function unfoldPaper(sheet, origin) {
  if (!origin?.width || origin.bottom < 0 || origin.top > innerHeight || matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  const end = sheet.getBoundingClientRect();
  if (!end.width || !end.height) return;
  const x = origin.left + origin.width / 2 - end.left - end.width / 2;
  const y = origin.top + origin.height / 2 - end.top - end.height / 2;
  const scale = Math.max(.14, Math.min(.96, origin.width / end.width));
  sheet.animate([
    {transform:`translate(${x}px,${y}px) perspective(850px) rotateX(24deg) rotate(-4deg) scale(${scale})`,opacity:.65},
    {transform:'none',opacity:1}
  ], {duration:485, easing:'cubic-bezier(.19,.75,.2,1)'});
}
