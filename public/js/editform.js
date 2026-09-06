// 編輯表單：送出、新增連結、刪除，以及反芻期的倒數。
//
// 這一頁的三件事都繞著同一個事實轉——這張卡還在反芻期內。
// 送出走 PUT，連結只送「要新增的那幾條」（R7：只增不減，所以請求裡
// 根本沒有刪除的表示法），刪除走 DELETE（R9）。

(function () {
  var form = document.getElementById('editcard');
  if (!form) return;
  var id = form.dataset.id;
  var box = document.getElementById('errors');

  function fail(list) {
    box.textContent = '';
    list.forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e;
      box.appendChild(li);
    });
    box.hidden = false;
  }

  // 只收還沒送出的那幾列。既有的連結不在 #linkrows 裡，它們是一份唯讀清單，
  // 所以「不小心把既有的一起送上去」這件事不可能發生。
  function newLinks() {
    return Array.prototype.map
      .call(document.querySelectorAll('#linkrows .linkrow'), function (row) {
        var sel = row.querySelector('select[name=link_rel]');
        var to = row.querySelector('input[type=hidden][name=link_to]');
        return { rel: sel ? sel.value : '', to: to ? to.value.trim() : '' };
      })
      .filter(function (l) { return l.to !== ''; });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var d = new FormData(form);
    fetch('/c/' + id, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        title: d.get('title'),
        body: d.get('body'),
        tags: d.get('tags'),
        url: d.get('url'),
        add_links: newLinks(),
      }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok) window.location.href = '/c/' + id;
        else fail(res.j.errors || ['沒有存成功']);
      })
      .catch(function () { fail(['沒有存成功']); });
  });

  // R9：刪除。不可回復，所以問一次——這是唯一一條會讓東西消失的路徑。
  // 「刪除不等於抹除」：檔案從 cards/ 消失，內容仍留在 git 歷史裡。
  var del = document.getElementById('deletecard');
  if (del) {
    del.addEventListener('click', function () {
      if (!window.confirm('刪除這張卡片嗎？卡片只有在建立之後的一定時間內可以刪除。')) return;
      fetch('/c/' + del.dataset.id, { method: 'DELETE', headers: { accept: 'application/json' } })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok) window.location.href = '/';
          else fail(res.j.errors || ['沒有刪成功']);
        })
        .catch(function () { fail(['沒有刪成功']); });
    });
  }

  // ---------------------------------------------------------------- 倒數
  //
  // 只有這一頁有倒數。卡片頁是拿來讀的，一個每秒跳一次的數字放在內文上方
  // 是干擾（U12）；在這裡你就是在跟那段時間賽跑。
  //
  // 但窗口從五分鐘變成八小時（R5）之後，「賽跑」不再一直成立：還剩七小時的
  // 時候那個數字只是噪音，而 m:ss 會排出「480:00」這種讀不出意思的東西。
  // 所以遠的時候說小時與分、每半分鐘更新；進到最後一小時才變成秒。

  function lockText(ms) {
    if (ms <= 0) return '已定案';
    var secs = Math.round(ms / 1000);
    if (secs >= 3600) {
      return '還可修改 ' + Math.floor(secs / 3600) + ' 小時 ' + Math.floor((secs % 3600) / 60) + ' 分';
    }
    var m = Math.floor(secs / 60);
    var s = secs % 60;
    return '還可修改 ' + m + ':' + (s < 10 ? '0' : '') + s;
  }

  var lock = document.getElementById('lock');
  var until = lock ? Date.parse(lock.dataset.until || '') : NaN;
  if (!isNaN(until)) {
    var tick = function () {
      var left = until - Date.now();
      lock.textContent = lockText(left);
      if (left > 0) setTimeout(tick, left > 3600000 ? 30000 : 1000);
    };
    tick();
  }
})();
