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

  // ------------------------------------------------------------ 日期
  //
  // U4：資料一律 UTC，渲染時區以用戶端為主。
  // 伺服器給的是 <time datetime="…Z"> 加一段保底文字；這裡依瀏覽器所在的時區
  // 重算。沒有這段腳本頁面照樣讀得懂，只是可能差一天——漸進增強，不是依賴。
  //
  // 「今天 / 昨天」是體感詞，而體感是本地的：用 UTC 算，
  // 台北時間早上八點以前寫的卡片會標成昨天。那不是誤差，是錯的。

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  // 只有今天與昨天有體感差異，值得換成相對說法；再遠一律回到日期。
  function relDate(d, now) {
    var days = Math.round((midnight(now) - midnight(d)) / 86400000);
    if (days === 0) return '今天';
    if (days === 1) return '昨天';
    var md = pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '-' + md;
  }

  // 時刻。「今天」只說了是哪一天，而同一天裡寫了幾張卡的先後才是有意義的資訊——
  // 相對說法把它弄丟了，所以補回來放在日期底下。
  function clock(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  // 卡片詳細頁一律顯示絕對日期與時間，不套相對說法。
  function absDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  Array.prototype.forEach.call(document.querySelectorAll('time[datetime]'), function (el) {
    var d = new Date(el.getAttribute('datetime'));
    if (isNaN(d.getTime())) return;
    el.textContent = el.hasAttribute('data-rel') ? relDate(d, new Date()) : absDate(d);
    el.title = d.toLocaleString();
    // 時刻跟日期在同一列的不同欄，所以從整列去找那個位置。
    var row = el.closest ? el.closest('.row') : null;
    var slot = row && row.querySelector('.rowtime');
    if (slot) slot.textContent = clock(d);
  });

  // ------------------------------------------------------------ 將存為什麼
  //
  // U18：把已經做完的判斷顯示出來。不是多一次決策——
  // 「不填標題就是碎片」那條生死線不動，只是讓結果在送出前可見。

  var quick = document.getElementById('quickform');
  var willsave = document.getElementById('quicksubmit');
  if (quick && willsave) {
    var titleInput = quick.querySelector('input[name=title]');
    var label = willsave.querySelector('span');
    var syncWillSave = function () {
      label.textContent = titleInput.value.trim() === '' ? '碎片' : '思考';
    };
    titleInput.addEventListener('input', syncWillSave);
    syncWillSave();
  }

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
