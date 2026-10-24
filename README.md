# Hạ tầng Vĩnh Linh

PWA theo dõi trạm BTS / máy nổ — đồng bộ Firebase Realtime Database với app Android **G Hunter**.

**Không đọc SMS.** Phần giám sát SC/KP chạy trên Android; web chỉ xem danh sách trạm, cảnh báo đang active, cập nhật nhiên liệu và kiểm tra kết nối.

## GitHub Pages

- Site: https://ebacson.github.io/hatangvinhlinh/
- Branch `main`, thư mục gốc `/`

## Tính năng

| Tab | Chức năng |
|-----|-----------|
| **Trạm** | Tìm kiếm, sắp theo dự báo nhiên liệu thấp → cao, mở chi tiết để cập nhật máy nổ / nhiên liệu |
| **Cảnh báo** | 4 loại (Máy nổ, Mất AC, DC thấp, Mất LL); xóa cảnh báo sai / kéo dài |
| **Monitor** | Trạng thái kết nối Firebase, ping thử |

## Cài PWA trên điện thoại

1. Mở https://ebacson.github.io/hatangvinhlinh/ bằng Chrome / Safari  
2. **Thêm vào Màn hình chính** / Install app  

## Firebase

Project: `ghunter-4b0a8` — cùng RTDB với G Hunter (`/stations`).

Nếu trình duyệt bị chặn đọc/ghi, thêm domain `ebacson.github.io` vào Firebase Console → Authentication → Settings → Authorized domains (và kiểm tra RTDB rules).

## Cấu trúc

```
index.html
css/app.css
js/config.js      # Firebase + BASE path GitHub Pages
js/forecast.js
js/app.js
manifest.webmanifest
sw.js
icons/
```

File cũ của repo (điều khoản 8386): `dieu-khoan-8386.html`, `xoso.html`, `app-ads.txt`.
