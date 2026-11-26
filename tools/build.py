"""把設計畫布的 Main.dc.html 轉成可以放在 GitHub Pages 的一般網站。
用法: python3 build.py <Main.dc.html> <素材資料夾 blobs/> <輸出資料夾>
"""
import json, os, re, shutil, sys

src, blobs, out = sys.argv[1], sys.argv[2], sys.argv[3]
here = os.path.dirname(os.path.abspath(__file__))
s = open(src, encoding='utf-8').read()

title = re.search(r'<title>(.*?)</title>', s, re.S).group(1).strip()
xdc = re.search(r'<x-dc>(.*)</x-dc>', s, re.S).group(1)
helmet = re.search(r'<helmet>(.*?)</helmet>', xdc, re.S)
head_extra = helmet.group(1).strip() if helmet else ''
body_tpl = xdc.replace(helmet.group(0), '') if helmet else xdc
m = re.search(r"<script type=\"text/x-dc\" data-dc-script data-props='(.*?)'>(.*?)</script>", s, re.S)
props_json = m.group(1).replace('&#39;', "'").replace('&amp;', '&')
logic = m.group(2)
defaults = {k: v.get('default') for k, v in json.loads(props_json).items() if not k.startswith('$') and isinstance(v, dict) and 'default' in v}

# 素材：/_blob/<id> → assets/<id>.<副檔名>
os.makedirs(os.path.join(out, 'assets'), exist_ok=True)
files = {f.split('.')[0]: f for f in os.listdir(blobs)}
used = set()
def blob(mm):
    i = mm.group(1)
    if i not in files:
        raise SystemExit(f'缺少素材 {i}')
    used.add(files[i])
    return 'assets/' + files[i]
body_tpl = re.sub(r'/_blob/([0-9a-f]{32})', blob, body_tpl)
logic = re.sub(r'/_blob/([0-9a-f]{32})', blob, logic)
head_scripts = re.findall(r'<script src="/_blob/([0-9a-f]{32})"></script>', s)
script_tags = '\n'.join(f'<script src="assets/{files[i]}"></script>' for i in head_scripts)
used.update(files[i] for i in head_scripts)
for f in used:
    shutil.copy(os.path.join(blobs, f), os.path.join(out, 'assets', f))
shutil.copy(os.path.join(here, 'dc-lite.js'), os.path.join(out, 'dc-lite.js'))
shutil.copy(os.path.join(here, 'morphdom-umd.min.js'), os.path.join(out, 'morphdom-umd.min.js'))

html = f"""<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="chang.fit 身體翻譯員：線上身體評估、動作測試自動角度分析、矯正運動動作庫。">
<meta property="og:title" content="{title}">
<meta name="theme-color" content="#6B1E2A">
{head_extra}
{script_tags}
<script src="morphdom-umd.min.js"></script>
<script src="dc-lite.js"></script>
</head>
<body>
<div id="app"></div>
<template id="dc-template">{body_tpl}</template>
<script>
{logic}
DCLite.mount(Component, {json.dumps(defaults, ensure_ascii=False)});
</script>
</body>
</html>
"""
open(os.path.join(out, 'index.html'), 'w', encoding='utf-8').write(html)
open(os.path.join(out, '.nojekyll'), 'w').write('')
print('index.html', len(html), 'bytes;', len(used), 'assets')
