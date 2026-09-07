// 把卡片內文複製到剪貼簿。
//
// 複製的是**原始 Markdown**，不是畫面上那份 HTML——渲染是單向的，
// 從 HTML 反解析回來拿不回原本的記號選擇。原文由伺服器印在 .body[data-md]
// 上（見 routes.ts 的 body_md），這裡直接讀那個屬性。
//
// 沒有這支腳本按鈕根本不會出現（見 card.css 的 html:not(.js)），
// 所以這裡不做「找不到就降級」的分支——找不到就是這一頁沒有內文。

(function () {
  var btn = document.getElementById('copybtn');
  var body = document.querySelector('.body[data-md]') || document.querySelector('.body');
  if (!btn || !body) return;

  var md = body.dataset.md || '';
  var back = null;

  function said() {
    btn.classList.add('done');
    clearTimeout(back);
    // 回饋留 1.2 秒：夠久到看得見，短到不會讓人以為按鈕壞在那個狀態。
    back = setTimeout(function () { btn.classList.remove('done'); }, 1200);
  }

  // navigator.clipboard 只在安全脈絡（https 或 localhost）下存在。
  // 這個站在區網裡用純 http 開的時候整個 API 都不在，所以留一條舊路——
  // execCommand 已經廢棄，但它是這個情境唯一還能動的東西。
  function legacy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    // 不能用 display:none 或 hidden：看不見的元素選不起來，也就複製不了。
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  btn.addEventListener('click', function () {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(md).then(said, function () {
        if (legacy(md)) said();
      });
      return;
    }
    if (legacy(md)) said();
  });
})();
