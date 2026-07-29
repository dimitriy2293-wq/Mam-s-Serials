import fs from "fs";
import path from "path";

function formatAssTime(sec) {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.round((clamped - Math.floor(clamped)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// words: [{ word, start, end }] в секундах, уже с учётом смещения по всему ролику
// (см. lib/shorts-assemble.js — каждому сегменту добавляется offset = сумма
// длительностей предыдущих сегментов).
export function buildWordByWordAss(words, { width = 1080, height = 1920 } = {}) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,DejaVu Sans,84,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,7,0,2,60,60,280,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = words
    .filter((w) => w.start != null && w.end != null && w.word && w.word.trim())
    .map((w) => {
      const start = formatAssTime(w.start);
      const end = formatAssTime(Math.max(w.end, w.start + 0.05));
      const clean = w.word.replace(/[{}\\]/g, "").toUpperCase();
      return `Dialogue: 0,${start},${end},Word,,0,0,0,,${clean}`;
    });

  return header + lines.join("\n") + "\n";
}

export function writeAssFile(words, workDir, opts = {}) {
  const assPath = path.join(workDir, `subs_${Date.now()}.ass`);
  fs.writeFileSync(assPath, buildWordByWordAss(words, opts), "utf8");
  return assPath;
}
