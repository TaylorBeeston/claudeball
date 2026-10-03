#!/usr/bin/env python3
"""Screenshots of the captions bar and the B-roll subject card at the reference viewports, driven by the demo hooks (no audio needed).
Usage: python scripts/ui-captions.py OUT_DIR [BASE_URL] [WxH ...]"""
import sys, time
from playwright.sync_api import sync_playwright

out = sys.argv[1]
base = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:5173/'
sizes = sys.argv[3:] or ['390x844', '844x390', '768x1024', '1280x720', '1920x1080']
ARGS = ['--use-angle=vulkan', '--enable-features=Vulkan,UseSkiaRenderer', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-vulkan-surface']
LINE = "That's a high fly ball to deep left, Butler is going back to the wall, and he makes the catch!"
with sync_playwright() as p:
    b = p.chromium.launch(channel='chromium', headless=True, args=ARGS)
    for size in sizes:
        w, h = (int(x) for x in size.split('x'))
        touch = min(w, h) < 800
        ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if touch else 1, has_touch=touch, is_mobile=touch)
        pg = ctx.new_page()
        shot = lambda n: pg.screenshot(path=f'{out}/{size}_{n}.png', timeout=90000)
        pg.goto(f'{base}?autostart&seed=12&subtitles=all&noaudio&tempo=broadcast', wait_until='commit')
        pg.wait_for_function("window.__boot && window.__boot.tti > 0", timeout=120000)
        time.sleep(7)
        feed = lambda ev: pg.evaluate("e => window.__captionsFeed(e)", ev)
        # captions: booth + PA at once (desktop shows both, phones the newest)
        feed({'id': 1, 'channel': 'booth', 'speaker': 'play-by-play', 'text': LINE, 'expectedDurationMs': 20000})
        feed({'id': 2, 'channel': 'booth', 'speaker': 'color', 'text': 'Great jump on that one.', 'expectedDurationMs': 20000})
        time.sleep(0.6); shot('a_captions')
        feed({'id': 3, 'channel': 'pa', 'speaker': 'pa', 'text': 'Now batting, number 72, Frankie Butler.', 'expectedDurationMs': 20000})
        time.sleep(0.6); shot('b_captions_pa')
        # size XL, solid background, top
        pg.evaluate("""() => { const s = JSON.parse(localStorage.getItem('claudeball.settings.v1') || '{}'); }""")
        # the card follows the director's real `shot` events: wait for one with card: true (a lull between batters), fall back to forcing one
        pg.evaluate("window.__shots = []; engine.broadcast.on(e => { if (e.type === 'shot' && e.phase === 'start') window.__shots.push([e.kind, e.card]) })")
        real = None
        for _ in range(110):
            if pg.locator('.cb-card.subj.show').count():
                real = pg.evaluate("document.querySelector('.cb-card.subj .role').textContent + ' / ' + document.querySelector('.cb-card.subj .nm').textContent")
                break
            time.sleep(1)
        if real:
            time.sleep(0.8); shot('c_card_real'); print(size, 'real shot card:', real, pg.evaluate('window.__shots'))
            ctx.close(); continue
        # subject card for the on-deck batter (or the pitcher when nobody is on deck)
        info = pg.evaluate("""() => { const st = engine.liveState; const od = st.players.find(p => p.role === 'ondeck') || st.players.find(p => p.role === 'pitcher');
          engine.hud.subjectShot({ kind: od.role === 'ondeck' ? 'onDeck' : 'pitcherFace', subject: od.id, hold: 20 }, st); return od.name + ' ' + od.role }""")
        time.sleep(1.0); shot('c_card_' + ('ondeck' if 'ondeck' in info else 'pitcher'))
        print(size, info)
        ctx.close()
    b.close()
