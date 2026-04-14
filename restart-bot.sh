#!/bin/bash
# Restart bot nhanh trên VPS (không cần rebuild)
# Chạy từ máy local: bash restart-bot.sh
# Hoặc SSH vào VPS rồi chạy nội dung bên dưới

VPS_IP="14.225.224.8"
VPS_USER="root"
CONTAINER_NAME="brokerai"
APP_DIR="/root/brokerai"

echo "=== Đang khởi động lại Sale Bot trên VPS ==="

ssh -o StrictHostKeyChecking=no $VPS_USER@$VPS_IP << 'EOF'
CONTAINER_NAME="brokerai"
APP_DIR="/root/brokerai"

echo "--- Kiểm tra container hiện tại ---"
docker ps -a | grep $CONTAINER_NAME || echo "(chưa có container)"

# Nếu container đang chạy thì skip
if docker inspect -f '{{.State.Running}}' $CONTAINER_NAME 2>/dev/null | grep -q true; then
  echo "✅ Container đang chạy bình thường!"
  docker ps | grep $CONTAINER_NAME
  exit 0
fi

# Thử start lại container cũ (image vẫn còn)
if docker inspect $CONTAINER_NAME &>/dev/null; then
  echo "--- Container tồn tại nhưng đã dừng, đang start lại... ---"
  docker start $CONTAINER_NAME
  sleep 2
  if docker inspect -f '{{.State.Running}}' $CONTAINER_NAME 2>/dev/null | grep -q true; then
    echo "✅ Bot đã khởi động lại thành công!"
    docker ps | grep $CONTAINER_NAME
    exit 0
  fi
fi

# Nếu không có container hoặc start thất bại → chạy lại từ image
echo "--- Không có container, đang tạo mới từ image... ---"
docker rm $CONTAINER_NAME 2>/dev/null

if docker image inspect brokerai &>/dev/null; then
  docker run -d \
    --name $CONTAINER_NAME \
    --restart always \
    -p 3001:3000 \
    -v /root/brokerai-data/progress:/app/data/progress \
    brokerai
  
  sleep 2
  if docker inspect -f '{{.State.Running}}' $CONTAINER_NAME 2>/dev/null | grep -q true; then
    echo "✅ Bot đã khởi động từ image cũ!"
  else
    echo "❌ Không thể start. Cần rebuild. Chạy: bash deploy.sh"
    docker logs $CONTAINER_NAME --tail 20
  fi
else
  echo "❌ Không có image. Hãy chạy: bash deploy.sh để build lại"
fi

docker ps | grep $CONTAINER_NAME || true
echo ""
echo "Dashboard: http://14.225.224.8:3001"
EOF
