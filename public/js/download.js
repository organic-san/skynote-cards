// 把卡片存成 .md 檔（v3 §6.1）。把內容交給 AI 發想時，直接給檔案比貼上剪貼簿方便。
//
// 內容是 `# 標題`、一個空行、內文；碎片沒有標題，只有它那段話。
// 原文跟複製鈕讀同一個地方（.body[data-md]），標題由伺服器另外印在 data-title 上，
// 不從畫面上的 <h1> 反解析。按下去的當下才讀：勾選之後 data-md 會被換掉（js/tasks.js）。
//
// 檔名由伺服器印在按鈕上（標題，碎片用 ID）。檔名不允許的字元交給瀏覽器替換——
// 它本來就會換，改用 ID 反而丟掉看得懂的名字。
//
// 沒有這支腳本按鈕根本不會出現（見 card.css 的 html:not(.js)）。

(function () {
  var btn = document.getElementById('dlbtn');
  var body = document.querySelector('.body[data-md]');
  if (!btn || !body) return;

  btn.addEventListener('click', function () {
    var md = body.dataset.md || '';
    var title = body.dataset.title;
    var text = title ? '# ' + title + '\n\n' + md + '\n' : md + '\n';

    var url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = btn.dataset.file || 'card.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 下載已經交給瀏覽器了；馬上撤銷在某些瀏覽器會讓下載落空，所以晚一拍。
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
})();
