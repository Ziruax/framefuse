/* transliteration smoke test (run with bun) */
import { transliterate, isLikelyRomanized, transliterateForLocale } from "../src/lib/translit/index";

const hiCases: Array<[string, string]> = [
  ["kya haal hai bhai sab theek hai na", "क्या हाल है भाई सब ठीक है ना"],
  ["main kal tumhare ghar aaunga", "मैं कल तुम्हारे घर आऊँगा"],
  ["karo", "करो"],
  ["karna", "करना"],
  ["khana", "खाना"],
  ["pakka", "पक्का"],
  ["pyar", "प्यार"],
  ["kya", "क्या"],
  ["dil", "दिल"],
  ["raat", "रात"],
  ["log", "लोग"],
  ["bolo", "बोलो"],
  ["kaise", "कैसे"],
  ["khush", "खुश"],
  ["chalna", "चलना"],
  ["lekin", "लेकिन"],
  ["mila", "मिला"],
  ["bola", "बोला"],
  ["sirf", "सिर्फ़"],
  ["bandh", "बन्ध"],
  ["gyan", "ज्ञान"],
  ["swami", "स्वामी"],
  ["nyay", "न्याय"],
  ["achchha", "अच्छा"],
  ["duniya", "दुनिया"],
  ["zindagi", "ज़िंदगी"],
  ["chalo", "चलो"],
  ["karm", "कर्म"],
  ["dharm", "धर्म"],
  ["video", "video"],
  ["AI", "AI"],
  ["roti", "रोटी"],
  ["pani", "पानी"],
];

const urCases: Array<[string, string]> = [
  ["kya haal hai bhai sab theek hai na", "کیا حال ہے بھائی سب ٹھیک ہے نا"],
  ["karo", "کرو"],
  ["karna", "کرنا"],
  ["pyar", "پیار"],
  ["kya", "کیا"],
  ["dil", "دل"],
  ["log", "لوگ"],
  ["lekin", "لیکن"],
  ["chalo", "چلو"],
  ["mila", "ملا"],
  ["beta", "بیٹا"],
  ["dekho", "دیکھو"],
  ["duniya", "دنیا"],
  ["zindagi", "زندگی"],
];

let pass = 0, fail = 0;
for (const [inp, want] of hiCases) {
  const got = transliterate(inp, "hi");
  if (got === want) { pass++; }
  else { fail++; console.log(`HI FAIL "${inp}"\n  want: ${want}\n  got : ${got}`); }
}
for (const [inp, want] of urCases) {
  const got = transliterate(inp, "ur");
  if (got === want) { pass++; }
  else { fail++; console.log(`UR FAIL "${inp}"\n  want: ${want}\n  got : ${got}`); }
}

// informational runs
console.log("\n-- hi samples --");
for (const s of [
  "aaj ka din bahut accha hai",
  "hum subah jaldi uthenge aur kaam par jayenge",
  "ye video pasand aaye to like karo",
  "mujhe chai pasand hai lekin coffee nahi",
  "tumhara ghar bahut sundar hai",
]) console.log(`${s}\n  → ${transliterate(s, "hi")}`);
console.log("\n-- ur samples --");
for (const s of [
  "aaj ka din bohat acha hai",
  "mujhe chai pasand hai lekin coffee nahi",
  "tumhara ghar bohat khoobsurat hai",
  "ye video pasand aaye to like karo",
]) console.log(`${s}\n  → ${transliterate(s, "ur")}`);

console.log("\nromanized?", isLikelyRomanized("kya haal hai"), isLikelyRomanized("क्या हाल है"));
console.log("locale:", transliterateForLocale("kya haal", "ur-PK"));
console.log(`\n${pass} pass, ${fail} fail`);
