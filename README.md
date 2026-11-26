# chang.fit 身體評估網站

網址：https://isaac910423-rgb.github.io/changfit/

- `index.html`：網站本體（由 claude.ai 設計畫布的 `Main.dc.html` 轉出）
- `dc-lite.js`：讓畫布頁面在一般網站執行的小型執行環境；`morphdom-umd.min.js`（MIT）負責畫面更新
- `assets/`：影片、封面、分析程式庫 `00defff3….js`（isaac-pose，動作測試角度分析）、TF.js 4.22（Apache-2.0）、MoveNet Thunder 模型（Apache-2.0，以 base64 JSON 存放）
- `tools/build.py`：轉檔腳本 `python3 tools/build.py Main.dc.html <素材資料夾> <輸出資料夾>`

影片只在學員自己的瀏覽器裡分析，不會上傳。
