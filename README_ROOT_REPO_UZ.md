# ALL FINANCE CASH — Stage 1.8 Root Repo Patch

Bu patch sizning hozirgi GitHub repo ko'rinishingizga mos: `server.js`, `package.json`, `package-lock.json`, `.env.example` va `public/` papkasi repo rootida turadi.

## Muhim

Mavjud Supabase bazani O'CHIRMANG. Yangi project ochmang. `001_schema.sql` ni qayta ishlatmang.

Ushbu patch mavjud fayllarni yangilaydi va mavjud ma'lumotlarni saqlab qoladi.

## Nima qo'shildi

- Korxona statuslari.
- Ayrim oylarda korxona bo'yicha ish haqi hisoblanmasligini belgilash.
- Eski qarzlar oylik tushum va real foydaga kiritilmaydi.
- Eski qarzlar alohida hisobda turadi.
- Joriy oy tushumi, joriy qarz va eski qarz alohida ko'rinadi.
- Kutilayotgan tushum joriy qoldiq va qarzlar bo'yicha ajratiladi.

## GitHub'ga yuklash

Repo rootida hozir turgan fayllarni ushbu patchdagi fayllar bilan almashtiring:

- `server.js`
- `package.json`
- `package-lock.json`
- `.env.example`
- `public/index.html`
- `public/setup.html`
- `public/logo.png`

`database/` papkasini ham yuklashingiz mumkin, lekin bu faqat SQL fayllarni saqlash uchun.

## Supabase bo'yicha

Agar Stage 1.7 SQL oldin ishlatilmagan bo'lsa, Supabase SQL Editor'da faqat shu faylni bir marta ishga tushiring:

`database/007_stage1_7_company_status_salary_skip.sql`

Bu SQL mavjud bazani o'chirmaydi. Faqat kerakli ustun/jadvalni `if not exists` orqali qo'shadi.

Stage 1.8 uchun yangi SQL shart emas:

`database/008_stage1_8_old_debt_separate_no_schema_change.sql`

## Render sozlamasi

Sizning hozirgi repo rootida `server.js` turgani uchun Render'da Root Directory bo'sh bo'lishi kerak.

- Root Directory: bo'sh qolsin
- Build Command: `npm install`
- Start Command: `npm start`

Keyin:

Manual Deploy -> Clear build cache & deploy

## Tekshirish

Deploydan keyin:

`https://cash-8jk3.onrender.com/api/health`

javobda `version: "1.8.0"` chiqishi kerak.
