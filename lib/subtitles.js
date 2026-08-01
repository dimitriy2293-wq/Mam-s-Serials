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
  // Раньше Fontsize/Outline/MarginV были зашиты числами, подобранными под 1080x1920.
  // При смене разрешения (см. WIDTH/HEIGHT в shorts-assemble.js) PlayResY меняется,
  // а эти пиксельные значения — нет, из-за чего субтитры при уменьшенном разрешении
  // визуально становились огромными ("пол-экрана"). Теперь считаем их пропорционально
  // от базовых значений, подобранных как раз под референс 1920 по высоте.
  const scale = height / 1920;
  const fontsize = Math.round(84 * scale);
  const outline = Math.max(2, Math.round(7 * scale));
  const marginV = Math.round(280 * scale);
  const marginLR = Math.round(60 * scale);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,DejaVu Sans,${fontsize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,${marginLR},${marginLR},${marginV},1

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
