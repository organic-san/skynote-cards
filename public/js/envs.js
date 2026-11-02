// 環境面板（v3.1）：拖曳排序。
//
// 面板本身是瀏覽器內建的 popover，新增與改名是一般的表單，都不靠這支。
// 這裡只做一件事：拿著把手把一列拖到別的位置，放開就把整份順序送出去。
//
// 用 Pointer Events，不用 HTML 的 drag and drop：後者在觸控螢幕上不會觸發，
// 滑鼠、觸控、觸控筆在這裡是同一套。拿著的那一列跟著指標走，越過鄰居的一半
// 就跟它換位置——移動的是鄰居，不是拿著的那一列：被移動的元素會丟掉
// pointer capture 與焦點。把手也吃上下鍵，鍵盤一樣排得動。
//
// 停手一下才送（連按幾次上下鍵只送一次），一次只送一個。沒存成功就退回
// 伺服器那一份：畫面上的順序不能說一件伺服器沒有記下來的事。

(function () {
  var list = document.getElementById('envsort');
  if (!list) return;
  var note = document.getElementById('envnote');
  var nav = document.querySelector('.drawerenvs');

  var saved = names();
  var timer = null;
  var sending = false;
  var dragging = false;

  function names() {
    return Array.prototype.map.call(list.children, function (li) { return li.dataset.env; });
  }

  // 側欄照同一份順序排。（無環境）不在這份順序裡，伺服器把它排在排過的後面。
  function sidebar(order) {
    if (!nav) return;
    var links = {};
    Array.prototype.forEach.call(nav.querySelectorAll('a[data-env]'), function (a) {
      links[a.dataset.env] = a;
    });
    order.forEach(function (name) { if (links[name]) nav.appendChild(links[name]); });
    if (links['']) nav.appendChild(links['']);
  }

  function arrange(order) {
    var rows = {};
    Array.prototype.forEach.call(list.children, function (li) { rows[li.dataset.env] = li; });
    order.forEach(function (name) { if (rows[name]) list.appendChild(rows[name]); });
    sidebar(order);
  }

  function moved() {
    sidebar(names());
    clearTimeout(timer);
    timer = setTimeout(send, 400);
  }

  function send() {
    if (sending) { moved(); return; }
    var order = names();
    if (order.join('\n') === saved.join('\n')) return;
    sending = true;
    fetch('/envs/order', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ order: order }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(function (j) {
        saved = j.order;
        if (note) note.textContent = '';
      })
      .catch(function () {
        arrange(saved);
        if (note) note.textContent = '順序沒有存到，已經放回原本的樣子。';
      })
      .then(function () { sending = false; });
  }

  list.addEventListener('pointerdown', function (ev) {
    var grip = ev.target.closest('.envgrip');
    if (!grip || ev.button !== 0 || dragging) return;
    var row = grip.closest('.envitem');
    ev.preventDefault();
    grip.setPointerCapture(ev.pointerId);
    dragging = true;
    row.classList.add('dragging');
    var startY = ev.clientY;

    // 換位置之後，這一列在版面上移動了多少（offsetTop 不受 transform 影響）。
    function shift(swap) {
      var top = row.offsetTop;
      swap();
      return row.offsetTop - top;
    }

    function move(e) {
      var sib;
      while ((sib = row.nextElementSibling) && e.clientY - startY > sib.offsetHeight / 2) {
        startY += shift(function () { list.insertBefore(sib, row); });
      }
      while ((sib = row.previousElementSibling) && startY - e.clientY > sib.offsetHeight / 2) {
        startY += shift(function () { list.insertBefore(sib, row.nextSibling); });
      }
      row.style.transform = 'translateY(' + (e.clientY - startY) + 'px)';
    }

    // 放開、被系統取消、或面板在拖到一半時被關掉（capture 跟著沒了），都在這裡收尾。
    function end() {
      if (!dragging) return;
      dragging = false;
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      grip.removeEventListener('lostpointercapture', end);
      row.style.transform = '';
      row.classList.remove('dragging');
      moved();
    }

    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('lostpointercapture', end);
  });

  list.addEventListener('keydown', function (ev) {
    var grip = ev.target.closest('.envgrip');
    if (!grip || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
    ev.preventDefault();
    var row = grip.closest('.envitem');
    var sib = ev.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
    if (!sib) return;
    // 一樣是鄰居換過來，焦點才留在這一列的把手上。
    if (ev.key === 'ArrowUp') list.insertBefore(sib, row.nextSibling);
    else list.insertBefore(sib, row);
    moved();
  });
})();
