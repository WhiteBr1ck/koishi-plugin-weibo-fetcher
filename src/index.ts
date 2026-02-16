import { Context, Schema, h, Logger, Time, Bot, sleep } from 'koishi'
import Puppeteer from 'koishi-plugin-puppeteer'

export const name = 'koishi-plugin-weibo-fetcher'
export const inject = {
  required: ['puppeteer', 'database'],
}

const logger = new Logger(name)

// 声明数据库表结构
declare module 'koishi' {
  interface Tables {
    weibo_subscriptions: {
      uid: string
      last_post_url: string
    }
  }
}

const WEIBO_URL_REGEX = /https?:\/\/((m\.)?weibo\.(cn|com))\/(\d+)\/(\w+)/g

function isInvalidRawUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return true
  const value = rawUrl.trim().toLowerCase()
  return !value
    || value === 'false'
    || value === 'true'
    || value === 'null'
    || value === 'undefined'
    || value === '0'
    || value === '#'
    || value.startsWith('javascript:')
    || value.startsWith('data:')
}

function normalizeWeiboUrl(rawUrl: string): string | null {
  if (isInvalidRawUrl(rawUrl)) return null
  try {
    const normalizedRawUrl = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl
    const parsed = new URL(normalizedRawUrl, 'https://weibo.com')
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

export type Config = BaseConfig & SubscriptionConfig

interface BaseConfig {
  cookie: string
  splitMessages: boolean; 
  showScreenshot: boolean
  sendText: boolean
  sendMedia: boolean
  useForward: boolean
  sub_showLink: boolean
  sub_showScreenshot: boolean
  sub_sendText: boolean
  sub_sendMedia: boolean
  sub_useForward: boolean
  logDetails: boolean
}

type SubscriptionConfig = {
  enableSubscription: false
} | {
  enableSubscription: true
  platform: string
  selfId: string
  updateInterval: number
  test_authority: number
  subscriptions: {
    uid: string
    name: string
    channelIds: string[]
  }[]
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    cookie: Schema.string().role('textarea').description('【非必要】微博 Cookie'),
  }).description('基础设置'),

  Schema.object({
    splitMessages: Schema.boolean().description('是否分条发送消息？开启后，文本、截图和每张图片/视频都会作为独立消息发送。').default(false),
    showScreenshot: Schema.boolean().description('是否发送微博截图。').default(true),
    sendText: Schema.boolean().description('是否发送提取的微博文本。').default(true),
    sendMedia: Schema.boolean().description('是否发送微博中的图片和视频。').default(true),
    useForward: Schema.boolean().description('是否使用合并转发的形式发送 (仅 QQ 平台效果最佳)(此选项开启时，“分条发送”将无效)。').default(false),
  }).description('手动解析设置 - 当手动发送链接时生效'),

  Schema.object({
    sub_showLink: Schema.boolean().description('推送时, 是否在消息顶部附带原始微博链接。').default(true),
    sub_showScreenshot: Schema.boolean().description('推送时, 是否发送微博截图。').default(true),
    sub_sendText: Schema.boolean().description('推送时, 是否发送提取的微博文本。').default(true),
    sub_sendMedia: Schema.boolean().description('推送时, 是否发送微博中的图片和视频。').default(true),
    sub_useForward: Schema.boolean().description('推送时, 是否使用合并转发。').default(false),
  }).description('订阅推送内容设置 - 当自动推送订阅时生效'),
  
  Schema.object({
    enableSubscription: Schema.boolean().description('**【总开关】是否启用订阅功能。** 开启后会显示详细设置。').default(false),
  }).description('订阅设置'),

  Schema.union([
    Schema.object({
      enableSubscription: Schema.const(false),
    }),
    Schema.object({
      enableSubscription: Schema.const(true),
      platform: Schema.string().description('用于执行推送的机器人平台 (例如: onebot)。').required(),
      selfId: Schema.string().description('用于执行推送的机器人账号/ID (例如: 12345678)。').required(),
      updateInterval: Schema.number().min(1).description('每隔多少分钟检查一次更新。').default(30),
      test_authority: Schema.number().min(0).description('“测试微博推送”指令的最低权限等级。').default(2),
      subscriptions: Schema.array(Schema.object({
          uid: Schema.string().description('微博用户 UID (纯数字)'),
          name: Schema.string().description('备注名 (仅用于后台显示)'),
          channelIds: Schema.array(String).role('table').description('需要推送的频道/群号列表'),
      })).role('table').description('订阅列表'),
    }),
  ]),

  Schema.object({
    logDetails: Schema.boolean().description('是否在控制台输出详细的调试日志。').default(false),
  }).description('调试设置'),
]) as Schema<Config>


async function getLatestWeiboPostUrlByPuppeteer(ctx: Context, cookie: string, uid: string, log?: (message: string, isWarning?: boolean) => void): Promise<string | null> {
  const userHomepageUrl = `https://weibo.com/u/${uid}`;
  log(`正在访问用户主页 (PC 版): ${userHomepageUrl}`);
  const page = await ctx.puppeteer.page();
  try {
    if (cookie) {
      const cookies = cookie.split(';').map(c => {
        const [name, ...valueParts] = c.trim().split('=');
        return { name, value: valueParts.join('='), domain: '.weibo.com', path: '/' };
      });
      await page.setCookie(...cookies);
    }
    await page.goto(userHomepageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    
    const articleSelector = 'article';
    await page.waitForSelector(articleSelector, { timeout: 20000 });
    
    const latestPostUrl = await page.evaluate((targetUid) => {
      const articles = document.querySelectorAll('article');
      
      for (const article of articles) {
        const isPinned = Boolean(article.querySelector('img[src*="vip_top_default"]')) || (article.textContent?.includes('置顶') ?? false);
        if (isPinned) {
          continue; 
        }
        
        const linkElements = article.querySelectorAll<HTMLAnchorElement>('a[href]');
        for (const linkElement of linkElements) {
          const rawHref = linkElement.getAttribute('href');
          if (!rawHref) continue;
          let postUrl: string | null = null;
          try {
            const normalizedRawHref = rawHref.startsWith('//') ? `https:${rawHref}` : rawHref;
            const parsed = new URL(normalizedRawHref, 'https://weibo.com');
            const match = parsed.pathname.match(/^\/(\d+)\/([A-Za-z0-9]+)/);
            if (!match) continue;
            if (match[1] !== targetUid) continue;
            parsed.hash = '';
            postUrl = parsed.toString();
          } catch {
            postUrl = null;
          }
          if (postUrl) {
            return postUrl;
          }
        }
      }
      return null;
    }, uid);

    if (latestPostUrl) {
      log(`成功获取到最新微博链接: ${latestPostUrl}`);
      return latestPostUrl;
    }
    logger.warn(`[Puppeteer] 在 ${uid} 的主页上未能找到任何符合条件的微博链接.`);
    return null;
  } finally {
    await page.close();
  }
}



async function processWeiboPost(ctx: Context, config: Config, url: string, options: {
  showLink: boolean,
  showScreenshot: boolean,
  sendText: boolean,
  sendMedia: boolean,
}) {
  const log = createLogStepper(`处理:${url}`);
  log(`开始处理微博 (PC 版模式)`);

  const page = await ctx.puppeteer.page();
  
  const result: { textBlock?: h; mediaBlocks: h[] } = {
    mediaBlocks: [],
  };

  try {
    log(`准备访问微博 PC 版页面: ${url}`);
    if (config.cookie) {
      log('检测到 Cookie 已配置，准备注入...');
      const cookies = config.cookie.split(';').map(c => {
        const [name, ...valueParts] = c.trim().split('=');
        return { name, value: valueParts.join('='), domain: '.weibo.com', path: '/' };
      });
      await page.setCookie(...cookies);
      log('Cookie 注入成功。');
    } else {
      log('未配置 Cookie，将以游客身份尝试访问。', true);
    }
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const articleSelector = 'article';
    await page.waitForSelector(articleSelector, { timeout: 20000 });

    const normalizedTargetUrl = normalizeWeiboUrl(url);
    const articleHandle = await page.evaluateHandle((targetUrl) => {
      const articles = Array.from(document.querySelectorAll('article'));
      if (!targetUrl) {
        return articles.find(article => article.querySelector('.wbpro-feed-content')) || articles[0] || null;
      }

      const target = new URL(targetUrl);
      const targetPath = target.pathname;

      for (const article of articles) {
        const links = article.querySelectorAll<HTMLAnchorElement>('a[href]');
        for (const link of links) {
          const rawHref = link.getAttribute('href');
          if (!rawHref) continue;
          let normalizedLink: string | null = null;
          try {
            const normalizedRawHref = rawHref.startsWith('//') ? `https:${rawHref}` : rawHref;
            const parsed = new URL(normalizedRawHref, 'https://weibo.com');
            parsed.hash = '';
            normalizedLink = parsed.toString();
          } catch {
            normalizedLink = null;
          }
          if (!normalizedLink) continue;
          if (new URL(normalizedLink).pathname === targetPath) {
            return article;
          }
        }
      }

      return articles.find(article => article.querySelector('.wbpro-feed-content')) || articles[0] || null;
    }, normalizedTargetUrl);
    const articleElement = articleHandle.asElement();
    if (!articleElement) throw new Error('无法在页面上定位到微博正文元素 (<article>)。');

    if (options.showScreenshot) {
      log('正在生成截图...');
      const screenshotBuffer = await articleElement.screenshot();
      result.mediaBlocks.push(h.image(screenshotBuffer, 'image/png'));
      log('截图成功。');
    }

    const postData = await articleElement.evaluate((article: Element) => {
      const articleEl = article as HTMLElement;

      const authorSpan = articleEl.querySelector('a[href*="/u/"] span[title]') || articleEl.querySelector('a[href*="/u/"] span');
      const author = authorSpan?.getAttribute('title') || authorSpan?.textContent || '未知作者';

      const textEl = articleEl.querySelector('div[class*="_wbtext_"]')
        || articleEl.querySelector('div[class*="wbtext"]')
        || articleEl.querySelector('.wbpro-feed-content');
      const text = textEl ? (textEl as HTMLElement).innerText : '';

      const imageSet = new Set<string>();
      const imageElements = articleEl.querySelectorAll<HTMLImageElement>('img.woo-picture-img, img[class*="focusImg"]');
      for (const img of imageElements) {
        const src = img.currentSrc || img.src || img.getAttribute('src');
        let normalizedSrc: string | null = null;
        if (src) {
          const lower = src.trim().toLowerCase();
          if (lower && lower !== 'false' && lower !== 'true' && lower !== 'null' && lower !== 'undefined' && lower !== '0' && lower !== '#' && !lower.startsWith('javascript:') && !lower.startsWith('data:')) {
            try {
              const normalizedRawUrl = src.startsWith('//') ? `https:${src}` : src;
              normalizedSrc = new URL(normalizedRawUrl, 'https://weibo.com').toString();
            } catch {
              normalizedSrc = null;
            }
          }
        }
        if (normalizedSrc) imageSet.add(normalizedSrc);
      }
      const images = Array.from(imageSet);

      const videoCandidates = new Set<string>();

      const videoElements = articleEl.querySelectorAll<HTMLVideoElement>('video');
      for (const videoElement of videoElements) {
        const rawUrls = [
          videoElement.currentSrc,
          videoElement.src,
          videoElement.getAttribute('src'),
          videoElement.getAttribute('data-src'),
        ];
        for (const rawUrl of rawUrls) {
          if (!rawUrl) continue;
          const lower = rawUrl.trim().toLowerCase();
          if (!lower || lower === 'false' || lower === 'true' || lower === 'null' || lower === 'undefined' || lower === '0' || lower === '#' || lower.startsWith('javascript:') || lower.startsWith('data:')) continue;
          try {
            const normalizedRawUrl = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
            const normalized = new URL(normalizedRawUrl, 'https://weibo.com').toString();
            if (/\.mp4(\?|$)/i.test(normalized) || /f\.video\.weibocdn\.com/i.test(normalized) || /g\.us\.sinaimg\.cn/i.test(normalized)) {
              videoCandidates.add(normalized);
            }
          } catch {}
        }
        const sourceElements = videoElement.querySelectorAll<HTMLSourceElement>('source[src]');
        for (const sourceElement of sourceElements) {
          const rawUrl = sourceElement.getAttribute('src');
          if (!rawUrl) continue;
          const lower = rawUrl.trim().toLowerCase();
          if (!lower || lower === 'false' || lower === 'true' || lower === 'null' || lower === 'undefined' || lower === '0' || lower === '#' || lower.startsWith('javascript:') || lower.startsWith('data:')) continue;
          try {
            const normalizedRawUrl = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
            const normalized = new URL(normalizedRawUrl, 'https://weibo.com').toString();
            if (/\.mp4(\?|$)/i.test(normalized) || /f\.video\.weibocdn\.com/i.test(normalized) || /g\.us\.sinaimg\.cn/i.test(normalized)) {
              videoCandidates.add(normalized);
            }
          } catch {}
        }
      }

      const dataVideoElements = articleEl.querySelectorAll<HTMLElement>('[data-url], [data-src], a[href]');
      for (const element of dataVideoElements) {
        const rawUrls = [
          element.getAttribute('data-url'),
          element.getAttribute('data-src'),
          element.getAttribute('href'),
        ];
        for (const rawUrl of rawUrls) {
          if (!rawUrl) continue;
          const lower = rawUrl.trim().toLowerCase();
          if (!lower || lower === 'false' || lower === 'true' || lower === 'null' || lower === 'undefined' || lower === '0' || lower === '#' || lower.startsWith('javascript:') || lower.startsWith('data:')) continue;
          try {
            const normalizedRawUrl = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
            const normalized = new URL(normalizedRawUrl, 'https://weibo.com').toString();
            if (/\.mp4(\?|$)/i.test(normalized) || /f\.video\.weibocdn\.com/i.test(normalized) || /g\.us\.sinaimg\.cn/i.test(normalized)) {
              videoCandidates.add(normalized);
            }
          } catch {}
        }
      }

      const hasVideoWidget = Boolean(articleEl.querySelector('video, .video-js, [class*="feedVideo"]'));
      const video = Array.from(videoCandidates)[0] || null;
      const hasUnsupportedVideo = hasVideoWidget && !video;
      return {
        author,
        text,
        images,
        video,
        videoCandidates: Array.from(videoCandidates),
        hasUnsupportedVideo,
      };
    });

    await articleHandle.dispose();
    log(`提取到来自 [${postData.author.trim()}] 的文本，${postData.images.length} 张图片，${postData.video ? 1 : 0} 个视频。`);
    if (!postData.video && postData.videoCandidates?.length) {
      log(`检测到 ${postData.videoCandidates.length} 个候选视频链接，但未找到可发送的 MP4 直链。`, true);
      log(`候选链接: ${postData.videoCandidates.slice(0, 3).join(' | ')}`, true);
    }

    let textContent = '';
    if (options.showLink) textContent += `${url}\n\n`;
    if (options.sendText) {
      const authorText = postData.author.trim();
      if (authorText && authorText !== '未知作者') textContent += `✨ 微博用户: ${authorText}\n\n`;
      if (postData.text) textContent += `💡 微博正文: ${postData.text}`;
    }
    if (postData.hasUnsupportedVideo) {
      const notice = `⚠️ 该微博包含直播回放或非直链视频，暂时无法直接转发，请点击原链接观看。\n🔗 ${url}`;
      textContent += textContent.trim() ? `\n\n${notice}` : notice;
    }
    if (textContent.trim()) {
      result.textBlock = h('p', textContent.trim());
    }
    
    if (options.sendMedia) {
      for (const imageUrl of postData.images) {
        try {
          const response = await ctx.http('get', imageUrl, { headers: { 'Referer': 'https://weibo.com/' }, responseType: 'arraybuffer' });
          result.mediaBlocks.push(h.image(response.data, response.headers.get('content-type')));
        } catch (error) {
          log(`下载图片失败: ${imageUrl}, 错误: ${error.message}`, true);
        }
      }
      if (postData.video) {
        try {
          const response = await ctx.http('get', postData.video, { headers: { 'Referer': 'https://weibo.com/' }, responseType: 'arraybuffer' });
          const contentType = response.headers.get('content-type') || '';
          if (!/video\//i.test(contentType) && !/\.mp4(\?|$)/i.test(postData.video)) {
            log(`检测到非直链视频资源，跳过发送: ${postData.video}`, true);
          } else {
            const safeContentType = /video\//i.test(contentType) ? contentType : 'video/mp4';
            result.mediaBlocks.push(h.video(response.data, safeContentType));
          }
        } catch (error) {
          log(`下载视频失败: ${postData.video}, 错误: ${error.message}`, true);
        }
      }
    }
    
    return result;

  } finally {
    await page.close();
  }
}

// 全局变量用于日志记录
let logStepperPrefix = '';
let logStep = 1;
// @ts-ignore
let KOISHI_WEIBO_LOG_DETAILS = false;

function createLogStepper(prefix: string) {
  logStepperPrefix = prefix;
  logStep = 1;
  return (message: string, isWarning = false) => {
    if (KOISHI_WEIBO_LOG_DETAILS) {
      const logMessage = `[${logStepperPrefix}] [步骤 ${logStep++}] ${message}`;
      if (isWarning) logger.warn(logMessage);
      else logger.info(logMessage);
    }
  };
}



export function apply(ctx: Context, config: Config) {
  logger.info('微博 Fetcher (Puppeteer 模式) 插件已启动。');
  KOISHI_WEIBO_LOG_DETAILS = config.logDetails;

  ctx.model.extend('weibo_subscriptions', { uid: 'string', last_post_url: 'string' }, { primary: 'uid' });


  async function sendPost(bot: Bot, channelId: string, postResult: { textBlock?: h; mediaBlocks: h[] }, useForward: boolean, splitMessages: boolean) {
    // 如果使用合并转发，则分条发送无效，直接组合发送
    if (useForward && bot.platform === 'onebot') {
      const elements = [];
      if (postResult.textBlock) elements.push(postResult.textBlock);
      elements.push(...postResult.mediaBlocks);
      if (elements.length > 0) {
        await bot.sendMessage(channelId, h('figure', {}, elements));
      }
      return;
    }

    // 如果开启了分条发送
    if (splitMessages) {
      if (postResult.textBlock) {
        await bot.sendMessage(channelId, postResult.textBlock);
        await sleep(500); // 每条消息之间加一点延迟
      }
      for (const media of postResult.mediaBlocks) {
        await bot.sendMessage(channelId, media);
        await sleep(500);
      }
    } else { // 否则，组合发送
      const elements = [];
      if (postResult.textBlock) elements.push(postResult.textBlock);
      elements.push(...postResult.mediaBlocks);
      if (elements.length > 0) {
        await bot.sendMessage(channelId, elements);
      }
    }
  }

  ctx.middleware(async (session, next) => {
    WEIBO_URL_REGEX.lastIndex = 0;
    const match = WEIBO_URL_REGEX.exec(session.content);
    if (!match) return next();

    const statusMessage = await session.send(h('quote', { id: session.messageId }) + '正在解析微博链接, 请稍候...');
    
    try {
      const postResult = await processWeiboPost(ctx, config, match[0], {
        showLink: false, // 手动解析默认不显示链接
        showScreenshot: config.showScreenshot,
        sendText: config.sendText,
        sendMedia: config.sendMedia,
      });

      if (!postResult.textBlock && postResult.mediaBlocks.length === 0) {
        await session.send('未能获取到任何内容。');
      } else {
        // 调用新的发送函数
        await sendPost(session.bot, session.channelId, postResult, config.useForward, config.splitMessages);
      }

    } catch (error) {
      logger.warn(`[手动解析] 失败:`, error);
      await session.send('解析微博失败，可能是链接已失效或需要有效的 Cookie。');
    } finally {
      if (statusMessage?.[0]) {
        try { await session.bot.deleteMessage(session.channelId, statusMessage[0]) } catch {}
      }
    }
  });

  if (config.enableSubscription) {
    const checkAndPushUpdates = async () => { /* ... 此函数不变 ... */ };

    const forcePushAllSubscriptions = async () => {
      if (!config.enableSubscription) return "订阅功能未开启。";
      const botKey = `${config.platform}:${config.selfId}`;
      const bot = ctx.bots[botKey];
      if (!bot || !bot.online) return `机器人 [${botKey}] 不在线，无法执行推送。`;
      
      let pushCount = 0;
      let failCount = 0;
      for (const sub of config.subscriptions) {
        if (!sub.uid || !sub.channelIds || sub.channelIds.length === 0) continue;
        const log = createLogStepper(`强制推送:${sub.name}(${sub.uid})`);
        log('开始处理...');
        try {
          const latestPostUrl = await getLatestWeiboPostUrlByPuppeteer(ctx, config.cookie, sub.uid, log);
          if (latestPostUrl) {
            log(`获取到最新链接: ${latestPostUrl}, 开始处理内容...`);
            const postResult = await processWeiboPost(ctx, config, latestPostUrl, {
              showLink: config.sub_showLink,
              showScreenshot: config.sub_showScreenshot,
              sendText: config.sub_sendText,
              sendMedia: config.sub_sendMedia,
            });

            log(`内容处理完毕，准备推送到 ${sub.channelIds.length} 个频道...`);
            for (const channelId of sub.channelIds) {
              // 调用新的发送函数，订阅推送时分条发送永远开启，因为内容可能很长
              await sendPost(bot, channelId, postResult, config.sub_useForward, true);
            }
            log(`推送完成。`);
            pushCount++;
          } else {
            log('未能获取到最新链接，跳过。', true);
            failCount++;
          }
        } catch (error) {
          logger.warn(`[强制推送] 处理 [${sub.name}] 时发生错误:`, error);
          failCount++;
        }
        await sleep(5 * Time.second);
      }
      return `强制推送任务完成。成功推送 ${pushCount} 个订阅，失败 ${failCount} 个。`;
    };

    ctx.setInterval(checkAndPushUpdates, config.updateInterval * Time.minute);

    ctx.command('测试微博推送', '强制将所有订阅用户的最新微博推送到目标群组', { 
      authority: config.test_authority,
    })
      .action(async ({ session }) => {
        session.send('收到指令，即将开始为所有订阅强制推送最新内容，这可能需要一段时间，请稍候...');
        const result = await forcePushAllSubscriptions();
        return result;
      });
  }
}
