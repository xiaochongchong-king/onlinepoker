# 在线德州扑克（onlinepoker）

真人在线多人德州扑克：WebSocket 房间制，2~6 人同桌对战，服务器权威牌局（防作弊，底牌仅本人可见）。

## 功能

- **登录认证**：固定用户名/口令登录（口令定期轮换，不公开），POST /login 签发令牌，WebSocket 握手级校验，未认证无法进入牌局
- **房间系统**：创建房间得 4 位房间码，好友凭码加入；房主开局
- **完整规则**：标准德州流程（盲注、四轮换注、摊牌、边池、全下亮牌跑马）
- **60 秒行动倒计时**：超时自动过牌/弃牌；掉线自动弃牌，房主自动移交
- **隐私安全**：牌局逻辑全部在服务器执行，每个玩家只收到自己的底牌
- **移动端自适应**：手机竖屏可玩
- 筹码输光可重新买入；支持 2 人单挑（庄家即小盲规则）

## 本地运行

```bash
npm install
npm start          # 默认 3000 端口；PORT 环境变量可改
```

浏览器打开 `http://localhost:3000`，创建房间，把房间码发给好友。

## 部署（2026-09-14 现行架构）

线上固定地址：**https://www.xpoker.top**

```
www.xpoker.top
  → Cloudflare Worker（poker-proxy v2：静态文件内嵌直接应答；/login 与 WebSocket 转发源站）
  → 腾讯云 CloudBase 云托管（上海，容器 0.25核/0.5G，常驻 1 实例，端口 80）
```

- 本仓库 `main` 分支 = 线上代码源头：改动推送到 main 后，从 GitHub 拉取全量代码部署到 CloudBase 编译上线
- Dockerfile：`ENV PORT=80`，`npm ci --omit=dev` + `npm start`
- 历史：曾托管于 Back4app（免费档 URL 频繁过期，已弃用）

## 技术结构

```
server.js          服务器：HTTP 静态页 + WS 同端口、房间管理、权威牌局状态机、倒计时
public/index.html  大厅 + 牌桌页面
public/style.css   牌桌视觉（含移动端适配）
public/client.js   WS 客户端：大厅流程、状态渲染、动作发送、倒计时显示
```

协议：JSON 消息。客户端→服务器：create / join / start / next / rebuy / act；服务器→客户端：state（按玩家定制的视图）/ log / error。
