# Hạ tầng Vĩnh Linh

PWA theo dõi trạm BTS / máy nổ — đồng bộ Firebase Realtime Database với app Android **G Hunter**.

**Không đọc SMS.** Giám sát SC/KP chạy trên Android; web dùng để xem trạm, cảnh báo và cập nhật nhiên liệu (sau khi đăng nhập).

## Site

https://ebacson.github.io/hatangvinhlinh/

## Tính năng

| | |
|--|--|
| **Đăng nhập** | Email + mật khẩu (tài khoản tạo trên Firebase Console) |
| **Trạm** | Tìm kiếm, dự báo nhiên liệu, cập nhật máy nổ; hiện *ai cập nhật* và *thời gian* |
| **Cảnh báo** | 4 loại; xóa cảnh báo sai (ghi tên người xóa) |

## Firebase Console (bắt buộc)

1. **Authentication** → Sign-in method → bật **Email/Password**
2. **Authentication** → Settings → Authorized domains → thêm `ebacson.github.io`
3. Realtime Database rules: cho phép đọc/ghi (hoặc siết theo `auth != null` nếu Android cũng dùng Auth)

Khi lưu trạm, web ghi vào `profile`:

- `lastEditedBy` — họ tên
- `lastEditedByUid` — uid
- `lastEditedAt` — timestamp

## Cài PWA

Chrome/Safari → mở site → **Thêm vào Màn hình chính**.
