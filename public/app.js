// 左側選單、新增鈕的類型選單、以及卡片還剩多久鎖定。

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

  var fab = document.getElementById('fab');
  var typemenu = document.getElementById('typemenu');

  function setMenu(open) {
    if (!typemenu) return;
    typemenu.hidden = !open;
    if (fab) fab.setAttribute('aria-expanded', String(open));
  }

  if (fab) {
    fab.addEventListener('click', function (ev) {
      ev.stopPropagation();
      setMenu(typemenu.hidden);
    });
  }
  document.addEventListener('click', function (ev) {
    if (typemenu && !typemenu.hidden && !typemenu.contains(ev.target)) setMenu(false);
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
