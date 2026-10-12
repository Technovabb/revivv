/* Before / after reveal sliders (standalone — used on the Work page). */
document.querySelectorAll('.ba').forEach(function (ba) {
  var range = ba.querySelector('.ba-range');
  if (!range) return;
  ba.style.setProperty('--split', '50%');
  range.addEventListener('input', function () {
    ba.style.setProperty('--split', range.value + '%');
  });
});
