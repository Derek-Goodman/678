# 678 联机

本目录是可直接部署的上线包，由 `_build.js` 生成，不要手改。

```
npm start          # 本地跑，开 http://localhost:3000
```

部署到 Railway：把整个目录推成一个 git 仓库即可。
端口走 `process.env.PORT`（平台强制），已在 server.js 里读了。

## 目录

```
package.json   ← Railway 读这个（有 start 脚本）
server.js
678core.js     ← 服务器和浏览器共用的规则层
public/        ← 游戏本体
```
