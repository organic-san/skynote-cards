// 編輯用 PUT 送出。倒數由 app.js 負責。

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
      }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok) window.location.href = '/c/' + id;
        else fail(res.j.errors || ['沒有存成功']);
      })
      .catch(function () { fail(['沒有存成功']); });
  });
})();
