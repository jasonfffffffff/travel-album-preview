'use strict';

const filters = [...document.querySelectorAll('[data-city]')];
const gallery = document.querySelector('.gallery');
const pages = [...document.querySelectorAll('[data-place]')];
const resultCount = document.querySelector('#result-count');

for (const button of filters) {
  button.addEventListener('click', () => {
    const city = button.dataset.city;
    for (const filter of filters) {
      filter.setAttribute('aria-pressed', String(filter === button));
    }
    let count = 0;
    for (const page of pages) {
      page.hidden = city !== 'all' && page.dataset.place !== city;
      if (!page.hidden) count += 1;
    }
    gallery.classList.toggle('filtered', city !== 'all');
    resultCount.textContent = `${count} 幅插画`;
  });
}

const viewer = document.querySelector('#viewer');
const viewerImage = document.querySelector('#viewer-image');
const viewerTitle = document.querySelector('#viewer-title');
const closeButton = document.querySelector('#close-viewer');
let opener = null;

for (const button of document.querySelectorAll('[data-art]')) {
  button.addEventListener('click', () => {
    const image = button.querySelector('img');
    viewerImage.src = image.getAttribute('src');
    viewerImage.alt = image.alt;
    viewerImage.width = image.width;
    viewerImage.height = image.height;
    viewerTitle.textContent = button.dataset.title;
    opener = button;
    viewer.showModal();
    document.body.classList.add('viewing');
    closeButton.focus();
  });
}

closeButton.addEventListener('click', () => viewer.close());
viewer.addEventListener('click', (event) => {
  if (event.target !== viewer) return;
  const box = viewer.getBoundingClientRect();
  const outside = event.clientX < box.left || event.clientX > box.right ||
    event.clientY < box.top || event.clientY > box.bottom;
  if (outside) viewer.close();
});
viewer.addEventListener('close', () => {
  document.body.classList.remove('viewing');
  viewerImage.removeAttribute('src');
  if (opener) opener.focus();
});
