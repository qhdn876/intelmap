# 只跑 Node，无依赖安装步骤 —— 项目零运行时依赖
FROM node:22-alpine

WORKDIR /app
COPY . .

# 事件库挂在卷上，重建容器不丢历史
VOLUME ["/app/data"]

EXPOSE 8787
ENV HOST=0.0.0.0 PORT=8787
# 用 curl 打健康端点；容器里没有 curl 时用 node 兜底
HEALTHCHECK --interval=2m --timeout=10s --start-period=2m --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/stats').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "--no-warnings", "src/server.mjs"]
