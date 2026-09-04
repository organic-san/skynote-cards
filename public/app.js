// 左側選單、右下的按鈕（隨手記或動作選單）、以及卡片還剩多久鎖定。

(function () {
  var drawer = document.getElementById('drawer');
  var scrim = document.getElementById('scrim');
  var menubtn = document.getElementById('menubtn');

  function setDrawer(open) {
    if (!drawer) return;
    drawer.classList.toggle('open', open);
    if (scrim) scrim.hidden = !open;
    if (menubtn) menubtn.setAttribute('aria-expanded', String(open));
  }

  if (menubtn) menubtn.addEventListener('click', function () { setDrawer(true); });
  if (scrim) scrim.addEventListener('click', function () { setDrawer(false); });
  var drawerclose = document.getElementById('drawerclose');
  if (drawerclose) drawerclose.addEventListener('click', function () { setDrawer(false); });

  // 右下的按鈕在卡片頁是動作選單，在其他地方是隨手記——
  // 兩者的開關方式一樣，所以共用同一個 id。
  var fab = document.getElementById('fab');
  var fabmenu = document.getElementById('fabmenu');

  function setMenu(open) {
    if (!fabmenu) return;
    fabmenu.hidden = !open;
    if (fab) fab.setAttribute('aria-expanded', String(open));
    if (open) {
      var first = fabmenu.querySelector('input, textarea');
      if (first) first.focus();
    }
  }

  if (fab) {
    fab.addEventListener('click', function (ev) {
      ev.stopPropagation();
      setMenu(fabmenu.hidden);
    });
  }
  document.addEventListener('click', function (ev) {
    if (fabmenu && !fabmenu.hidden && !fabmenu.contains(ev.target)) setMenu(false);
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    setDrawer(false);
    setMenu(false);
  });

  var lock = document.getElementById('lock');
  var until = lock ? Date.parse(lock.dataset.until || '') : NaN;
  if (!isNaN(until)) {
    var tick = function () {
      var left = Math.max(0, Math.round((until - Date.now()) / 1000));
      var m = Math.floor(left / 60);
      var s = left % 60;
      lock.textContent = left > 0 ? m + ':' + (s < 10 ? '0' : '') + s : 'locked';
    };
    tick();
    setInterval(tick, 1000);
  }
})();
