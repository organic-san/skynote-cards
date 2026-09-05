// 欄位隨內容長高，到頂之後改成內部捲動。
//
// 掛在 textarea[data-grow] 上，不認得任何一張表單——建立頁與編輯頁都要，
// 而它跟兩者的其他行為沒有關係。上限由 CSS 的 --grow-max 給：
// 貼一篇長文進來時欄位若無限長高，底下的標籤與連結會被推到幾千像素之外，
// 整份表單就沒辦法調整了。
//
// 程式改了內容之後想讓它重算，就在那個 textarea 上 dispatch 一次 'input'。

(function () {
  Array.prototype.forEach.call(document.querySelectorAll('textarea[data-grow]'), function (el) {
    // 使用者一旦自己拖過高度，就別再自動改它——那是他明確表達過的偏好。
    var grown = null;

    function grow() {
      if (grown !== null && Math.abs(el.offsetHeight - grown) > 1) return;
      el.style.height = 'auto';
      var raw = getComputedStyle(el).getPropertyValue('--grow-max');
      var max = parseInt(raw, 10);
      if (raw.indexOf('vh') > -1) max = (window.innerHeight * max) / 100;
      var want = el.scrollHeight;
      el.style.height = (isNaN(max) ? want : Math.min(want, max)) + 'px';
      el.style.overflowY = !isNaN(max) && want > max ? 'auto' : 'hidden';
      grown = el.offsetHeight;
    }

    el.addEventListener('input', grow);
    grow();
  });
})();
