#!/bin/bash
# Docker 镜像构建和推送脚本
# 自动读取版本号、Git 信息，构建并推送到 Docker Hub

set -e  # 遇到错误立即退出

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 配置
DOCKER_USERNAME="${DOCKER_USERNAME:-}"  # 从环境变量读取，或手动设置
IMAGE_NAME="${IMAGE_NAME:-kaijuan}"     # Docker Hub 镜像名称
DOCKERFILE="${DOCKERFILE:-Dockerfile}"  # Dockerfile 路径

# 检查 Docker Hub 用户名
if [ -z "$DOCKER_USERNAME" ]; then
    echo -e "${YELLOW}警告: DOCKER_USERNAME 环境变量未设置${NC}"
    read -p "请输入 Docker Hub 用户名: " DOCKER_USERNAME
    if [ -z "$DOCKER_USERNAME" ]; then
        echo -e "${RED}错误: Docker Hub 用户名不能为空${NC}"
        exit 1
    fi
fi

# 读取版本号
VERSION=$(node -p "require('./app/server/package.json').version" 2>/dev/null || echo "1.0.0")
echo -e "${GREEN}检测到版本号: ${VERSION}${NC}"

# 获取 Git 信息
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo -e "${GREEN}Git SHA: ${GIT_SHA}${NC}"
echo -e "${GREEN}Git Branch: ${GIT_BRANCH}${NC}"
echo -e "${GREEN}构建时间: ${BUILD_TIME}${NC}"

# 构建镜像标签
FULL_IMAGE_NAME="${DOCKER_USERNAME}/${IMAGE_NAME}"
LATEST_TAG="${FULL_IMAGE_NAME}:latest"
VERSION_TAG="${FULL_IMAGE_NAME}:${VERSION}"
SHA_TAG="${FULL_IMAGE_NAME}:${GIT_SHA}"

echo ""
echo -e "${GREEN}=== 开始构建 Docker 镜像 ===${NC}"
echo -e "镜像名称: ${FULL_IMAGE_NAME}"
echo -e "标签:"
echo -e "  - ${LATEST_TAG}"
echo -e "  - ${VERSION_TAG}"
echo -e "  - ${SHA_TAG}"
echo ""

# 构建镜像（使用 buildx 以获得更好的缓存支持）
echo -e "${YELLOW}正在构建镜像...${NC}"
docker build \
    --build-arg GIT_SHA="${GIT_SHA}" \
    --build-arg BUILD_TIME="${BUILD_TIME}" \
    -t "${LATEST_TAG}" \
    -t "${VERSION_TAG}" \
    -t "${SHA_TAG}" \
    -f "${DOCKERFILE}" \
    .

if [ $? -ne 0 ]; then
    echo -e "${RED}错误: 镜像构建失败${NC}"
    exit 1
fi

echo -e "${GREEN}✓ 镜像构建成功${NC}"

# 询问是否推送到 Docker Hub
echo ""
read -p "是否推送到 Docker Hub? (y/N): " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}跳过推送，镜像已构建完成${NC}"
    echo -e "${GREEN}本地镜像标签:${NC}"
    echo -e "  - ${LATEST_TAG}"
    echo -e "  - ${VERSION_TAG}"
    echo -e "  - ${SHA_TAG}"
    exit 0
fi

# 检查是否已登录 Docker Hub
echo -e "${YELLOW}检查 Docker Hub 登录状态...${NC}"
if ! docker info | grep -q "Username:"; then
    echo -e "${YELLOW}未检测到 Docker Hub 登录，请先登录:${NC}"
    echo -e "  docker login"
    read -p "登录完成后按 Enter 继续..."
fi

# 推送镜像
echo ""
echo -e "${GREEN}=== 开始推送镜像到 Docker Hub ===${NC}"

echo -e "${YELLOW}推送 latest 标签...${NC}"
docker push "${LATEST_TAG}"

echo -e "${YELLOW}推送版本标签 ${VERSION}...${NC}"
docker push "${VERSION_TAG}"

echo -e "${YELLOW}推送 Git SHA 标签 ${GIT_SHA}...${NC}"
docker push "${SHA_TAG}"

echo ""
echo -e "${GREEN}✓ 所有镜像已成功推送到 Docker Hub${NC}"
echo ""
echo -e "${GREEN}镜像地址:${NC}"
echo -e "  https://hub.docker.com/r/${DOCKER_USERNAME}/${IMAGE_NAME}"
echo ""
echo -e "${GREEN}拉取命令:${NC}"
echo -e "  docker pull ${LATEST_TAG}"
echo -e "  docker pull ${VERSION_TAG}"
echo -e "  docker pull ${SHA_TAG}"
