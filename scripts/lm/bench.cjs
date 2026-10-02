/**
 * Benchmarks a small ONNX language model in headless Chrome (WebGPU) on sampled game situations.
 *   PLAYWRIGHT_DIR=... node scripts/lm/bench.cjs <hf-model-id> <dtype> <contexts.json> <out.json> [tfjs-version=3.8.1] [with-kokoro=0]
 * Measures load time, time to first token (prefill), decode speed, GPU memory (nvidia-smi), and keeps every output for the validator.
 */
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const [model, dtype, ctxFile, outFile, ver = '3.8.1', kokoro = '0'] = process.argv.slice(2);
const MODE = process.env.MODE || 'free'; // free: write a remark from the facts; rewrite: rephrase the grammar's line (the facts come from the line)
const vram = () => { try { return Number(execSync('nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits').toString().trim().split('\n')[0]); } catch { return -1; } };
(async () => {
  const contexts = JSON.parse(fs.readFileSync(ctxFile, 'utf8'));
  const systemRewrite = 'You are the colour analyst in a baseball TV booth. Rewrite the given remark in a livelier, more natural broadcast style, keeping exactly the same meaning. 8 to 25 words. Do not add any fact, name or number that is not in the remark. Do not use he, she, his or her. No emoji, no quotation marks. Reply with the rewritten remark only.';
  const systemFree = 'You are the colour analyst in a baseball TV booth, chatting with the play-by-play announcer. Say ONE short, natural remark (8 to 25 words) about what is happening. Use ONLY the facts in the JSON: never invent a name, a number, a stat or an event. Do not use he, she, his or her for players: use their last name. Do not repeat the recent lines. No emoji, no quotation marks. Reply with the remark only.';
  const system = MODE === 'rewrite' ? systemRewrite : systemFree;
  const browser = await chromium.launch({ args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-vulkan-surface'] });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
  await page.goto('http://127.0.0.1:5300/');
  await page.waitForTimeout(1500);
  const v0 = vram();
  const res = await page.evaluate(async ({ model, dtype, contexts, system, ver, kokoro, MODE }) => {
    const out = { model, dtype, ver, MODE };
    let t = performance.now();
    const tf = await import(`https://cdn.jsdelivr.net/npm/@huggingface/transformers@${ver}/+esm`);
    out.importMs = Math.round(performance.now() - t);
    t = performance.now();
    const gen = await tf.pipeline('text-generation', model, { device: 'webgpu', dtype });
    out.loadMs = Math.round(performance.now() - t);
    window.__gen = gen;
    if (kokoro === '1') {
      const mod = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm');
      window.__tts = await mod.KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'webgpu' });
    }
    out.samples = [];
    // warm-up
    await gen([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(contexts[0].facts) }], { max_new_tokens: 8, do_sample: false });
    for (const c of contexts) {
      const user = MODE === 'rewrite' ? JSON.stringify({ remark: c.grammar, speakers: [c.facts.batter && c.facts.batter.name, c.facts.pitcher && c.facts.pitcher.name].filter(Boolean) }) : JSON.stringify(c.facts);
      const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
      const promptIds = gen.tokenizer.apply_chat_template(messages, { add_generation_prompt: true, tokenize: true, return_tensor: false });
      const nIn = Array.isArray(promptIds) ? promptIds.length : promptIds.input_ids?.length ?? 0;
      let first = 0;
      const t0 = performance.now();
      const streamer = new tf.TextStreamer(gen.tokenizer, { skip_prompt: true, callback_function: () => { if (!first) first = performance.now() - t0; } });
      let ttsMs = 0;
      const o = await gen(messages, { max_new_tokens: 48, do_sample: true, temperature: 0.7, top_p: 0.9, streamer });
      const total = performance.now() - t0;
      const text = o[0].generated_text.at(-1).content.trim();
      const nOut = gen.tokenizer.encode(text).length;
      out.samples.push({ text, nIn, nOut, firstMs: Math.round(first), totalMs: Math.round(total), tps: +(nOut / Math.max(0.001, (total - first) / 1000)).toFixed(1) });
    }
    return out;
  }, { model, dtype, contexts, system, ver, kokoro, MODE });
  res.vramBeforeMB = v0;
  res.vramAfterMB = vram();
  res.consoleErrors = logs.slice(0, 5);
  fs.writeFileSync(outFile, JSON.stringify(res, null, 1));
  const s = res.samples;
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(model, dtype, 'load', res.loadMs, 'ms; first-token median', med(s.map((x) => x.firstMs)), 'ms; total median', med(s.map((x) => x.totalMs)), 'ms; tok/s median', med(s.map((x) => x.tps)), '; prompt tokens', med(s.map((x) => x.nIn)), '; vram', res.vramBeforeMB, '->', res.vramAfterMB, 'MB');
  await browser.close();
})().catch((e) => { console.error('BENCH FAILED', e.message.slice(0, 400)); process.exit(1); });
