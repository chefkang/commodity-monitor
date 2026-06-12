# 大宗商品价格日报上线说明

已经支持做成在线网址。当前项目可生成一个纯静态网站目录：`public`。

## 推荐上线方式

### 方式一：Cloudflare Pages

适合长期使用、免费、访问稳定、可绑定自己的域名。

1. 运行 `打包在线版网站.cmd`。
2. 登录 Cloudflare，进入 Pages。
3. 选择 Direct Upload。
4. 上传 `public` 文件夹。
5. 发布后会得到一个网址，所有人都可以打开。

### 方式二：Vercel 或 Netlify

1. 运行 `打包在线版网站.cmd`。
2. 新建项目，上传 `public` 文件夹。
3. 发布后获得在线网址。

### 方式三：公司自己的服务器

把 `public` 文件夹里的所有内容上传到网站目录即可。

## 每天自动更新在线版

当前电脑上的自动化会每天刷新本地数据和看板。要让公网网址也每天自动更新，有两种做法：

- 简单做法：每天刷新后重新运行 `打包在线版网站.cmd`，再上传 `public`。
- 全自动做法：把项目放到 GitHub 仓库，用 GitHub Actions 每天运行采集脚本并发布到 Pages/Cloudflare Pages。这个需要你的 GitHub 或 Cloudflare 授权。

## 入口

- `public/index.html`: 汇报式日报
- `public/trend.html`: 完整趋势看板
