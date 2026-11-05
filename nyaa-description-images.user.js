// ==UserScript==
// @name         Sukebei Nyaa 描述图片预览
// @namespace    nyaa-description-images
// @version      1.4.0
// @description  描述图片预览与失败回退，列表详情链接在新标签页打开。
// @match        https://sukebei.nyaa.si/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      imagetwist.com
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    const PREFIX = '[NyaaImages]';
    const startedAt = performance.now();
    const records = [];
    const processed = new WeakMap();
    const statusIcons = new WeakMap();
    let nextId = 0;
    let lastDescription = null;
    let scanTimer;
    let missingReported = false;
    const stats = { scans: 0, candidates: 0, skipped: 0, loading: 0, loaded: 0, failed: 0, listLinks: 0 };

    const style = document.createElement('style');
    style.textContent = `
        @keyframes nyaa-images-spin { to { transform: rotate(360deg); } }
        .nyaa-images-status {
            display: inline-block;
            width: 14px;
            height: 14px;
            margin-right: 6px;
            vertical-align: -2px;
            box-sizing: border-box;
        }
        .nyaa-images-loading {
            border: 2px solid #b8c7d6;
            border-top-color: #337ab7;
            border-radius: 50%;
            animation: nyaa-images-spin .8s linear infinite;
        }
        .nyaa-images-error {
            border-radius: 50%;
            background: #b45309;
            color: #fff;
            font: bold 12px/14px Arial, sans-serif;
            text-align: center;
        }
    `;
    (document.head || document.documentElement).appendChild(style);

    function log(level, stage, details = {}) {
        const entry = {
            time: new Date().toISOString(),
            elapsedMs: Math.round(performance.now() - startedAt),
            stage,
            ...details,
        };
        records.push(entry);
        // 动态页面长期打开时限制日志缓存大小，控制台仍输出全部事件。
        if (records.length > 2000) records.shift();
        console[level](`${PREFIX} ${stage}`, entry);
    }

    // 在控制台执行 NyaaImagesDebug.snapshot() 获取可复制的诊断信息。
    const debug = {
        logs: records,
        stats,
        scan: () => scan('manual'),
        snapshot: () => JSON.stringify({
            version: '1.4.0', url: location.href, readyState: document.readyState,
            descriptionFound: !!document.getElementById('torrent-description'),
            stats, logs: records,
        }, null, 2),
    };
    window.NyaaImagesDebug = debug;
    if (typeof unsafeWindow !== 'undefined') unsafeWindow.NyaaImagesDebug = debug;

    log('info', '启动', {
        version: '1.4.0', url: location.href, readyState: document.readyState,
        selector: '#torrent-description', userAgent: navigator.userAgent,
        crossOriginRequestAvailable: typeof GM_xmlhttpRequest === 'function',
    });

    function resolveImageTwist(url, id) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest 不可用，请完整更新脚本（包括头部 @grant 和 @connect）'));
                return;
            }
            log('info', '请求 ImageTwist 展示页', { id, url: url.href, timeoutMs: 15000 });
            GM_xmlhttpRequest({
                method: 'GET', url: url.href, timeout: 15000, anonymous: true,
                onload(response) {
                    try {
                        const contentType = /^content-type:\s*(.+)$/im.exec(response.responseHeaders || '')?.[1]?.trim();
                        log('info', 'ImageTwist 展示页响应', {
                            id, status: response.status, contentType,
                            finalUrl: response.finalUrl, length: response.responseText?.length,
                        });
                        if (response.status < 200 || response.status >= 300) {
                            throw new Error(`展示页 HTTP ${response.status}`);
                        }
                        // 仅解析 HTML，不执行图床页面的脚本，也不插入其页面内容。
                        const page = new DOMParser().parseFromString(response.responseText, 'text/html');
                        const selectors = ['img.pic[src]', 'a[data-fancybox="gallery"][href]', 'a[download][href]'];
                        for (const selector of selectors) {
                            for (const node of page.querySelectorAll(selector)) {
                                const value = node.getAttribute(node.tagName === 'IMG' ? 'src' : 'href');
                                if (!value) continue;
                                const candidate = new URL(value, response.finalUrl || url.href);
                                // 只接受 ImageTwist 图片服务器的原图路径，避免选到广告或缩略图。
                                if (candidate.protocol !== 'https:' ||
                                    !(candidate.hostname === 'imagetwist.com' || candidate.hostname.endsWith('.imagetwist.com')) ||
                                    !candidate.pathname.startsWith('/i/')) {
                                    log('info', '跳过原图候选地址', {
                                        id, selector, candidateUrl: candidate.href,
                                        reason: '需要 HTTPS、imagetwist.com 或其子域名及 /i/ 原图路径',
                                    });
                                    continue;
                                }
                                log('info', '解析到真实图片地址', { id, selector, imageUrl: candidate.href });
                                resolve(candidate.href);
                                return;
                            }
                        }
                        throw new Error('展示页没有找到原图，可能是图片已删除、验证页面或图床结构变化');
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror: () => reject(new Error('展示页跨域请求失败，请检查网络或油猴域名授权')),
                ontimeout: () => reject(new Error('展示页请求超过 15 秒')),
                onabort: () => reject(new Error('展示页请求被取消')),
            });
        });
    }

    document.addEventListener('securitypolicyviolation', (event) => {
        if (!event.effectiveDirective.startsWith('img-src')) return;
        log('warn', '页面 CSP 图片策略事件（可能与本脚本图片请求有关）', {
            blockedURI: event.blockedURI, directive: event.effectiveDirective,
            policy: event.originalPolicy, disposition: event.disposition,
        });
    });

    function processLink(link, index) {
        const rawHref = link.getAttribute('href');
        if (processed.get(link) === rawHref) return;
        statusIcons.get(link)?.remove();
        statusIcons.delete(link);
        processed.set(link, rawHref);
        const id = ++nextId;
        stats.candidates++;
        log('info', '检查链接', { id, index, rawHref, text: link.textContent.trim() });

        function skip(reason) {
            stats.skipped++;
            log('info', '跳过链接', { id, reason, rawHref });
        }

        let url;
        try {
            url = new URL(link.href, location.href);
        } catch (error) {
            skip(`URL 无法解析：${error.message}`);
            return;
        }
        if (!['https:', 'http:'].includes(url.protocol)) return skip('不是 HTTP/HTTPS 地址');
        if (!/\.(?:jpe?g|png|gif|webp|avif|bmp|svg)$/i.test(url.pathname)) {
            return skip('URL 路径没有支持的图片扩展名');
        }
        if (link.querySelector('img')) return skip('链接内已经有图片');

        // 状态图标放在链接外，保持原链接内容完整。
        const statusIcon = document.createElement('span');
        statusIcon.className = 'nyaa-images-status nyaa-images-loading';
        statusIcon.setAttribute('role', 'img');
        statusIcon.setAttribute('aria-label', '图片加载中');
        statusIcon.title = '正在解析并加载图片…';
        link.before(statusIcon);
        statusIcons.set(link, statusIcon);
        log('info', '显示加载图标', { id });

        const originalContent = Array.from(link.childNodes);
        const image = new Image();
        const requestStartedAt = performance.now();
        let settled = false;
        stats.loading++;
        image.alt = link.textContent.trim() || url.href;
        image.style.display = 'block';
        image.style.maxWidth = '100%';
        image.style.height = 'auto';
        image.style.margin = '8px 0';
        image.style.cursor = 'default';
        image.decoding = 'async';
        image.referrerPolicy = 'no-referrer';

        // 浏览器的图片 error 事件不提供 HTTP 状态码或响应正文。
        function fail(reason) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            stats.loading--;
            stats.failed++;
            // 原链接在加载期间始终存在，不覆盖页面后来更新的内容。
            if (image.parentNode === link) link.replaceChildren(...originalContent);
            if (link.isConnected && link.getAttribute('href') === rawHref && statusIcons.get(link) === statusIcon) {
                statusIcon.className = 'nyaa-images-status nyaa-images-error';
                statusIcon.textContent = '!';
                statusIcon.setAttribute('aria-label', '图片加载失败');
                statusIcon.title = `图片加载失败：${reason}`;
                log('info', '显示失败图标', { id, reason });
            } else {
                statusIcon.remove();
            }
            log('warn', '图片失败，保留原链接', {
                id, url: url.href, reason,
                durationMs: Math.round(performance.now() - requestStartedAt),
                complete: image.complete, naturalWidth: image.naturalWidth,
                currentSrc: image.currentSrc, linkConnected: link.isConnected,
                hint: '在 Network 中按图片 URL 查找请求，检查状态码、Content-Type、重定向及响应；可能返回 HTML 展示页，或被 CSP、防盗链、网络/扩展阻止。',
                stats: { ...stats },
            });
        }

        const timeout = setTimeout(() => {
            fail('解析和加载总计超过 45 秒，已停止本次加载');
            image.removeAttribute('src');
        }, 45000);
        image.addEventListener('load', () => {
            if (settled) return;
            try {
                if (image.naturalWidth <= 0) return fail('收到 load 事件但图片宽度为 0');
                if (!link.isConnected || link.getAttribute('href') !== rawHref ||
                    originalContent.length !== link.childNodes.length ||
                    originalContent.some((node, i) => link.childNodes[i] !== node)) {
                    return fail('加载期间原链接已移除或内容发生变化，取消替换');
                }
                link.replaceChildren(image);
                link.style.cursor = 'default';
                // 在外层链接的捕获阶段拦截，覆盖图片及链接右侧的空白区域。
                link.addEventListener('click', (event) => {
                    if (event.button !== 0 || image.parentNode !== link ||
                        link.getAttribute('href') !== rawHref) return;
                    event.preventDefault();
                    event.stopImmediatePropagation();
                }, true);
                statusIcon.remove();
                if (statusIcons.get(link) === statusIcon) statusIcons.delete(link);
                log('info', '移除加载图标', { id });
                settled = true;
                clearTimeout(timeout);
                stats.loading--;
                stats.loaded++;
                log('info', '图片已显示', {
                    id, url: url.href, currentSrc: image.currentSrc,
                    width: image.naturalWidth, height: image.naturalHeight,
                    durationMs: Math.round(performance.now() - requestStartedAt),
                    stats: { ...stats },
                });
            } catch (error) {
                fail(`替换图片异常：${error.stack || error.message}`);
            }
        }, { once: true });
        image.addEventListener('error', () => fail('浏览器触发图片 error 事件'), { once: true });

        async function startImage() {
            try {
                const isImageTwistPage = ['imagetwist.com', 'www.imagetwist.com'].includes(url.hostname);
                const imageUrl = isImageTwistPage ? await resolveImageTwist(url, id) : url.href;
                if (settled) return;
                log('info', '开始加载图片', {
                    id, originalUrl: url.href, imageUrl,
                    referrerPolicy: image.referrerPolicy, totalTimeoutMs: 45000,
                });
                image.src = imageUrl;
            } catch (error) {
                fail(`解析或请求图片异常：${error.stack || error.message}`);
            }
        }
        void startImage();
    }

    function prepareListLinks(reason) {
        const tables = document.querySelectorAll('table.torrent-list');
        let updated = 0;
        for (const table of tables) {
            for (const link of table.querySelectorAll('tbody a[href]')) {
                try {
                    const url = new URL(link.href, location.href);
                    if (url.origin !== location.origin || !/^\/view\/\d+\/?$/.test(url.pathname)) continue;
                    // 使用浏览器原生新标签页行为，保留 Ctrl/中键及右键菜单操作。
                    const rel = new Set((link.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
                    if (link.getAttribute('target') === '_blank' && rel.has('noopener') && !rel.has('opener')) continue;
                    rel.delete('opener');
                    rel.add('noopener');
                    link.setAttribute('target', '_blank');
                    link.setAttribute('rel', Array.from(rel).join(' '));
                    updated++;
                    stats.listLinks++;
                    log('info', '列表详情链接已设为新标签页打开', { url: url.href });
                } catch (error) {
                    log('error', '处理列表链接异常', { href: link.getAttribute('href'), error: error.stack || error.message });
                }
            }
        }
        if (reason !== 'DOM 更新' || updated) {
            log('info', '列表链接扫描完成', { reason, tables: tables.length, updated });
        }
        return tables.length > 0;
    }

    function scan(reason) {
        try {
            stats.scans++;
            const hasList = prepareListLinks(reason);
            const description = document.getElementById('torrent-description');
            if (!description) {
                if (!missingReported) {
                    log(hasList ? 'info' : 'warn', hasList ? '当前为列表页，无需转换描述图片' : '未找到描述区，等待 DOM 更新', {
                        reason, readyState: document.readyState,
                    });
                    missingReported = true;
                }
                return;
            }
            missingReported = false;
            if (description !== lastDescription) {
                lastDescription = description;
                log('info', '找到描述区', { reason, tagName: description.tagName });
            }
            const links = description.querySelectorAll('a[href]');
            const pending = Array.from(links).filter(link => processed.get(link) !== link.getAttribute('href'));
            if (reason !== 'DOM 更新' || pending.length) {
                log('info', '扫描描述区', { reason, totalLinks: links.length, pendingLinks: pending.length });
            }
            pending.forEach((link, index) => {
                try {
                    processLink(link, index);
                } catch (error) {
                    log('error', '处理链接异常', { href: link.href, error: error.stack || error.message });
                }
            });
        } catch (error) {
            log('error', '扫描异常', { reason, error: error.stack || error.message });
        }
    }

    // 支持脚本启动后才出现的描述区，以及网页动态追加的链接。
    const observer = new MutationObserver(() => {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(() => scan('DOM 更新'), 100);
    });
    observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'id'],
    });
    log('info', 'DOM 监听已启动');
    scan('首次扫描');
    log('info', '初始化完成', { stats: { ...stats }, debug: 'NyaaImagesDebug.snapshot()' });
})();
