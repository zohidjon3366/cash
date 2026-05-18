# ALL FINANCE CASH — Stage 1 Pro

Bu paket ALL FINANCE logotipiga mos alohida platforma sifatida tayyorlandi.

## Qo'shilgan funksiyalar

1. ALL FINANCE CASH nomidagi zamonaviy dashboard dizayni.
2. Login/parol orqali kirish.
3. Korxonalar ro'yxati: nomi, STIR, rahbar F.I.Sh., telefon.
4. Ish haqi summasi bir marta kiritiladi va har oy avtomatik takrorlanadi.
5. Ish haqi o'zgartirilsa, qaysi sanadan va nima sababdan o'zgargani tarixda saqlanadi.
6. Qo'shimcha xizmatlar: korxona, sana, xizmat nomi, summa, USD, kurs, izoh.
7. Har bir to'lov/xarajat/xizmat uchun alohida valyuta kursi.
8. To'lovlar: naqd, plastik karta, Click, Payme, bank o'tkazmasi, terminal, Uzum, aralash, avans, o'zaro hisob-kitob.
9. Xarajatlar bo'limi.
10. Oldingi qarz, joriy qarz, jami qarz va eski qarz tafsiloti.
11. Hisoblangan foyda va real foyda.
12. Tilda uchun qisqa iframe kod.

## Papkalar

- `backend/` — Render uchun Node.js/Express backend va frontend.
- `backend/public/index.html` — platformaning asosiy ko'rinishi.
- `backend/public/logo.png` — ALL FINANCE logotipi.
- `database/001_schema.sql` — Supabase jadvallari.
- `database/002_demo_data_optional.sql` — ixtiyoriy demo ma'lumotlar.
- `tilda/tilda_iframe_short_code.html` — Tilda T123 blokiga qo'yiladigan qisqa kod.
- `tilda/tilda_fullscreen_page_code.html` — Tilda sahifani to'liq platforma sifatida ochish kodi.
- `render.yaml` — Render Blueprint uchun namuna.

## Deploy qisqa tartibi

### 1. Supabase

1. Supabase'da yangi project oching.
2. SQL Editor'ga kiring.
3. `database/001_schema.sql` faylidagi SQL kodni to'liq nusxalab Run qiling.
4. Demo ma'lumot kerak bo'lsa, `database/002_demo_data_optional.sql` ni ham Run qiling.
5. Project Settings → API bo'limidan:
   - Project URL;
   - service_role key;
   ni oling.

### 2. GitHub

1. GitHub'da yangi repository oching.
2. Ushbu paket ichidagi barcha fayllarni repository'ga yuklang.
3. Commit qiling.

### 3. Render

1. Render Dashboard → New → Web Service.
2. GitHub repository'ni tanlang.
3. Root Directory: `backend`
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Environment Variables:
   - `SUPABASE_URL` = Supabase Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = Supabase service_role key
   - `JWT_SECRET` = uzun maxfiy parol
   - `ADMIN_SETUP_TOKEN` = admin yaratish uchun maxfiy token
   - `CORS_ORIGIN` = Tilda domeni va Render URL, masalan: `https://site.uz,https://all-finance-cash.onrender.com`
7. Deploy tugmasini bosing.

### 4. Admin yaratish

Render deploy bo'lgandan keyin brauzerda oching:

```text
https://YOUR-RENDER-SERVICE.onrender.com/setup.html
```

U yerda `ADMIN_SETUP_TOKEN`, login va parol kiriting.

### 5. Tilda'ga ulash

1. Tilda sahifasida Block Library → Other → T123 HTML block qo'shing.
2. `tilda/tilda_iframe_short_code.html` ichidagi kodni qo'ying.
3. `YOUR-RENDER-SERVICE.onrender.com` ni Render bergan URL bilan almashtiring.
4. Sahifani Publish qiling.

## Muhim xavfsizlik eslatmasi

`SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `ADMIN_SETUP_TOKEN` hech qachon frontend yoki Tilda kodiga yozilmaydi. Ular faqat Render Environment Variables ichida saqlanadi.
