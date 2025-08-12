# Koishi Plugin: Weibo Fetcher

[![npm](https://img.shields.io/npm/v/koishi-plugin-weibo-fetcher?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-weibo-fetcher)
[![LICENSE](https://img.shields.io/npm/l/koishi-plugin-weibo-fetcher?style=flat-square)](https://github.com/WhiteBr1ck/koishi-plugin-weibo-fetcher/blob/main/LICENSE)

> A Koishi plugin to fetch and subscribe to Weibo posts using Puppeteer.
>
> 使用 Puppeteer 解析和订阅微博动态的 Koishi 插件。

## ✨ 功能特性

- **链接解析**: 自动识别聊天中发送的微博链接，并抓取内容进行发送。
- **用户订阅**: 支持配置订阅微博用户，定时检查更新并推送到指定群组。
- **高度可定制**: 提供丰富的配置项，可自定义发送内容的格式、排版及样式。
- **纯粹的 Puppeteer 驱动**: 完全依赖 Puppeteer 进行页面抓取，无需依赖任何第三方 API。
- **健壮的 PC 端模式**: 基于微博 PC 网页版 (`weibo.com`) 进行解析，结构相对稳定。

## 💿 安装

1. **前往 Koishi 插件市场搜索并安装 `weibo-fetcher`。**

2. **安装前置依赖插件:**
   本插件依赖 `database` 和 `puppeteer` 服务。请确保您已至少安装并启用了以下插件：
   - `koishi-plugin-puppeteer`
   - 一款数据库插件 (例如: `koishi-plugin-database-sqlite`)

## 📖 使用与配置

启用插件后，随意发送一个微博链接，插件就会开始自动解析并返回内容。请根据您的需求在插件配置页面进行详细设置。

### 关键配置项说明

- **`cookie`**: 【非必要可选项】微博 Cookie 。
- **`splitMessages` (分条发送)**: 强烈建议开启此项。开启后，文本、截图和每张图片都会作为独立消息发送，可以有效解决因截图或图片过多导致单条消息过大而发送失败的问题。
- **订阅设置**:
  - `uid`: 微博用户的数字 ID，是其主页 URL `weibo.com/u/{uid}` 中的数字部分。
  - `channelIds`: 需要接收推送的群组/频道 ID 列表。
- **`测试微博推送` 指令权限**: 可自定义触发强制推送指令所需的最低权限等级，默认为 2 (管理员)。

### 指令系统

- `测试微博推送`: (需要相应权限) 强制将所有订阅用户的最新微博内容推送到其目标群组，用于调试和效果预览。

## ⚠️ 免责声明

- 本插件仅供学习和技术研究使用，旨在探索 Koishi 插件开发与 Web 数据抓取技术。
- 用户通过本插件获取的所有内容均来自公开的网页来源，插件本身不生产、不存储任何微博内容。所有内容的版权归原作者和微博平台所有。
- 使用本插件产生的任何风险和后果（包括但不限于因频繁请求导致的账号限制）由使用者自行承担。开发者不对任何由此产生的问题负责。
- 请在遵守相关法律法规和网站用户协议的前提下使用本插件。

## 📄 开源许可

This project is licensed under the **MIT License**.

Copyright © 2025 [WhiteBr1ck](https://github.com/WhiteBr1ck)