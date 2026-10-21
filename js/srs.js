// Spaced Repetition nach FSRS-4.5 (Free Spaced Repetition Scheduler, wie in Anki/RemNote).
// Jede Karte hat Stabilität S (Tage, nach denen die Erinnerung auf 90 % fällt) und Schwierigkeit D (1–10).
// Bewertungen: 1 = Nochmal, 2 = Schwer, 3 = Gut, 4 = Einfach. Ziel: 90 % Erinnerungsquote.
const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
const DECAY = -0.5, FACTOR = 19 / 81, RETENTION = 0.9;
const MIN = 6e4, DAY = 864e5;

export const GRADES = [[1, 'Nochmal'], [2, 'Schwer'], [3, 'Gut'], [4, 'Einfach']];
export const newSrs = () => ({ state: 'new', due: 0, s: 0, d: 0, last: 0, reps: 0, lapses: 0 });

const clampD = d => Math.min(10, Math.max(1, d));
const d0 = g => W[4] - (g - 3) * W[5];
const retrievability = (days, s) => Math.pow(1 + (FACTOR * days) / s, DECAY);
const nextD = (d, g) => clampD(W[7] * d0(3) + (1 - W[7]) * (d - W[6] * (g - 3)));
const sRecall = (d, s, r, g) => s * (Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1) + 1);
const sForget = (d, s, r) => W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
const intervalDays = s => Math.min(36500, Math.max(1, Math.round((s / FACTOR) * (Math.pow(RETENTION, 1 / DECAY) - 1))));

// Ergebnis aller vier Bewertungen (für die Anzeige auf den Knöpfen und zum Übernehmen)
export function preview(c, now = Date.now()) {
  const out = GRADES.map(([g]) => {
    const n = { ...c, reps: c.reps + 1, last: now };
    if (c.state === 'new') {
      n.d = clampD(d0(g));
      n.s = W[g - 1];
    } else {
      const r = retrievability(Math.max(0, (now - c.last) / DAY), c.s || 0.1);
      n.d = nextD(c.d, g);
      n.s = g === 1 ? Math.min(c.s, sForget(c.d, c.s, r)) : sRecall(c.d, c.s, r, g);
      if (g === 1) n.lapses = c.lapses + 1;
    }
    if (g === 1) { n.state = 'learning'; n.due = now + MIN; } // gleich nochmal in dieser Runde
    else if (g === 2 && c.state !== 'review') { n.state = 'learning'; n.due = now + 10 * MIN; }
    else { n.state = 'review'; n.days = intervalDays(n.s); }
    return n;
  });
  // Abstände müssen mit der Bewertung wachsen: Schwer ≤ Gut < Einfach
  const [, hard, good, easy] = out;
  if (hard.days && good.days <= hard.days) good.days = hard.days + 1;
  if (easy.days <= good.days) easy.days = good.days + 1;
  for (const n of out) if (n.days) { n.due = now + n.days * DAY; delete n.days; }
  return out;
}
export const rate = (c, g, now = Date.now()) => preview(c, now)[g - 1];

export const isDue = (c, now = Date.now()) => !!c && c.due <= now;

export function fmtInterval(ms) {
  const m = Math.round(ms / MIN);
  if (m < 60) return `${Math.max(1, m)} Min`;
  if (m < 60 * 24) return `${Math.round(m / 60)} Std`;
  const d = Math.round(ms / DAY);
  if (d < 31) return `${d} T`;
  if (d < 365) return `${Math.round(d / 30)} Mon`;
  return `${(d / 365).toFixed(d < 3650 ? 1 : 0).replace('.', ',')} J`;
}
