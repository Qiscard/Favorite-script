// 用 Node 验证 userscript 中 md5/captchaSign 的移植是否正确, 并端到端跑通匿名链路
const fs = require('fs');
const path = require('path');
// 脚本本体位于上级目录（ScriptCat/网盘链接选中识别 同级的 PikPak分享下载助手.user.js）
const src = fs.readFileSync(path.join(__dirname, '..', 'PikPak分享下载助手.user.js'), 'utf8');

// 提取 md5 与 captchaSign 函数源码并求值
function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error('not found: ' + name);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) { i = j + 1; break; } }
  }
  return src.slice(start, i);
}
const md5 = eval('(' + grab('md5') + ')');

// md5 正确性: 与 node crypto 对拍（含 utf8、长串），并核对两个公开标准向量
const crypto = require('crypto');
const cases = ['', 'abc', '你好世界 PikPak 分享下载助手', 'a'.repeat(1000), 'x'.repeat(55), 'y'.repeat(56)];
let bad = 0;
for (const inp of cases) {
  const want = crypto.createHash('md5').update(inp, 'utf8').digest('hex');
  const got = md5(inp);
  if (got !== want) { console.log('MD5 MISMATCH', JSON.stringify(inp.slice(0, 20)), got, want); bad++; }
}
if (md5('') !== 'd41d8cd98f00b204e9800998ecf8427e' || md5('abc') !== '900150983cd24fb0d6963f7d28e17f72') {
  console.log('MD5 standard vectors FAILED'); bad++;
}
console.log(bad === 0 ? 'MD5 OK (' + cases.length + ' cases + 2 standard vectors)' : 'MD5 FAILED');

// captchaSign 移植（当前脚本签名为 captchaSign(profile, timestamp)，deviceId 在闭包中）
const PROFILE = {
  clientId: 'YNxT9w7GMdWvEOKa',
  clientVersion: '1.47.1',
  packageName: 'com.pikcloud.pikpak',
  salts: ['Gez0T9ijiI9WCeTsKSg3SMlx','zQdbalsolyb1R/','ftOjr52zt51JD68C3s','yeOBMH0JkbQdEFNNwQ0RI9T3wU/v','BRJrQZiTQ65WtMvwO','je8fqxKPdQVJiy1DM6Bc9Nb1','niV','9hFCW2R1','sHKHpe2i96','p7c5E6AcXQ/IJUuAEC9W6','','aRv9hjc9P+Pbn+u3krN6','BzStcgE8qVdqjEH16l4','SqgeZvL5j9zoHP95xWHt','zVof5yaJkPe3VFpadPof'],
};
const CLIENT_ID = PROFILE.clientId, CLIENT_VERSION = PROFILE.clientVersion, PACKAGE_NAME = PROFILE.packageName;
const DEV = 'a'.repeat(32), TS = '1758000000000';
const captchaSign = eval('(function(deviceId){ return ' + grab('captchaSign') + '; })')(DEV);
// 与 Python 版对拍
let py = PROFILE.clientId + PROFILE.clientVersion + PROFILE.packageName + DEV + TS;
for (const s of PROFILE.salts) py = crypto.createHash('md5').update(py + s).digest('hex');
const js = captchaSign(PROFILE, TS);
console.log(js === '1.' + py ? 'captchaSign OK (matches node-crypto)' : 'captchaSign MISMATCH: ' + js + ' vs 1.' + py);

// sanitize：非法字符/控制字符/Windows 保留名/尾部点
const sanitize = eval('(' + grab('sanitize') + ')');
{
  const cases = [
    ['movie: "final" <cut>.mkv', 'movie_ _final_ _cut_.mkv'],   // 非法字符替换
    ['bad\x01\x02name.mp4', 'badname.mp4'],                      // 控制字符删除
    ['folder.', 'folder'],                                       // 尾部点
    ['CON', '_CON'],                                             // Windows 保留名
    ['nul.txt', '_nul.txt'],
    ['com1', '_com1'],
    ['normal file.mp4', 'normal file.mp4'],                      // 正常不变
  ];
  let sBad = 0;
  for (const [input, want] of cases) {
    const got = sanitize(input);
    if (got !== want) { console.log('SANITIZE MISMATCH', JSON.stringify(input), 'got', JSON.stringify(got), 'want', JSON.stringify(want)); sBad++; }
  }
  if (sanitize('') !== 'untitled') { console.log('SANITIZE empty FAILED'); sBad++; }
  console.log(sBad === 0 ? 'sanitize OK (' + cases.length + ' cases + empty)' : 'sanitize FAILED');
}

// extAllowed：扩展名过滤（含点前缀、大小写、空串全通过）
const extAllowed = eval('(' + grab('extAllowed') + ')');
{
  let eBad = 0;
  const expect = (name, filter, want, tag) => {
    if (extAllowed(name, filter) !== want) { console.log('EXTALLOWED MISMATCH', tag, name, filter); eBad++; }
  };
  expect('a.mkv', 'mkv,mp4', true, 'plain');
  expect('b.MP4', 'mkv,mp4', true, 'case-insensitive');
  expect('c.avi', '.mkv, .mp4', false, 'dot-prefix filter');
  expect('d.mkv', '.mkv, .mp4', true, 'dot-prefix match');
  expect('e.txt', 'mkv,mp4', false, 'not listed');
  expect('anything', '  ', true, 'empty filter passes all');
  expect('noext', 'mkv', false, 'no extension');
  console.log(eBad === 0 ? 'extAllowed OK (7 cases)' : 'extAllowed FAILED');
}

// 端到端: 用 JS 签名走完整匿名链路（可选：RUN_PIKPAK_E2E=1 node _test_userscript_core.js）
if (process.env.RUN_PIKPAK_E2E !== '1') {
  console.log('E2E SKIPPED (set RUN_PIKPAK_E2E=1 to enable network test)');
} else (async () => {
  const dev = crypto.randomUUID().replace(/-/g, '');
  const ts = String(Date.now());
  const body = { client_id: CLIENT_ID, action: 'GET:/drive/v1/share', device_id: dev,
    meta: { captcha_sign: captchaSign(PROFILE, ts), client_version: CLIENT_VERSION, package_name: PACKAGE_NAME, user_id: '', timestamp: ts } };
  const r1 = await fetch('https://user.mypikpak.com/v1/shield/captcha/init', { method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Device-Id': dev, 'X-Client-Id': CLIENT_ID }, body: JSON.stringify(body) });
  const j1 = await r1.json();
  if (!j1.captcha_token) return console.log('captcha/init FAIL', r1.status, JSON.stringify(j1).slice(0, 200));
  console.log('captcha/init OK (JS md5 signature accepted)');

  const shareId = 'VNLySlyJpr1J-y7W15G4N6xXo1';
  const r2 = await fetch(`https://api-drive.mypikpak.com/drive/v1/share?share_id=${shareId}&thumbnail_size=SIZE_LARGE&limit=100&order=3`,
    { headers: { 'X-Device-Id': dev, 'X-Client-Id': CLIENT_ID, 'X-Captcha-Token': j1.captcha_token } });
  const j2 = await r2.json();
  console.log('share OK:', j2.share_status, '-', j2.title);
  const pct = j2.pass_code_token, root = j2.files[0].id;

  const r3 = await fetch(`https://api-drive.mypikpak.com/drive/v1/share/detail?share_id=${shareId}&pass_code_token=${encodeURIComponent(pct)}&parent_id=${root}&limit=100&thumbnail_size=SIZE_LARGE&order=6`,
    { headers: { 'X-Device-Id': dev, 'X-Client-Id': CLIENT_ID, 'X-Captcha-Token': j1.captcha_token } });
  const j3 = await r3.json();
  console.log('detail OK:', (j3.files || []).length, 'items');
  const folder = (j3.files || []).find((f) => f.kind === 'drive#folder');
  const r4 = await fetch(`https://api-drive.mypikpak.com/drive/v1/share/detail?share_id=${shareId}&pass_code_token=${encodeURIComponent(pct)}&parent_id=${folder.id}&limit=100&thumbnail_size=SIZE_LARGE&order=6`,
    { headers: { 'X-Device-Id': dev, 'X-Client-Id': CLIENT_ID, 'X-Captcha-Token': j1.captcha_token } });
  const j4 = await r4.json();
  const file = (j4.files || []).find((f) => f.kind !== 'drive#folder');
  if (!file) return console.log('no file found at depth 2 (fine, share structure varies)');
  const r5 = await fetch(`https://api-drive.mypikpak.com/drive/v1/share/file_info?share_id=${shareId}&pass_code_token=${encodeURIComponent(pct)}&file_id=${file.id}`,
    { headers: { 'X-Device-Id': dev, 'X-Client-Id': CLIENT_ID, 'X-Captcha-Token': j1.captcha_token } });
  const j5 = await r5.json();
  const medias = (j5.file_info?.medias) || [];
  const orig = medias.find((m) => m.link?.url?.includes('category=original'));
  console.log('file_info OK:', file.name, '| original url:', orig ? 'YES' : 'NO');
  if (orig) {
    const r6 = await fetch(orig.link.url, { headers: { Range: 'bytes=0-63' } });
    const buf = Buffer.from(await r6.arrayBuffer());
    console.log('download OK: HTTP', r6.status, '| content-range:', r6.headers.get('content-range'), '| head:', buf.slice(0, 8).toString('hex'));
  }
})().catch((e) => console.log('E2E ERR', e.message));
