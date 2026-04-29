import re
import random
import time
import json
import sys
from patchright.sync_api import Playwright, sync_playwright
from playwright_stealth import Stealth

def random_delay(min_ms: int = 500, max_ms: int = 1000) -> None:
    """随机延迟，默认 500ms ~ 1s"""
    delay = random.uniform(min_ms / 1000, max_ms / 1000)
    time.sleep(delay)

def extract_url_from_bg(bg_style: str) -> str:
    """从 background-image 样式中提取 URL"""
    match = re.search(r'url\(["\']?(.*?)["\']?\)', bg_style)
    return match.group(1) if match else ""

def parse_cookie_string(cookie_str: str) -> list:
    """将分号分隔的 Cookie 字符串解析为 Playwright 所需的 cookie 对象列表"""
    cookies = []
    for item in cookie_str.split(';'):
        item = item.strip()
        if not item:
            continue
        if '=' in item:
            name, value = item.split('=', 1)
            cookies.append({
                'name': name.strip(),
                'value': value.strip(),
                'domain': '.jd.com',
                'path': '/',
            })
    return cookies

def run(playwright: Playwright, params: dict) -> dict:
    """
    爬取京东商品图片

    入参:
        {"cookie_string": "...", "url": "..."}

    出参:
        {"main_img_src": [...], "detail_url": [...]}
    """
    # 收集结果的列表
    main_img_src_list = []
    detail_url_list = []
    browser = playwright.chromium.launch(headless=True, args=['--disable-blink-features=AutomationControlled'])
    context = browser.new_context(
        viewport={'width': 1920, 'height': 1080},
        user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
        locale='zh-CN',
        timezone_id='Asia/Shanghai',
    )
    # ---------- 设置 Cookie（从入参获取） ----------
    cookie_string = params.get("cookie_string", "")
    if cookie_string:
        cookies = parse_cookie_string(cookie_string)
        context.add_cookies(cookies)

    page = context.new_page()
    Stealth().apply_stealth_sync(page) # 关键：应用伪装
    # ---------- 访问页面（从入参获取） ----------
    url = params.get("url", "")
    page.goto(url)

    # ---------- 1. 遍历所有缩略图，获取主图 src ----------
    page.wait_for_selector("div > .image", timeout=10000)

    thumbnail_containers = page.locator("div > .image").all()

    for idx, container in enumerate(thumbnail_containers, 1):
        play_icon = container.locator("..").locator(".thumbnails-play-icon")
        if play_icon.count() > 0:
            continue

        # 随机延迟后点击缩略图
        random_delay()
        container.click()
        page.wait_for_selector("#spec-img", state="visible")
        main_img_src = page.locator("#spec-img").get_attribute("src")
        if main_img_src:
            main_img_src_list.append(main_img_src)

    # ---------- 2. 切换到"商品介绍"选项卡 ----------
    random_delay()
    page.locator("#SPXQ-tab-column").click()
    page.wait_for_timeout(3000)

    # ---------- 3. 获取商品介绍图片 URL ----------
    bg_divs = page.query_selector_all("#detail-main > div > div > div.ssd-module-wrap > div.ssd-module")
    img_elements = page.query_selector_all("#detail-main > div > div  img")

    if len(bg_divs) > 0:
        for div in bg_divs:
            bg_style = div.evaluate("element => getComputedStyle(element).backgroundImage")
            img_url = extract_url_from_bg(bg_style)
            if img_url:
                detail_url_list.append(img_url)
    elif len(img_elements) > 0:
        for img in img_elements:
            img_src = img.get_attribute("src")
            if img_src:
                detail_url_list.append(img_src)

    context.close()
    browser.close()

    return {
        "main_img_src": main_img_src_list,
        "detail_url": detail_url_list
    }

def main():
    """主函数，接收两个命令行参数：cookie_string 和 url"""
    # 参数格式：python jd_image_spider.py "cookie_string" "url"
    if len(sys.argv) >= 3:
        cookie_string = sys.argv[1]
        url = sys.argv[2]
        params = {
            "cookie_string": cookie_string,
            "url": url
        }
    else:
        # 默认示例参数
        params = {
            "cookie_string": "",
            "url": "https://item.jd.com/10000000000000.html"
        }

    with sync_playwright() as playwright:
        result = run(playwright, params)
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
