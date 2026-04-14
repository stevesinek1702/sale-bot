#!/bin/bash
# Deploy script cho VPS
# Chạy: bash deploy.sh

VPS_IP="14.225.224.8"
VPS_USER="root"
APP_DIR="/root/brokerai"

echo "=== 1. Copy dự án lên VPS ==="
ssh -o StrictHostKeyChecking=no $VPS_USER@$VPS_IP "rm -rf $APP_DIR && mkdir -p $APP_DIR"

# Copy các file cần thiết (không copy node_modules, .git)
scp -r \
  Dockerfile \
  package.json \
  bun.lock \
  tsconfig.json \
  src/ \
  data/ \
  $VPS_USER@$VPS_IP:$APP_DIR/

echo "=== 2. Cài Docker (nếu chưa có) và build ==="
ssh $VPS_USER@$VPS_IP << 'EOF'
# Cài Docker nếu chưa có
if ! command -v docker &> /dev/null; then
  echo "Đang cài Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

cd /root/brokerai

# Dừng container cũ nếu có
docker stop brokerai 2>/dev/null
docker rm brokerai 2>/dev/null

# Build image
echo "=== Building Docker image ==="
docker build -t brokerai .

# Chạy container
echo "=== Starting container ==="
docker run -d \
  --name brokerai \
  --restart always \
  -p 3001:3000 \
  -v /root/brokerai-data/progress:/app/data/progress \
  brokerai

echo "=== Done! ==="
docker ps | grep brokerai
echo ""
echo "Dashboard: http://14.225.224.8:3001"
EOF
