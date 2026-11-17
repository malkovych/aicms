// Slugs that read well in any language. Ukrainian follows the official
// transliteration table (Cabinet of Ministers resolution No. 55, 2010):
// «Як обрати SPF на зиму» → "yak-obraty-spf-na-zymu".

const MAP: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z",
  и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ь: "", ю: "iu", я: "ia",
  // letters that appear in Russian and Belarusian text
  ы: "y", э: "e", ё: "io", ъ: "", ў: "u",
  "'": "", "’": "", "ʼ": "", "`": "",
};

// At the start of a word these letters are spelled differently.
const WORD_START: Record<string, string> = { є: "ye", ї: "yi", й: "y", ю: "yu", я: "ya" };

const isLetter = (ch: string | undefined) => !!ch && /\p{L}/u.test(ch);

export function slugify(input: string, maxLength = 80): string {
  const text = input.normalize("NFC").toLowerCase();
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = text[i - 1];
    if (ch === "г" && prev === "з") { out += "gh"; continue; } // зг → zgh
    if (WORD_START[ch] && !isLetter(prev)) { out += WORD_START[ch]; continue; }
    out += ch in MAP ? MAP[ch] : ch;
  }
  return out
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
