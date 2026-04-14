@echo off
echo === KHỞI ĐỘNG LẠI SALE BOT TRÊN VPS ===
echo.

echo Đang kết nối VPS 14.225.224.8...
ssh root@14.225.224.8 "CONTAINER_NAME="brokerai"; if docker inspect -f '{{.State.Running}}' $CONTAINER_NAME 2>/dev/null | findstr true >nul; then echo ✅ Bot đang chạy bình thường!; docker ps | findstr $CONTAINER_NAME; else echo ⏳ Container đã dừng, đang start lại...; docker start $CONTAINER_NAME >nul; timeout /t 2 /nobreak >nul; if docker inspect -f '{{.State.Running}}' $CONTAINER_NAME 2>/dev/null | findstr true >nul; then echo ✅ Bot đã khởi động lại THÀNH CÔNG!; echo; docker ps | findstr $CONTAINER_NAME; else echo ❌ Khởi động thất bại, cần chạy deploy.sh; fi; fi; echo; echo 🔗 Dashboard: http://14.225.224.8:3001"

echo.
pause