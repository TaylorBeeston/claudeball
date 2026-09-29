// Downloads the CC0 Poly Haven HDRIs (2K) used for sky + image-based lighting into public/hdri/.
// They are not committed (see .gitignore). Run: npm run hdri
import fs from 'node:fs';
import path from 'node:path';

const FILES = {
  'sky_day.hdr': 'kloofendal_48d_partly_cloudy_puresky',
  'sky_dusk.hdr': 'qwantani_dusk_2_puresky',
};
const dir = path.resolve('public/hdri');
fs.mkdirSync(dir, { recursive: true });
for (const [out, name] of Object.entries(FILES)) {
  const dest = path.join(dir, out);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1e6) {
    console.log('have', out);
    continue;
  }
  const url = `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/${name}_2k.hdr`;
  process.stdout.write(`fetching ${name} ... `);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  console.log('ok');
}
console.log('HDRIs by Poly Haven (CC0): https://polyhaven.com/hdris');
