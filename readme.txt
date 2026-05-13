HƯỚNG DẪN SỬ DỤNG RAKUTEN AUTOMATION (v.js)

1. Cài đặt môi trường:
   - Cài đặt Node.js.
   - Cài đặt các thư viện cần thiết:
     npm install playwright imap mailparser

2. Cấu hình các file đầu vào:

   a. accounts.txt:
      Định dạng: email||mật_khẩu_hiện_tại||mật_khẩu_mới
      Ví dụ: user@example.com||OldPass123||NewPass456
      - Nếu có mật_khẩu_mới, script sẽ thực hiện luồng đổi mật khẩu trước.
      - Nếu không có mật_khẩu_mới, script sẽ đăng nhập bình thường.

   b. hotmail.txt:
      Định dạng 1 (Dùng Microsoft Graph API - Nhanh/Ổn định):
      new_email|password|refresh_token|client_id
      
      Định dạng 2 (Dùng IMAP - Cho các loại mail khác):
      new_email|password
      
      - Script sẽ tự động lấy OTP từ email mới để xác thực đổi email.

   c. proxy.txt (Tùy chọn):
      Định dạng: host:port:user:pass hoặc host:port

3. Luồng hoạt động của script:
   BƯỚC 1: Đổi mật khẩu (nếu có mật khẩu mới trong accounts.txt).
   BƯỚC 2: Kiểm tra điểm (Check-point).
   BƯỚC 3: Đổi email (nếu có email trong hotmail.txt).

4. Cách chạy:
   - Mở terminal tại thư mục dự án.
   - Chạy lệnh: node v.js
   - Làm theo các bước hướng dẫn trên màn hình (Chọn Proxy/ExpressVPN, Hiển thị/Ẩn trình duyệt, Số luồng).

5. Kết quả:
   - point_account.txt: Tài khoản có điểm (kèm thông tin email đã đổi).
   - no_point_account.txt: Tài khoản không có điểm hoặc lỗi.
   - accdie.txt: Tài khoản không đăng nhập được.
   - chaylai.txt: Tài khoản cần chạy lại.

LƯU Ý: 
- Đối với các email dùng IMAP (Gmail, Outlook, Yahoo...), hãy đảm bảo đã bật quyền truy cập IMAP và sử dụng "App Password" nếu có bảo mật 2 lớp.
- Script có hỗ trợ giải Captcha tự động cho luồng đổi mật khẩu.
