#!/usr/bin/env python3
"""
Screenshots of the loading screen, menus and HUD at the reference viewports, plus the measured boot times.

  npm run dev -- --port 5231 --strictPort &            # or: CB_BASE=/claudeball/ npm run build && npm run preview
  /path/to/python scripts/ui-shots.py OUT_DIR [BASE_URL] [WxH ...]

Needs Playwright for Python with a Chromium (the flags below give GPU rendering in headless Chrome on Linux). Phone-sized
viewports (width < 900) are emulated as touch devices at DPR 2. Writes <WxH>_<step>.png and boot.json.
"""
import json, sys, time
from playwright.sync_api import sync_playwright

out = sys.argv[1]
base = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:5173/'
sizes = sys.argv[3:] or ['390x844', '844x390', '768x1024', '1280x720', '1920x1080']
ARGS = ['--use-angle=vulkan', '--enable-features=Vulkan,UseSkiaRenderer', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-vulkan-surface']
report = {}

with sync_playwright() as p:
    b = p.chromium.launch(channel='chromium', headless=True, args=ARGS)
    for size in sizes:
        w, h = (int(x) for x in size.split('x'))
        touch = min(w, h) < 800
        ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if touch else 1, has_touch=touch, is_mobile=touch)
        pg = ctx.new_page()
        shot = lambda n: pg.screenshot(path=f'{out}/{size}_{n}.png', timeout=90000)
        # ?menu=1: automation skips the menu by default (navigator.webdriver), this forces it
        pg.goto(f'{base}?menu=1&seed=12', wait_until='commit')
        k = 0
        t0 = time.time()
        while time.time() - t0 < 120:
            st = pg.evaluate("() => ({tti: window.__boot && window.__boot.tti, gone: document.getElementById('cb-boot')?.classList.contains('gone')})")
            if st['tti']:
                break
            if k < 3:
                shot(f'0load{k}'); k += 1
            time.sleep(0.8)
        time.sleep(1.2)
        report[size] = pg.evaluate("() => ({tti: __boot.tti, steps: __boot.steps, missing: __boot.missing, stages: __boot.stages})")
        shot('1title')
        pg.get_by_text('Game Setup').click(); time.sleep(0.8); shot('2setup')
        pg.keyboard.press('Escape'); time.sleep(0.6)
        pg.get_by_text('Settings', exact=True).click(); time.sleep(0.8); shot('3settings')
        pg.keyboard.press('Escape'); time.sleep(0.6)
        pg.get_by_role('button', name='Start Game').first.click()
        time.sleep(14); shot('4play')
        if touch:
            pg.tap('canvas', position={'x': w // 2, 'y': h // 2})
        else:
            pg.mouse.move(w // 2, h // 3); pg.mouse.move(w // 2 + 5, h // 3 + 5)
        time.sleep(0.7); shot('5controls')
        pg.keyboard.press('Escape'); time.sleep(0.9); shot('6pause')
        ctx.close()
    b.close()
json.dump(report, open(f'{out}/boot.json', 'w'), indent=1)
print(json.dumps({k: v['tti'] for k, v in report.items()}))
