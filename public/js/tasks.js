// 待辦勾選（v3 §2）：卡片頁上的核取方塊。
//
// 伺服器把每個 `[ ]` / `[x]` 畫成 disabled 的核取方塊（render.ts 的 task_mark），
// 能不能勾由這裡決定：只有卡片頁會載入這支，所以來源面板與沒有 JS 的頁面停在唯讀。
//
// 勾選不算修改（R14）：任何時候都能勾，被引用而定案的卡也一樣。
//
// 每一次勾選帶著頁面載入時的 rev。別處改過這張卡，序號可能已經指到別的項目，
// 伺服器就回 409——這時候重新載入，看到的才是現在的內容。
// 請求一次只送一個，前一個回來才送下一個：成功時伺服器交回新的 rev，
// 連點兩下的話，第二下要帶的是第一下之後的那一個。

(function () {
  var body = document.querySelector('.body[data-rev]');
  if (!body) return;
  var boxes = body.querySelectorAll('input.taskbox[data-task]');
  if (boxes.length === 0) return;

  var id = body.dataset.id;
  var queue = Promise.resolve();

  function send(box) {
    return fetch('/c/' + id + '/tasks/' + box.dataset.task, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ checked: box.checked, rev: body.dataset.rev }),
    })
      .then(function (r) {
        if (r.status === 409) { window.location.reload(); return; }
        if (!r.ok) throw new Error(String(r.status));
        return r.json().then(function (j) {
          body.dataset.rev = j.rev;
          // 複製與下載讀的是 data-md，不換掉就會交出勾選之前的版本。
          body.dataset.md = j.md;
        });
      })
      .catch(function () {
        // 沒有存成功就退回去：畫面上的勾不能說一件伺服器沒有記下來的事。
        box.checked = !box.checked;
      });
  }

  Array.prototype.forEach.call(boxes, function (box) {
    box.disabled = false;
    box.addEventListener('change', function () {
      queue = queue.then(function () { return send(box); });
    });
  });
})();
