# Generates the ad-board atlas and crowd cutout sheet with PIL (no Blender needed): python3 gen_2d.py <assets dir>
import sys, random
from PIL import Image, ImageDraw, ImageFont
root = sys.argv[1]; random.seed(7)
def font(sz):
    try: return ImageFont.load_default(size=sz)
    except TypeError: return ImageFont.load_default()
# ---- ad atlas: 3 x 2 cells, each 512 x 128 (4:1 panel)
ads = [("CLAUDEBALL", (10, 40, 110), (255, 255, 255)), ("BIG LEAGUE BATS", (200, 30, 30), (255, 255, 255)), ("DIAMOND GLOVE CO.", (255, 200, 0), (20, 20, 20)),
       ("FIELD FUEL", (20, 120, 60), (255, 255, 255)), ("STADIUM SODA", (240, 240, 240), (200, 20, 20)), ("HOMERUN AUTO", (20, 20, 20), (255, 210, 0))]
at = Image.new("RGB", (1536, 256), (0, 0, 0)); d = ImageDraw.Draw(at)
for i, (t, bg, fg) in enumerate(ads):
    x, y = (i % 3)*512, (i//3)*128; d.rectangle([x, y, x+511, y+127], fill=bg); d.rectangle([x+4, y+4, x+507, y+123], outline=fg, width=3)
    f = font(46); w = d.textlength(t, font=f); d.text((x+(512-w)/2, y+38), t, fill=fg, font=f)
at.save(f"{root}/ads/ad_atlas.png")
# ---- crowd sheet: 8 x 4 cells of 256 x 256 RGBA seated spectators (transparent background)
W, H, C, R = 256, 256, 8, 4
sh = Image.new("RGBA", (W*C, H*R), (0, 0, 0, 0))
skins = [(240, 200, 170), (220, 170, 130), (190, 130, 95), (150, 100, 70), (110, 75, 55), (250, 215, 190)]
tops = [(200, 30, 30), (20, 60, 160), (250, 250, 250), (30, 30, 30), (240, 200, 30), (30, 140, 70), (120, 30, 140), (240, 120, 30)]
hair = [(20, 15, 10), (60, 40, 20), (120, 80, 40), (200, 170, 100), (150, 150, 150), (10, 10, 10)]
for r in range(R):
    for c in range(C):
        im = Image.new("RGBA", (W, H), (0, 0, 0, 0)); g = ImageDraw.Draw(im); ox = random.randint(-8, 8)
        top = random.choice(tops); sk = random.choice(skins); hr = random.choice(hair)
        g.rounded_rectangle([50+ox, 130, 206+ox, 256], radius=40, fill=top)                                    # torso
        if random.random() < .3: g.rectangle([50+ox, 195, 206+ox, 256], fill=tuple(int(v*.7) for v in top))
        g.rectangle([116+ox, 105, 140+ox, 135], fill=sk)                                                       # neck
        g.ellipse([88+ox, 40, 168+ox, 125], fill=sk)                                                           # head
        if random.random() < .5: g.pieslice([86+ox, 34, 170+ox, 110], 180, 360, fill=hr)                       # hair
        if random.random() < .35:                                                                             # cap
            g.pieslice([84+ox, 30, 172+ox, 112], 180, 360, fill=random.choice(tops)); g.rectangle([84+ox, 70, 186+ox, 78], fill=(20, 20, 20))
        if random.random() < .25:                                                                             # raised arm
            g.rounded_rectangle([190+ox, 60, 214+ox, 180], radius=12, fill=top); g.ellipse([186+ox, 40, 218+ox, 72], fill=sk)
        sh.paste(im, (c*W, r*H))
sh.save(f"{root}/crowd/crowd_sheet.png")

# ---- scoreboard placeholder (1024x384): asymmetric text so orientation is checkable
sb = Image.new("RGB", (1024, 384), (6, 8, 14)); d = ImageDraw.Draw(sb)
d.rectangle([16, 16, 1007, 70], fill=(20, 30, 90)); d.text((30, 22), "CLAUDEBALL PARK", fill=(255, 210, 0), font=font(40))
for i, (t, n) in enumerate((("VISITORS", "0"), ("HOME", "0"))):
    y = 90+i*90; d.text((40, y+10), t, fill=(255, 255, 255), font=font(48)); d.text((520, y), n, fill=(255, 190, 0), font=font(80))
d.text((40, 290), "B 0  S 0  O 0   INNING 1", fill=(80, 255, 120), font=font(40))
sb.save(f"{root}/ads/scoreboard.png")
