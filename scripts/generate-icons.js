// scripts/generate-icons.js — يعيد توليد كل أيقونات PWA من الصفر
// الاستخدام: npm install --no-save sharp && node scripts/generate-icons.js
// عدّل ألوان الـ gradients جوه buildSvg() لو الهوية البصرية للعلامة التجارية اتغيّرت
const sharp = require('sharp');
const fs = require('fs');

// شعار مبسّط بروح "ثريا" (نجفة) بخطوط ذهبية على خلفية عاجية/سوداء غامقة،
// يطابق هوية النظام البصرية (Obsidian + Burnished Gold + Champagne).
// العناصر كلها داخل الـ safe-zone المركزية (نسبة ~80%) عشان تشتغل صح
// كـ maskable icon (Android بيقص الحواف لأشكال مختلفة: دائرة، مربع مدور...).
function buildSvg({ size, padding = 0, rounded = true, bg = true }) {
  const s = size;
  const cx = s / 2;
  const r = rounded ? s * 0.22 : 0;
  const scale = (s - padding * 2) / 512; // نرسم على شبكة منطقية 512×512 ثم نحجّم
  const g = (x) => padding + x * scale;

  return `
<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bgGrad" cx="50%" cy="38%" r="75%">
      <stop offset="0%" stop-color="#1e1b22"/>
      <stop offset="55%" stop-color="#161419"/>
      <stop offset="100%" stop-color="#09080a"/>
    </radialGradient>
    <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f0c97a"/>
      <stop offset="50%" stop-color="#e8b84a"/>
      <stop offset="100%" stop-color="#b8841a"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="30%">
      <stop offset="0%" stop-color="#f0c97a" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#f0c97a" stop-opacity="0"/>
    </radialGradient>
  </defs>

  ${bg ? `<rect x="0" y="0" width="${s}" height="${s}" rx="${r}" fill="url(#bgGrad)"/>` : ''}

  <!-- توهج خفيف خلف الثريا -->
  <circle cx="${g(256)}" cy="${g(215)}" r="${140 * scale}" fill="url(#glow)"/>

  <!-- سلسلة التعليق -->
  <line x1="${g(256)}" y1="${g(60)}" x2="${g(256)}" y2="${g(110)}" stroke="url(#goldGrad)" stroke-width="${5*scale}" stroke-linecap="round"/>

  <!-- الإطار العلوي -->
  <path d="M ${g(150)} ${g(120)} Q ${g(256)} ${g(90)} ${g(362)} ${g(120)}" fill="none" stroke="url(#goldGrad)" stroke-width="${6*scale}" stroke-linecap="round"/>

  <!-- 3 أذرع متدلية بأحجام مختلفة (تكوين ثريا كلاسيكي) -->
  <path d="M ${g(150)} ${g(120)} Q ${g(120)} ${g(190)} ${g(150)} ${g(255)}" fill="none" stroke="url(#goldGrad)" stroke-width="${5*scale}" stroke-linecap="round"/>
  <path d="M ${g(256)} ${g(110)} L ${g(256)} ${g(270)}" fill="none" stroke="url(#goldGrad)" stroke-width="${5*scale}" stroke-linecap="round"/>
  <path d="M ${g(362)} ${g(120)} Q ${g(392)} ${g(190)} ${g(362)} ${g(255)}" fill="none" stroke="url(#goldGrad)" stroke-width="${5*scale}" stroke-linecap="round"/>

  <!-- كرات الإضاءة (اللمبات/الكريستال) -->
  <circle cx="${g(150)}" cy="${g(268)}" r="${17*scale}" fill="url(#goldGrad)"/>
  <circle cx="${g(256)}" cy="${g(285)}" r="${22*scale}" fill="url(#goldGrad)"/>
  <circle cx="${g(362)}" cy="${g(268)}" r="${17*scale}" fill="url(#goldGrad)"/>

  <!-- إطار سفلي يربط بين الأذرع -->
  <path d="M ${g(150)} ${g(255)} Q ${g(256)} ${g(300)} ${g(362)} ${g(255)}" fill="none" stroke="url(#goldGrad)" stroke-width="${4*scale}" stroke-linecap="round" opacity="0.7"/>

  <!-- أشعة ضوء متناثرة (توقيع الهوية البصرية) -->
  <g stroke="url(#goldGrad)" stroke-width="${2.5*scale}" stroke-linecap="round" opacity="0.85">
    <line x1="${g(256)}" y1="${g(300)}" x2="${g(256)}" y2="${g(340)}"/>
    <line x1="${g(220)}" y1="${g(295)}" x2="${g(200)}" y2="${g(330)}"/>
    <line x1="${g(292)}" y1="${g(295)}" x2="${g(312)}" y2="${g(330)}"/>
  </g>
</svg>`;
}

const outDir = require('path').join(__dirname, '..', 'public', 'icons');
const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

(async () => {
  for (const size of sizes) {
    const svg = buildSvg({ size, padding: 0 });
    await sharp(Buffer.from(svg)).png().toFile(`${outDir}/icon-${size}.png`);
    console.log('✓ icon-' + size + '.png');
  }

  // maskable: نفس التصميم لكن بخلفية ملء كاملة بدون حواف مدورة (Android
  // بيعمل mask بنفسه) ومساحة أمان أكبر حوالين المحتوى
  for (const size of [192, 512]) {
    const svg = buildSvg({ size, padding: size * 0.1, rounded: false });
    await sharp(Buffer.from(svg)).png().toFile(`${outDir}/icon-maskable-${size}.png`);
    console.log('✓ icon-maskable-' + size + '.png');
  }

  // apple-touch-icon (iOS/iPadOS Safari — بيضيف زوايا مدورة تلقائيًا هو نفسه)
  const appleSvg = buildSvg({ size: 180, padding: 0, rounded: false });
  await sharp(Buffer.from(appleSvg)).png().toFile(`${outDir}/apple-touch-icon.png`);
  console.log('✓ apple-touch-icon.png');

  // favicon متعدد الأحجام
  const favSvg32 = buildSvg({ size: 32, padding: 0 });
  await sharp(Buffer.from(favSvg32)).png().toFile(`${outDir}/favicon-32.png`);
  const favSvg16 = buildSvg({ size: 16, padding: 0 });
  await sharp(Buffer.from(favSvg16)).png().toFile(`${outDir}/favicon-16.png`);
  console.log('✓ favicons');

  console.log('DONE');
})();
