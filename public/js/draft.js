// 草稿暫存：還沒送出的文字留在瀏覽器裡，關掉分頁不會消失。
//
// **分槽**。表單的身分由伺服器印在 form[data-draft-scope] 上，前端不自己推導——
// 「這是哪一張表單」只有伺服器知道（型別、來源卡、當前的標籤篩選都在它手上），
// 前端要猜就得把那些規則抄一份，然後兩份會慢慢長歪。
//
// 分槽而不是共用一格，是因為寫作會被打斷：寫到一半跳去另一張表單，
// 回來時前一份還要在。共用一格的話，第二張表單一開就把第一份洗掉了。
//
// 草稿是加分項不是必需品——localStorage 在無痕視窗會丟例外、配額也會滿。
// 所以每一次存取都包在 try 裡，失敗就當作沒有草稿，頁面照常運作。

(function () {
  var PREFIX = 'skynote:draft:v1:';
  /** 超過這個歲數的草稿自動清掉。 */
  var MAX_AGE = 14 * 24 * 60 * 60 * 1000;
  /** 槽的總數上限，超過就從最舊的淘汰。 */
  var MAX_KEEP = 20;
  var DEBOUNCE = 400;

  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function write(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 存不了就算了 */ } }
  function drop(k) { try { localStorage.removeItem(k); } catch (e) { /* 同上 */ } }

  function ourKeys() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i += 1) {
        var k = localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) out.push(k);
      }
    } catch (e) { /* 讀不到就當沒有 */ }
    return out;
  }

  function load(scope) {
    var raw = read(PREFIX + scope);
    if (!raw) return null;
    try {
      var d = JSON.parse(raw);
      return d && d.v === 1 && d.fields ? d : null;
    } catch (e) {
      // 格式壞掉的留著只會每次載入都再解析失敗一次。
      drop(PREFIX + scope);
      return null;
    }
  }

  // 編輯頁走 fetch PUT，沒有導向可以掛 ?d=，所以它得在請求成功之後自己清除。
  // 這是這支檔案唯一對外的介面（見 editform.js）。
  window.skynoteDraft = {
    clear: function (scope) { if (scope) drop(PREFIX + scope); },
  };

  // ---------------------------------------------------------------- 欄位

  /*
    存哪些欄位：使用者可以打字的那幾個。

    **連結列不存。** 目標卡片可能在草稿存活的兩星期裡被刪掉（R9），
    還原出來就是一條指向不存在卡片的連結——送出必然被擋，而畫面上看不出為什麼。
    繼承來的連結一律由伺服器在渲染時提供，那份一定是當下有效的。

    關掉的欄位（typefields.js 依型別 disable）也不存：它們的值是換型別之前的殘留。
  */
  function fields(form) {
    return Array.prototype.filter.call(
      form.querySelectorAll('input[type=text], input[type=url], textarea'),
      function (el) {
        return el.name && !el.disabled && !el.closest('#linksfield');
      },
    );
  }

  function snapshot(form) {
    var out = {};
    fields(form).forEach(function (el) { out[el.name] = el.value; });
    return out;
  }

  function blank(f) {
    return Object.keys(f).every(function (k) { return f[k].trim() === ''; });
  }

  function same(a, b) {
    var ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every(function (k) { return a[k] === b[k]; });
  }

  function save(form, scope) {
    var f = snapshot(form);
    // 全空就是沒有草稿。留一個空殼只會佔掉一格淘汰名額。
    if (blank(f)) { drop(PREFIX + scope); return; }
    write(PREFIX + scope, JSON.stringify({ v: 1, savedAt: Date.now(), fields: f }));
  }

  function fill(form, f) {
    fields(form).forEach(function (el) {
      if (typeof f[el.name] !== 'string') return;
      el.value = f[el.name];
      // 內容是程式改的，聽 input 的那幾支（隨手記的「將存為什麼」、標籤推薦）
      // 要自己收到通知，否則畫面上的判斷停在還原之前。
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  // ---------------------------------------------------------------- 提示列

  function ago(at) {
    var mins = Math.floor((Date.now() - at) / 60000);
    if (mins < 1) return '剛剛';
    if (mins < 60) return mins + ' 分鐘前';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' 小時前';
    return Math.floor(hours / 24) + ' 天前';
  }

  /*
    伺服器已經填了東西進來的表單，草稿直接自動還原，並在表單頂端提供「已自動還原草稿 [清除]」提示列。
    使用者若想捨棄草稿、回復伺服器初始預填內容，可點擊「清除草稿」。
  */
  function notifyAutoRestored(form, scope, d, onDiscard) {
    var bar = document.createElement('p');
    bar.className = 'draftnote';

    var text = document.createElement('span');
    text.textContent = '已自動還原草稿（' + ago(d.savedAt) + '）';
    bar.appendChild(text);

    var discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'textbtn';
    discard.textContent = '清除草稿';
    discard.addEventListener('click', function () {
      if (onDiscard) onDiscard();
      bar.remove();
    });
    bar.appendChild(discard);

    form.insertBefore(bar, form.firstChild);
  }

  // ---------------------------------------------------------------- 清掃

  function sweep() {
    var now = Date.now();
    var live = [];
    ourKeys().forEach(function (k) {
      var at = 0;
      try { at = (JSON.parse(read(k)) || {}).savedAt || 0; } catch (e) { drop(k); return; }
      if (!at || now - at > MAX_AGE) { drop(k); return; }
      live.push({ k: k, at: at });
    });
    // 分槽的代價是槽會愈開愈多——每一張卡片頁的 ＋ 都是一格。
    // 沒有上限的話 localStorage 會慢慢被再也不會回去的草稿佔滿。
    live.sort(function (a, b) { return b.at - a.at; });
    live.slice(MAX_KEEP).forEach(function (x) { drop(x.k); });
  }

  /*
    建立成功之後的清除。

    表單送出走 302，伺服器把槽名掛在導向網址的 ?d= 上——**驗證失敗不會走到這裡**，
    所以「400 退回時草稿還在」是這個設計自動得到的，不是另外一條規則。

    清完就把 ?d= 從網址裡拿掉：留著會在重新整理與分享連結時造成困惑。
  */
  function clearFromUrl() {
    var m = /[?&]d=([^&]*)/.exec(window.location.search);
    if (!m) return;
    try { drop(PREFIX + decodeURIComponent(m[1])); } catch (e) { /* 壞的百分比編碼，忽略 */ }
    try {
      var url = new URL(window.location.href);
      url.searchParams.delete('d');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) { /* 不支援就讓網址留著，功能不受影響 */ }
  }

  // ---------------------------------------------------------------- 掛上去

  clearFromUrl();
  sweep();

  Array.prototype.forEach.call(document.querySelectorAll('form[data-draft-scope]'), function (form) {
    var scope = form.dataset.draftScope;
    if (!scope) return;

    // 隨手記按了「展開」：那一格的內容已經在這張表單裡了，留著是重複的。
    if (form.dataset.draftClear) drop(PREFIX + form.dataset.draftClear);

    var dirty = false;
    var timer = null;
    var restoring = false;

    var d = load(scope);
    if (d) {
      if (form.dataset.draftPrefilled === undefined) {
        fill(form, d.fields);
      } else if (!same(d.fields, snapshot(form))) {
        // 伺服器有預填但與草稿不同：記錄初始狀態後自動還原，並顯示提示列供回復
        var initial = snapshot(form);
        fill(form, d.fields);
        notifyAutoRestored(form, scope, d, function () {
          restoring = true;
          try {
            drop(PREFIX + scope);
            fill(form, initial);
            clearTimeout(timer);
            timer = null;
            dirty = false;
          } finally {
            restoring = false;
          }
        });
      }
    }

    form.addEventListener('input', function () {
      if (restoring) return;
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(function () { save(form, scope); }, DEBOUNCE);
    });

    // debounce 還沒到就被切走或關掉的話，那 400ms 的字就沒了。
    // 只有在表單有實際修改（dirty）或有待存 debounce（timer）時才 flush，
    // 避免未更動表單在退出時意外覆寫或清除儲存區的草稿。
    var flush = function () {
      if (!dirty && !timer) return;
      clearTimeout(timer);
      timer = null;
      save(form, scope);
    };
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
  });
})();
