# -*- coding: utf-8 -*-
"""
PikPak web 端分享 API 实测脚本（无需客户端，无需登录）
原理：
  1. 生成随机 UUID 作为 device_id（web 端 localStorage.deviceid 尾段）
  2. 用前端泄露的 client_id + 10 个 md5 盐迭代哈希生成 captcha_sign（xbase SDK 逻辑）
  3. POST /drive/v1/shield/captcha/init 拿 captcha_token
  4. GET /drive/v1/share?share_id=...&pass_code_token=... 列目录
  5. GET /drive/v1/share/file_info?file_id=... 拿 web_content_link（直链）
"""
import hashlib
import json
import time
import uuid
import urllib.request

CLIENT_ID = "YUMx5nI8ZU8Ap8pm"
CLIENT_VERSION = "undefined"
PACKAGE_NAME = "drive.mypikpak.com"
TIMESTAMP = "1789559265611"  # web 包内置固定值
SALTS = [
    "fyZ4+p77W1U4zcWBUwefAIFhFxvADWtT1wzolCxhg9q7etmGUjXr",
    "uSUX02HYJ1IkyLdhINEFcCf7l2",
    "iWt97bqD/qvjIaPXB2Ja5rsBWtQtBZZmaHH2rMR41",
    "3binT1s/5a1pu3fGsN",
    "8YCCU+AIr7pg+yd7CkQEY16lDMwi8Rh4WNp5",
    "DYS3StqnAEKdGddRP8CJrxUSFh",
    "crquW+4",
    "ryKqvW9B9hly+JAymXCIfag5Z",
    "Hr08T/NDTX1oSJfHk90c",
    "i",
]
DRIVE_API = "https://api-drive.mypikpak.com"
# 用法: python pikpak_share_probe.py <share_id> [pass_code_token]
# 不再内置真实分享数据（share_id 可从分享页 SSR 数据提取）
import sys

SHARE_ID = sys.argv[1] if len(sys.argv) > 1 else ""
PASS_CODE_TOKEN = sys.argv[2] if len(sys.argv) > 2 else ""

DEVICE_ID = str(uuid.uuid4()).replace("-", "")[:32]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"


def calc_captcha_sign(salts, seed):
    cur = seed
    for s in salts:
        cur = hashlib.md5((cur + s).encode()).hexdigest()
    return "1." + cur


def http_json(url, body=None, method="GET", extra_headers=None):
    headers = {
        "User-Agent": UA,
        "Accept": "application/json",
        "x-device-id": DEVICE_ID,
        "x-client-id": CLIENT_ID,
        "x-client-version": CLIENT_VERSION,
        "x-package-name": PACKAGE_NAME,
        "x-protocol-version": "301",
    }
    if extra_headers:
        headers.update(extra_headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json;charset=UTF-8"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def get_captcha_token(action):
    seed = CLIENT_ID + CLIENT_VERSION + PACKAGE_NAME + DEVICE_ID + TIMESTAMP
    sign = calc_captcha_sign(SALTS, seed)
    return http_json(
        f"{DRIVE_API}/drive/v1/shield/captcha/init",
        body={
            "client_id": CLIENT_ID,
            "action": action,
            "device_id": DEVICE_ID,
            "meta": {
                "captcha_sign": sign,
                "client_version": CLIENT_VERSION,
                "package_name": PACKAGE_NAME,
                "user_id": "",
                "timestamp": TIMESTAMP,
            },
        },
        method="POST",
    )


def main():
    if not SHARE_ID:
        print("用法: python pikpak_share_probe.py <share_id> [pass_code_token]")
        return
    print("device_id =", DEVICE_ID)
    init = get_captcha_token("GET:/drive/v1/share")
    print("captcha/init keys:", {k: (str(v)[:40]) for k, v in init.items()})
    token = init.get("captcha_token")
    if not token:
        print(json.dumps(init, ensure_ascii=False, indent=2)[:2000])
        return
    print("captcha_token OK:", token[:50], "...")

    hdr = {"x-captcha-token": token}
    # 1) 分享根目录列表
    qs = f"share_id={SHARE_ID}&pass_code_token={urllib.request.quote(PASS_CODE_TOKEN)}&parent_id=&limit=100&thumbnail_size=SIZE_LARGE&with_audit=web&banner_list_enable=false"
    listing = http_json(f"{DRIVE_API}/drive/v1/share?{qs}", extra_headers=hdr)
    print("\n=== /drive/v1/share ===")
    print("share_status:", listing.get("share_status"), "| title:", listing.get("title"))
    for f in listing.get("files", []):
        print(f"  [{f.get('kind','?')}] {f['id']}  {f.get('name')}  size={f.get('size')}")

    # 2) 进入第一个子目录
    files = listing.get("files", [])
    if files and files[0].get("kind") == "drive#folder":
        pid = files[0]["id"]
        qs2 = f"share_id={SHARE_ID}&pass_code_token={urllib.request.quote(PASS_CODE_TOKEN)}&parent_id={pid}&limit=100&thumbnail_size=SIZE_LARGE&with_audit=web"
        sub = http_json(f"{DRIVE_API}/drive/v1/share?{qs2}", extra_headers=hdr)
        print(f"\n=== 子目录 {files[0].get('name')} ===")
        for f in sub.get("files", [])[:20]:
            print(f"  [{f.get('kind','?')}] {f['id']}  {f.get('name')}  size={f.get('size')}")

        # 3) 找一个具体文件取下载直链
        afile = next((f for f in sub.get("files", []) if f.get("kind") == "drive#file"), None)
        if afile:
            info = http_json(
                f"{DRIVE_API}/drive/v1/share/file_info?share_id={SHARE_ID}&pass_code_token={urllib.request.quote(PASS_CODE_TOKEN)}&file_id={afile['id']}",
                extra_headers=hdr,
            )
            print("\n=== /drive/v1/share/file_info ===")
            print(json.dumps(info, ensure_ascii=False, indent=1)[:1500])
            link = info.get("web_content_link") or (info.get("medias") or [{}])[0].get("link", {}).get("url")
            if link:
                print("\n>>> 下载直链:", link[:160])
                req = urllib.request.Request(link, method="HEAD", headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=30) as r:
                    print(">>> 直链 HEAD 校验:", r.status, "| Content-Length:", r.headers.get("Content-Length"), "| Content-Type:", r.headers.get("Content-Type"))


if __name__ == "__main__":
    main()
