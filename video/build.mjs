// Renders video/scenes.json to 1920x1080 frames, joins them with the narration WAVs,
// burns each scene's caption into its frame, writes captions (SRT/VTT) and video/out/schelling-deals.mp4.
// NODE_PATH=$(npm root -g) FFMPEG=/opt/homebrew/Cellar/ffmpeg/9.0.2_1/bin/ffmpeg node video/build.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/cli/node_modules/playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const PAD = 0.45;
mkdirSync(out, { recursive: true });

const scenes = JSON.parse(readFileSync(join(here, "scenes.json"), "utf8"));
const spoken = new Map(
  readFileSync(join(here, "narration.md"), "utf8")
    .split("\n")
    .map((l) => l.match(/^\| (s\d\d) \| [^|]+ \| (.+) \|\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const caption = (id) =>
  spoken.get(id).replace(/point one test net Near/g, "0.1 testnet NEAR").replace(/A P I/g, "API").replace(/Near test net/g, "NEAR testnet").replace(/on chain/g, "on-chain");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const color = (l) =>
  l.replace(/\b(ACCEPT|PASS|Paid|ok|created|refunded|verified|0 access keys)\b/g, '<b class="g">$1</b>')
   .replace(/\b(DECLINE|FAILED|rejected|not open|missed)\b/g, '<b class="r">$1</b>');

function html(s) {
  const body = s.image
    ? `<img src="file://${join(here, s.image)}">`
    : `<pre>${s.lines.map((l) => color(esc(l))).join("\n")}</pre>`;
  return `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;width:1920px;height:1080px;background:#0f1419;color:#e6e1cf;font:28px/1.45 "SF Mono",Menlo,monospace;display:flex;flex-direction:column}
  header{padding:48px 72px 12px;font:600 46px/1.2 -apple-system,Helvetica,sans-serif;color:#fff}
  .tag{font:500 24px -apple-system,sans-serif;color:#9aa5b1;padding:0 72px}
  main{flex:1;padding:24px 72px 150px;overflow:hidden;display:flex;align-items:flex-start}
  pre{margin:0;white-space:pre-wrap;word-break:break-all;background:#151b23;border:1px solid #2a3340;border-radius:14px;padding:28px 34px;width:100%;box-sizing:border-box}
  img{max-width:100%;max-height:820px;border-radius:14px;border:1px solid #2a3340}
  .g{color:#7ee787}.r{color:#ff7b72}
  footer{position:fixed;left:0;right:0;bottom:0;padding:22px 120px 30px;background:rgba(0,0,0,.82);color:#fff;font:500 34px/1.35 -apple-system,Helvetica,sans-serif;text-align:center}
  </style><header>${esc(s.title)}</header><div class="tag">${esc(s.tag ?? "NEAR testnet · scripted buyer agents")}</div><main>${body}</main><footer>${esc(caption(s.id))}</footer>`;
}

const dur = (f) =>
  Number(execFileSync(ffmpeg.replace(/ffmpeg$/, "ffprobe"), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const parts = [];
let t = 0;
const srt = [];
const fmt = (x, sep) => {
  const ms = Math.round(x * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, "0");
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
  return `${h}:${m}:${s}${sep}${String(ms % 1000).padStart(3, "0")}`;
};
for (const [i, s] of scenes.entries()) {
  writeFileSync(join(out, `${s.id}.html`), html(s));
  await page.goto(`file://${join(out, `${s.id}.html`)}`);
  const png = join(out, `${s.id}.png`);
  await page.screenshot({ path: png });
  const wav = join(here, "audio", `${s.id}.wav`);
  const d = dur(wav) + PAD;
  const mp4 = join(out, `${s.id}.mp4`);
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-loop", "1", "-i", png, "-i", wav, "-af", `apad=pad_dur=${PAD}`,
    "-t", d.toFixed(3), "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", mp4]);
  parts.push(mp4);
  srt.push(`${i + 1}\n${fmt(t + 0.05, ",")} --> ${fmt(t + d - 0.2, ",")}\n${caption(s.id)}\n`);
  t += d;
}
await browser.close();
writeFileSync(join(out, "list.txt"), parts.map((p) => `file '${p}'`).join("\n"));
writeFileSync(join(here, "schelling-deals.srt"), srt.join("\n"));
writeFileSync(join(here, "schelling-deals.vtt"), "WEBVTT\n\n" + srt.join("\n").replace(/(\d\d),(\d\d\d)/g, "$1.$2"));
const joined = join(out, "joined.mp4");
execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(out, "list.txt"), "-c", "copy", joined]);
const final = join(out, "schelling-deals.mp4");
execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", joined,
  "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", final]);
console.log(`video ${final} ${t.toFixed(2)} s`);
