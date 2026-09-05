// 建立表單依型別開關欄位。
//
// 哪一型顯示哪些欄位是伺服器那張表（formSpec）送過來的，不在這裡再寫一次。
// 這支檔案只做一件事：讀型別、開關欄位、把型別寫到 #linksfield 上。
// 連結列自己看著那個屬性重畫（見 links.js），兩邊不互相呼叫。

(function () {
  var form = document.getElementById('newform');
  if (!form) return;

  var SPECS = JSON.parse(form.dataset.specs || '{}');
  var region = document.getElementById('linksfield');

  var FIELDS = {
    singlefield: function (s) { return s.single; },
    titlefield: function (s) { return !s.single; },
    bodyfield: function (s) { return !s.single; },
    tagsfield: function (s) { return !s.single; },
    urlfield: function (s) { return s.url; },
    sourcefields: function (s) { return s.source; },
    provfield: function (s) { return s.source; },
    linksfield: function (s) { return s.links; }
  };

  // 型別可能是一組 radio，也可能是一個 hidden input（由入口決定、鎖住的時候）。
  // form.elements 兩種都認得：RadioNodeList 的 value 是被選中的那個，
  // 單一 input 的 value 就是它自己。用 ':checked' 找會在鎖住時整個瞎掉。
  function currentType() {
    var el = form.elements.type;
    return el && typeof el.value === 'string' ? el.value : '';
  }

  function sync() {
    var type = currentType();
    // 沒選型別時什麼都不開——這一組要跟伺服器的 formSpec() 退回值一致。
    var spec = SPECS[type] || { single: false, url: false, source: false, links: false };

    var hint = document.getElementById('linkshint');
    if (hint) hint.classList.toggle('off', spec.links);

    Object.keys(FIELDS).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var on = FIELDS[id](spec);
      el.classList.toggle('off', !on);
      // 關掉的欄位一律 disabled：既不會被送出，隱藏的必填欄位也不會擋住送出。
      Array.prototype.forEach.call(el.querySelectorAll('input, textarea, select'), function (c) {
        c.disabled = !on;
        // 標題與那句話互為替身：開著的那一個才是必填的。
        if (c.name === 'title' || c.name === 'quick_body') c.required = on;
      });
    });

    if (region) region.dataset.cardType = type;
  }

  form.addEventListener('change', function (ev) {
    if (ev.target.name === 'type') sync();
  });

  sync();
})();
