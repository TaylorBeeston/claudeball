#!/usr/bin/env python3
"""Screenshots of the in-game panels (play + rotate hint, controls drawer, pause, settings, game over) and the tempo setup at the reference viewports.
Usage: python scripts/ui-overlays.py OUT_DIR [BASE_URL] [WxH ...]   (a dev server or `npm run preview` must be running)"""
import sys, time
from playwright.sync_api import sync_playwright

out = sys.argv[1]
base = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:5173/'
sizes = sys.argv[3:] or ['390x844', '844x390', '768x1024', '1280x720', '1920x1080']
ARGS = ['--use-angle=vulkan', '--enable-features=Vulkan,UseSkiaRenderer', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-vulkan-surface']
with sync_playwright() as p:
    b = p.chromium.launch(channel='chromium', headless=True, args=ARGS)
    for size in sizes:
        w, h = (int(x) for x in size.split('x'))
        touch = min(w, h) < 800
        ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if touch else 1, has_touch=touch, is_mobile=touch)
        pg = ctx.new_page()
        shot = lambda n: pg.screenshot(path=f'{out}/{size}_{n}.png', timeout=90000)
        pg.goto(f'{base}?menu=1&seed=12&innings=1&noaudio', wait_until='commit')
        pg.wait_for_function("window.__boot && window.__boot.tti > 0", timeout=120000)
        time.sleep(1)
        pg.get_by_text('Game Setup').click(); time.sleep(0.8)
        pg.evaluate("document.querySelector('.cb-col').scrollTo(0, 99999)"); time.sleep(0.4); shot('a_setup_tempo')
        pg.keyboard.press('Escape'); time.sleep(0.5)
        pg.get_by_role('button', name='Start Game').first.click()
        time.sleep(6); shot('b_play')
        if touch:
            pg.tap('canvas', position={'x': w // 2, 'y': h // 2})
        else:
            pg.mouse.move(w // 2, h // 3); pg.mouse.move(w // 2 + 5, h // 3 + 5)
        time.sleep(0.7); shot('c_controls')
        for _ in range(3):  # the first Escape may only close the controls drawer
            pg.keyboard.press('Escape'); time.sleep(0.9)
            if pg.locator('text=Game paused').count(): break
        shot('d_pause')
        pg.get_by_role('button', name='Settings').first.click(); time.sleep(0.9)
        pg.evaluate("document.querySelector('.cb-ui.modal .cb-panel').scrollTo(0, 99999)"); time.sleep(0.4); shot('e_settings')
        pg.keyboard.press('Escape'); time.sleep(0.5)
        pg.keyboard.press('Escape'); time.sleep(0.8)  # resume
        for _ in range(60):  # a 1-inning game: skip half innings until the Final screen shows
            if pg.locator('text=Play again').count(): break
            pg.evaluate("engine.sim.skipToNextHalfInning()")
            time.sleep(3)
        time.sleep(0.8); shot('f_gameover')
        ctx.close()
    b.close()
print('done')
