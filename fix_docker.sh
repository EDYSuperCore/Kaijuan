#!/bin/bash
# 修复 Docker Compose ContainerConfig 错误的脚本

set -e

echo "=== 步骤 1: 停止并删除容器 ==="
sudo docker-compose down -v || true

echo ""
echo "=== 步骤 2: 删除可能损坏的容器 ==="
sudo docker rm -f kaijuan_kaijuan_1 2>/dev/null || echo "容器不存在"

echo ""
echo "=== 步骤 3: 重新构建镜像（不使用缓存）==="
sudo docker-compose build --no-cache

echo ""
echo "=== 步骤 4: 启动服务 ==="
sudo docker-compose up -d

echo ""
echo "=== 步骤 5: 查看容器状态 ==="
sudo docker-compose ps

echo ""
echo "=== 完成！查看日志: sudo docker-compose logs -f kaijuan ==="
