"""
PikPak 免登录分享下载器（已实测验证 2026-09-18）

匿名完整链路（无需账号）:
  1. POST user.mypikpak.com/v1/shield/captcha/init  → captcha_token (本地签名, 见 captcha_sign)
  2. GET  api-drive.mypikpak.com/drive/v1/share     → pass_code_token + 分享根目录
  3. GET  /drive/v1/share/detail?parent_id=...      → 遍历文件夹 (分页: next_page_token)
  4. GET  /drive/v1/share/file_info?file_id=...     → medias[].link.url 即预签名下载直链
     - category=original 的 media 是原始文件 (f 参数 = 文件字节数)
     - category=transcoded 的是转码流 (低分辨率预览)
     - 直链含 expire (约 38h) / sign / pr, userid 为空 = 匿名签发
     - 直链支持 HTTP Range (206), 可多线程/断点续传

注意:
  - captcha_sign 的 SALTS 来自客户端, 版本更新可能失效 (失效表现为 captcha/init 返回错误)
  - X-Device-Id 必填, 否则 400 "device_id is empty"
  - captcha_token 有效期 300s, 过期重新 init
"""

import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from uuid import uuid4

API = "https://api-drive.mypikpak.com"
USER = "https://user.mypikpak.com"

CLIENT_ID = "YNxT9w7GMdWvEOKa"
CLIENT_VERSION = "1.47.1"
PACKAGE_NAME = "com.pikcloud.pikpak"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")

# 客户端内置 salt, 用于 captcha_sign (pikpakapi/Quan666 项目逆向所得)
SALTS = [
    "Gez0T9ijiI9WCeTsKSg3SMlx", "zQdbalsolyb1R/", "ftOjr52zt51JD68C3s",
    "yeOBMH0JkbQdEFNNwQ0RI9T3wU/v", "BRJrQZiTQ65WtMvwO", "je8fqxKPdQVJiy1DM6Bc9Nb1",
    "niV", "9hFCW2R1", "sHKHpe2i96", "p7c5E6AcXQ/IJUuAEC9W6", "",
    "aRv9hjc9P+Pbn+u3krN6", "BzStcgE8qVdqjEH16l4", "SqgeZvL5j9zoHP95xWHt",
    "zVof5yaJkPe3VFpadPof",
]


def captcha_sign(device_id: str, timestamp: str) -> str:
    sign = CLIENT_ID + CLIENT_VERSION + PACKAGE_NAME + device_id + timestamp
    for salt in SALTS:
        sign = hashlib.md5((sign + salt).encode()).hexdigest()
    return "1." + sign


class PikPakShare:
    def __init__(self):
        self.device_id = uuid4().hex
        self.ctx = __import__("ssl").create_default_context()
        self._captcha_cache = {}  # action -> (token, expire_at)

    def _http(self, method, url, headers, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            resp = urllib.request.urlopen(req, timeout=30, context=self.ctx)
            return resp.status, resp.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "ignore")

    def _headers(self, captcha_token=None, content_type=None):
        h = {"User-Agent": UA, "X-Device-Id": self.device_id,
             "X-Client-Id": CLIENT_ID}
        if captcha_token:
            h["X-Captcha-Token"] = captcha_token
        if content_type:
            h["Content-Type"] = content_type
        return h

    def captcha_token(self, action: str) -> str:
        """action 形如 'GET:/drive/v1/share'。缓存 300s 内复用。"""
        hit = self._captcha_cache.get(action)
        if hit and hit[1] > time.time():
            return hit[0]
        ts = str(int(time.time() * 1000))
        body = {
            "client_id": CLIENT_ID, "action": action, "device_id": self.device_id,
            "meta": {"captcha_sign": captcha_sign(self.device_id, ts),
                     "client_version": CLIENT_VERSION, "package_name": PACKAGE_NAME,
                     "user_id": "", "timestamp": ts},
        }
        code, body_text = self._http(
            "POST", USER + "/v1/shield/captcha/init",
            self._headers(content_type="application/json; charset=utf-8"), body)
        if code != 200:
            raise RuntimeError(f"captcha/init {code}: {body_text[:200]}")
        token = json.loads(body_text)["captcha_token"]
        self._captcha_cache[action] = (token, time.time() + 280)
        return token

    def _get(self, path, params, captcha_action):
        url = API + path + "?" + urllib.parse.urlencode(params)
        code, text = self._http("GET", url, self._headers(self.captcha_token(captcha_action)))
        if code != 200:
            raise RuntimeError(f"{path} {code}: {text[:300]}")
        return json.loads(text)

    @staticmethod
    def parse_share_url(url: str):
        """返回 (share_id, parent_id|None)。第二段是目录 id, 不是提取码。"""
        import re
        m = re.search(r"/s/([^/]+)(?:/([^/?#]+))?", url)
        if not m:
            raise ValueError(f"不是有效的分享链接: {url}")
        return m.group(1), m.group(2)

    def share_info(self, share_id, pass_code=""):
        params = {"share_id": share_id, "thumbnail_size": "SIZE_LARGE",
                  "limit": "100", "order": "3"}
        if pass_code:
            params["pass_code"] = pass_code
        return self._get("/drive/v1/share", params, "GET:/drive/v1/share")

    def list_folder(self, share_id, pass_code_token, parent_id="", _fallback_ok=True):
        params = {"share_id": share_id, "pass_code_token": pass_code_token,
                  "limit": "100", "thumbnail_size": "SIZE_LARGE", "order": "6"}
        if parent_id:
            params["parent_id"] = parent_id
        try:
            files, page_token = [], ""
            while True:
                if page_token:
                    params["page_token"] = page_token
                j = self._get("/drive/v1/share/detail", params, "GET:/drive/v1/share/detail")
                files.extend(j.get("files") or [])
                page_token = j.get("next_page_token") or ""
                if not page_token:
                    return files
        except RuntimeError as e:
            # 分享链接里的 parent_id 可能是过期的目录 id, 回退到根目录
            if _fallback_ok and parent_id and "file_not_found" in str(e):
                return self.list_folder(share_id, pass_code_token, "", _fallback_ok=False)
            raise

    def file_info(self, share_id, pass_code_token, file_id):
        j = self._get("/drive/v1/share/file_info",
                      {"share_id": share_id, "pass_code_token": pass_code_token,
                       "file_id": file_id},
                      "GET:/drive/v1/share/file_info")
        return j.get("file_info") or {}

    def original_url(self, share_id, pass_code_token, file_id):
        """返回 (原始文件直链, 文件信息)。原始文件取 category=original。"""
        info = self.file_info(share_id, pass_code_token, file_id)
        for m in info.get("medias") or []:
            url = (m.get("link") or {}).get("url")
            if url and "category=original" in url:
                return url, info
        # 没有转码过的文件只有 original 一条, 或 fallback 到第一条
        for m in info.get("medias") or []:
            url = (m.get("link") or {}).get("url")
            if url:
                return url, info
        raise RuntimeError(f"文件无可用直链: {info.get('name')} (web_content_link 为空, "
                           f"可能非视频或需要登录)")

    def walk(self, share_id, pass_code_token, parent_id="", path=""):
        """深度遍历, 产出 (相对路径, file_info_dict)。"""
        for f in self.list_folder(share_id, pass_code_token, parent_id):
            p = f"{path}/{f['name']}"
            if f.get("kind") == "drive#folder":
                yield from self.walk(share_id, pass_code_token, f["id"], p)
            else:
                yield p, f


def main():
    import sys
    link = sys.argv[1] if len(sys.argv) > 1 else ""
    if not link:
        sys.exit("用法: python pikpak_anon.py <分享链接>")
    share_id, parent_id = PikPakShare.parse_share_url(link)
    api = PikPakShare()

    info = api.share_info(share_id)
    if info.get("share_status") != "OK":
        sys.exit(f"分享不可用: {info.get('share_status')}")
    pct = info["pass_code_token"]
    print(f"分享: {info.get('title')}  (匿名 OK)")
    # URL 第二段的 parent_id 与实际根目录 id 不一致时, 从根开始遍历
    root = (info.get("files") or [{}])[0].get("id", "")

    count = 0
    for path, f in api.walk(share_id, pct, parent_id or root):
        count += 1
        if count > 50:
            print("...(截断, 仅演示前 50 项)")
            break
        if f.get("kind") == "drive#folder":
            continue
        try:
            url, fi = api.original_url(share_id, pct, f["id"])
            size_mb = int(f.get("size") or 0) / 1048576
            print(f"{path}  [{size_mb:.1f} MB]")
            print(f"  {url[:120]}...")
        except RuntimeError as e:
            print(f"{path}  [取链失败: {e}]")
    print(f"共 {count} 项")


if __name__ == "__main__":
    main()
