import type { Category, Priority } from './types.js';

/** Words that point to a category. First category with the most hits wins. */
const CATEGORY_WORDS: [Category, RegExp][] = [
  ['Access', /\b(password|locked|lock ?out|login|log ?in|sign ?in|mfa|2fa|authenticator|account|permission|access)\b/gi],
  ['Email', /\b(outlook|email|e-mail|inbox|mailbox|calendar|teams meeting|shared mailbox)\b/gi],
  ['Network', /\b(vpn|wi-?fi|wireless|internet|network|ethernet|connection|disconnect\w*|dns|slow site)\b/gi],
  ['Printing', /\b(print\w*|scanner|scan|toner|paper jam|label printer)\b/gi],
  ['Hardware', /\b(laptop|pc|computer|monitor|screen|keyboard|mouse|battery|boot|blue screen|bsod|dock|charger|headset|webcam|flicker\w*)\b/gi],
  ['Software', /\b(install\w*|licen[cs]e|software|app|application|update|excel|word|adobe|acrobat|crash\w*|error)\b/gi],
  ['Onboarding', /\b(new hire|new starter|onboard\w*|starting monday|joiner|leaver|offboard\w*)\b/gi],
];

const URGENT = /\b(production|line (is )?(down|stopped)|everyone|whole (team|floor|plant)|outage|can'?t work|cannot work|urgent|asap|down for all)\b/i;
const HIGH = /\b(can'?t|cannot|unable|not working|won'?t|keeps|stopped|broken|locked)\b/i;
const LOW = /\b(request|would like|nice to have|when you can|no rush|question)\b/i;

export function suggestCategory(text: string): Category {
  let best: Category = 'Other';
  let hits = 0;
  for (const [cat, re] of CATEGORY_WORDS) {
    const n = text.match(re)?.length ?? 0;
    if (n > hits) { best = cat; hits = n; }
  }
  return best;
}

export function suggestPriority(text: string): Priority {
  if (URGENT.test(text)) return 1;
  if (LOW.test(text) && !HIGH.test(text)) return 4;
  if (HIGH.test(text)) return 2;
  return 3;
}

/** Turns free text into a Postgres OR-query of its useful words, for "similar" search. */
const STOP = new Set('a an and are as at be but by can cant could do does dont for from get got has have help hi i im in is it its keep keeps me my not of on or our please so that the them there this to too up was we when with won wont you your yesterday today since every after before just still very'.split(' '));
export function searchTerms(text: string): string[] {
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, 12);
}
