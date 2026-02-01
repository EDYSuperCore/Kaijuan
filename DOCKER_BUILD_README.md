# Docker 镜像构建和推送指南

## 快速开始

### 1. 设置环境变量（可选）

```bash
export DOCKER_USERNAME=your-dockerhub-username
export IMAGE_NAME=kaijuan  # 可选，默认为 kaijuan
```

### 2. 运行构建脚本

```bash
./docker-build-push.sh
```

脚本会自动：
- 读取 `app/server/package.json` 中的版本号
- 获取当前 Git SHA 和分支信息
- 构建 Docker 镜像（带 3 个标签：`latest`、`版本号`、`Git SHA`）
- 询问是否推送到 Docker Hub

### 3. 登录 Docker Hub（首次使用）

如果尚未登录，脚本会提示你登录：

```bash
docker login
```

输入你的 Docker Hub 用户名和密码（或访问令牌）。

## 使用方式

### 方式一：交互式（推荐）

直接运行脚本，按提示操作：

```bash
./docker-build-push.sh
```

### 方式二：非交互式（CI/CD）

设置环境变量后，使用 `yes` 自动确认推送：

```bash
export DOCKER_USERNAME=your-username
yes | ./docker-build-push.sh
```

或者修改脚本，移除交互式确认。

## 镜像标签说明

脚本会创建以下标签：

- `latest`: 最新版本（每次构建都会更新）
- `1.6.0`: 版本号标签（从 package.json 读取）
- `abc1234`: Git SHA 短标签（用于精确版本追踪）

## 拉取镜像

构建并推送后，可以从 Docker Hub 拉取：

```bash
# 拉取最新版本
docker pull your-username/kaijuan:latest

# 拉取特定版本
docker pull your-username/kaijuan:1.6.0

# 拉取特定 Git SHA
docker pull your-username/kaijuan:abc1234
```

## 使用 docker-compose

如果使用 docker-compose，可以修改 `docker-compose.yml`：

```yaml
services:
  kaijuan:
    image: your-username/kaijuan:latest  # 或使用特定版本标签
    # ... 其他配置
```

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DOCKER_USERNAME` | Docker Hub 用户名 | 无（必须设置） |
| `IMAGE_NAME` | 镜像名称 | `kaijuan` |
| `DOCKERFILE` | Dockerfile 路径 | `Dockerfile` |

## 故障排查

### 1. 构建失败

- 检查 Dockerfile 是否存在
- 检查网络连接（下载依赖需要）
- 查看错误日志

### 2. 推送失败

- 确认已登录：`docker login`
- 检查镜像名称是否正确
- 确认有推送权限

### 3. 权限问题

如果使用 `sudo`，需要：

```bash
sudo -E ./docker-build-push.sh
```

`-E` 参数会保留环境变量。

## CI/CD 集成示例

### GitHub Actions

```yaml
name: Build and Push Docker Image

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2
      
      - name: Login to Docker Hub
        uses: docker/login-action@v2
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}
      
      - name: Build and push
        run: |
          export DOCKER_USERNAME=${{ secrets.DOCKER_USERNAME }}
          yes | ./docker-build-push.sh
```

## 注意事项

1. **版本号管理**：版本号从 `app/server/package.json` 读取，确保版本号正确
2. **Git 信息**：如果不在 Git 仓库中，Git SHA 会显示为 "unknown"
3. **构建时间**：每次构建都会记录构建时间
4. **镜像大小**：使用 Debian Slim 基础镜像，镜像体积适中

## 相关文件

- `Dockerfile`: Docker 镜像构建文件
- `docker-compose.yml`: 本地开发使用的 Docker Compose 配置
- `.dockerignore`: 构建时忽略的文件列表
