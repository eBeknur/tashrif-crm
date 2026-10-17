# Tashrif CRM — lokal MVP

Planshet terminali institut ichidagi noutbuk serveriga ulanadi. Administrator tashriflarni, xodimlarni va terminal tokenlarini boshqaradi.

## Ishga tushirish

1. Noutbukda Node.js 22 yoki yangiroq versiya bo‘lsin.
2. PowerShell 7’da `pwsh -ExecutionPolicy Bypass -File .\start-server.ps1` buyrug‘ini ishga tushiring. Birinchi marta Python/OpenCV muhiti va YOLO/SFace modellari yuklanadi.
3. Noutbukda `https://127.0.0.1:8443/` manzilini ochib administrator yarating.
4. **Planshet terminali → Yangi terminal** orqali terminal tokeni yarating.
5. Planshetda `http://<noutbuk-LAN-IP>:8000/certificate` dan CA sertifikatini yuklab, ishonchli root CA sifatida o‘rnating.
6. `https://<noutbuk-LAN-IP>:8443/terminal` manzilini ochib tokenni kiriting va brauzerning kamera ruxsatini bering.

Planshet va noutbuk bir lokal tarmoqda bo‘lishi kerak. Server portlarini ngrok yoki ommaviy internetga ochmang.

## Alohida kirish va chiqish planshetlari

Administrator panelidagi **Yangi terminal** oynasida vazifani tanlang. Kirish plansheti faqat kirish ekranini, chiqish plansheti esa faqat chiqish ekranini ko'rsatadi. Har biriga alohida token beriladi; server API ham token rolini tekshiradi. Eski terminal tokenlari migratsiyadan keyin kirish terminali sifatida ishlaydi.

Bir kadrda bir nechta yuz bo'lsa, YOLO markaziy ish zonasidagi kamida 72 px yuzlarni ko'rib, eng katta yuzni tanlaydi. Bu oddiy kamera tasviridagi yaqinlik taxmini: planshet masofani metrda o'lchamaydi. Markaziy zona radiusini `TASHRIF_FACE_CENTER_RADIUS` muhit o'zgaruvchisi orqali sozlash mumkin (standart `0.62`).

## Tashrif terminali

1. Tashrifchi F.I.Sh.ini kiritadi va **Rasmga olib, kirishni qayd etish** tugmasini bir marta bosadi. Kamera qisqa vaqtga ochiladi; xodim tashrifchiga tartibni og‘zaki aytadi.
2. YOLO yuzni topadi. SFace oldindan kiritilgan xodim yuz shablonlari bilan solishtiradi. Xodim aniqlansa, tasvir tashlanadi, tashrif yozuvi va surat saqlanmaydi.
3. Xodim bo‘lmagan yangi tashrifchining surati `.tashrif-data/photos/` papkasiga oddiy JPEG fayl sifatida yoziladi. Ism va kirish vaqti qayd qilinadi.
4. Chiqishda **Yuz orqali chiqishni qayd etish** tugmasi bosiladi. Kadr faol tashrif yozuvlari bilan taqqoslanadi; chiqish vaqti mos tashrifga yoziladi, chiqish kadri esa saqlanmaydi.
5. Yuz mosligi noaniq chiqsa, administrator terminaldagi faol tashriflar ro‘yxatidan chiqishni qo‘lda qayd qiladi.

Xodimlarni **Xodimlar** sahifasida oldindan kiritib, yuz shablonini alohida aniq rozilik bilan yozish kerak. Xodimning kamera surati saqlanmaydi; faqat shifrlangan yuz vektori saqlanadi. Tashrif qaydi barcha ro‘yxatdagi xodimlarga yuz shabloni kiritilgandan keyin ochiladi; aks holda xodim mehmon deb saqlanib qolishi mumkin.

Yangi tashrifchining ismi yuzdan topilmaydi, shu sababli terminalda F.I.Sh. kiritiladi. Administrator panelidan tashrifni qo‘lda kiritish ham mumkin; surat maydoni ixtiyoriy.

## Ma’lumotlar va xavfsizlik

`.tashrif-data/` papkasida:

- `tashrif.sqlite` — tashriflar, xodimlar, terminal tokenlari va audit yozuvlari
- `photos/*.jpg` — shifrlanmagan tashrif suratlari
- `storage.key` — ism, matnli maydonlar va yuz vektorlarini shifrlash kaliti
- `ai-models/` va `ai-venv/` — lokal AI modellari va ish muhiti
- HTTPS sertifikatlari va kalitlari

Yangi tashrif suratlari diskda shifrlanmaydi. Noutbukdagi Windows hisobiga kirish huquqini cheklang va zaxira nusхalarni himoyalangan joyda saqlang. Oldingi versiyadan qolgan AES-GCM suratlar server ishga tushganda oddiy JPEG formatiga ko‘chiriladi.

Lokal kadr tahlili institut noutbukida bajariladi. Kamera tasviri HTTPS orqali lokal serverga uzatiladi. Administrator paroli xeshlanadi, terminal tokeni serverda xesh ko‘rinishida saqlanadi. Chiqish kadri diskka yozilmaydi.

## Cheklovlar

- Yuz taqqoslash aniqligi yorug‘lik, kamera burchagi va tasvir sifatiga bog‘liq. Moslik noaniq bo‘lsa, administrator qo‘lda yakunlaydi.
- Xodim va tashrifchi yuzlarini o‘xshashlik asosida ajratish xatoga yo‘l qo‘yishi mumkin; shablonlarni to‘g‘ri kiritish muhim.
- my.gov.uz integratsiyasi ruxsat berilgandan keyin alohida ulanadi.

