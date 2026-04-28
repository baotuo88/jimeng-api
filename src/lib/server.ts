import Koa from 'koa';
import KoaRouter from 'koa-router';
import koaRange from 'koa-range';
import koaCors from "koa2-cors";
import koaBody from 'koa-body';
import _ from 'lodash';

import Exception from './exceptions/Exception.ts';
import Request from './request/Request.ts';
import Response from './response/Response.js';
import FailureBody from './response/FailureBody.ts';
import EX from './consts/exceptions.ts';
import logger from './logger.ts';
import config from './config.ts';
import { ensureApiAccess, ensureAdminAuth } from './auth.ts';
import runtimeStore from './runtime-store.ts';

class Server {

    app;
    router;

    constructor() {
        this.app = new Koa();
        this.app.use(koaCors());
        // 范围请求支持
        this.app.use(koaRange);
        this.router = new KoaRouter({ prefix: config.service.urlPrefix });
        // 前置处理异常拦截
        this.app.use(async (ctx: any, next: Function) => {
            if(ctx.request.type === "application/xml" || ctx.request.type === "application/ssml+xml")
                ctx.req.headers["content-type"] = "text/xml";
            try { await next() }
            catch (err) {
                logger.error(err);
                const failureBody = new FailureBody(err);
                new Response(failureBody).injectTo(ctx);
            }
        });
        // 自定义 JSON 解析中间件
        this.app.use(async (ctx: any, next: Function) => {
            if (ctx.is('application/json') && ['POST', 'PUT', 'PATCH'].includes(ctx.method)) {
                logger.debug('开始自定义 JSON 解析');
                const chunks: Buffer[] = [];

                await new Promise((resolve, reject) => {
                    ctx.req.on('data', (chunk: Buffer) => {
                        chunks.push(chunk);
                    });

                    ctx.req.on('end', () => {
                        resolve(null);
                    });

                    ctx.req.on('error', reject);
                });

                const body = Buffer.concat(chunks).toString('utf8');

                // 清理问题字符
                let cleanedBody = body
                    .replace(/\r\n/g, '\n')
                    .replace(/\r/g, '\n')
                    .replace(/\u00A0/g, ' ')
                    .replace(/[\u2000-\u200B]/g, ' ')
                    .replace(/\uFEFF/g, '')
                    .trim();

                // 预先处理尾随逗号问题
                cleanedBody = cleanedBody.replace(/,(\s*[\r\n]*\s*[}\]])/g, '$1');

                // 安全的JSON解析
                let parsedBody;
                try {
                    parsedBody = JSON.parse(cleanedBody);
                } catch (parseError) {
                    logger.error(`JSON解析失败: ${parseError.message}`);
                    logger.debug(`原始请求体: ${body.substring(0, 200)}...`);
                    logger.debug(`清理后请求体: ${cleanedBody.substring(0, 200)}...`);

                    // 尝试修复常见的JSON格式问题
                    let fixedBody = cleanedBody;
                    try {
                        // 修复单引号问题
                        fixedBody = fixedBody.replace(/'/g, '"');
                        // 修复属性名没有引号的问题
                        fixedBody = fixedBody.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
                        // 修复尾随逗号问题 - 更强的正则表达式
                        fixedBody = fixedBody.replace(/,(\s*[\r\n]*\s*[}\]])/g, '$1');
                        // 修复多个连续逗号
                        fixedBody = fixedBody.replace(/,+/g, ',');

                        parsedBody = JSON.parse(fixedBody);
                        logger.debug('JSON修复成功');
                    } catch (fixError) {
                        logger.error(`JSON修复也失败: ${fixError.message}`);
                        logger.debug(`修复后的JSON: ${fixedBody.substring(0, 200)}...`);
                        throw new Error(`无效的JSON格式: ${parseError.message}`);
                    }
                }

                logger.debug('JSON 解析成功，跳过 koa-body');

                ctx.request.body = parsedBody;
                ctx.request.rawBody = cleanedBody;

                // 标记已处理，避免 koa-body 再次处理
                ctx._jsonProcessed = true;
            }
            await next();
        });

        // 载荷解析器支持（只处理未被自定义解析器处理的请求）
        this.app.use(async (ctx: any, next: Function) => {
            if (!ctx._jsonProcessed) {
                await koaBody(Object.assign(_.clone(config.system.requestBody), {
                    multipart: true, // 开启multipart文件上传
                    formidable: {
                        maxFileSize: 100 * 1024 * 1024, // 限制最大100MB
                    },
                    enableTypes: ['json', 'form', 'text', 'xml'] // 确保form类型被启用
                }))(ctx, next);
            } else {
                await next();
            }
        });
        this.app.on("error", (err: any) => {
            // 忽略连接重试、中断、管道、取消错误
            if (["ECONNRESET", "ECONNABORTED", "EPIPE", "ECANCELED"].includes(err.code)) return;
            logger.error(err);
        });
        logger.success("Server initialized");
    }

    /**
     * 附加路由
     *
     * @param routes 路由列表
     */
    attachRoutes(routes: any[]) {
        routes.forEach((route: any) => {
            const prefix = route.prefix || "";
            for (let method in route) {
                if(method === "prefix") continue;
                if (!_.isObject(route[method])) {
                    logger.warn(`Router ${prefix} ${method} invalid`);
                    continue;
                }
                for (let uri in route[method]) {
                    this.router[method](`${prefix}${uri}`, async ctx => {
                        const { request, response } = await this.#requestProcessing(ctx, route[method][uri]);
                        if(response != null && config.system.requestLog) {
                            if (ctx.request.url.endsWith('/ping')) {
                                logger.debug(`<- ${request.method} ${request.url} ${response.time - request.time}ms`);
                            } else {
                                logger.info(`<- ${request.method} ${request.url} ${response.time - request.time}ms`);
                            }
                        }
                    });
                }
            }
            logger.info(`Route ${config.service.urlPrefix || ""}${prefix} attached`);
        });
        this.app.use(this.router.routes());
        this.app.use((ctx: any) => {
            const request = new Request(ctx);
            logger.debug(`-> ${ctx.request.method} ${ctx.request.url} request is not supported - ${request.remoteIP || "unknown"}`);
            // const failureBody = new FailureBody(new Exception(EX.SYSTEM_NOT_ROUTE_MATCHING, "Request is not supported"));
            // const response = new Response(failureBody);
            const message = `[请求有误]: 请检查API文档确认正确的请求路径，当前请求为 ${ctx.request.method} -> ${ctx.request.url} 请纠正`;
            logger.warn(message);
            const failureBody = new FailureBody(new Error(message));
            const response = new Response(failureBody);
            response.injectTo(ctx);
            if(config.system.requestLog)
                logger.info(`<- ${request.method} ${request.url} ${response.time - request.time}ms`);
        });
    }

    /**
     * 请求处理
     *
     * @param ctx 上下文
     * @param routeFn 路由方法
     */
    #requestProcessing(ctx: any, routeFn: Function): Promise<any> {
        return new Promise(resolve => {
            const request = new Request(ctx);
            try {
                if(config.system.requestLog) {
                    if (request.url === '/ping') {
                        logger.debug(`-> ${request.method} ${request.url}`);
                    } else {
                        logger.info(`-> ${request.method} ${request.url}`);
                    }
                }
                ensureApiAccess(request);
                if (request.path.startsWith('/admin') && request.path !== '/admin/bootstrap' && !request.path.startsWith('/page')) {
                    ensureAdminAuth(request);
                }
                routeFn(request)
                .then(response => {
                    try {
                        if(!Response.isInstance(response)) {
                            const _response = new Response(response);
                            _response.injectTo(ctx);
                            this.#finalizeRequestState(request, _response, null);
                            return resolve({ request, response: _response });
                        }
                        response.injectTo(ctx);
                        this.#finalizeRequestState(request, response, null);
                        resolve({ request, response });
                    }
                    catch(err) {
                        logger.error(err);
                        const failureBody = new FailureBody(err);
                        const response = new Response(failureBody);
                        response.injectTo(ctx);
                        this.#finalizeRequestState(request, response, err);
                        resolve({ request, response });
                    }
                })
                .catch(err => {
                    try {
                        logger.error(err);
                        const failureBody = new FailureBody(err);
                        const response = new Response(failureBody);
                        response.injectTo(ctx);
                        this.#finalizeRequestState(request, response, err);
                        resolve({ request, response });
                    }
                    catch(err) {
                        logger.error(err);
                        const failureBody = new FailureBody(err);
                        const response = new Response(failureBody);
                        response.injectTo(ctx);
                        this.#finalizeRequestState(request, response, err);
                        resolve({ request, response });
                    }
                });
            }
            catch(err) {
                logger.error(err);
                const failureBody = new FailureBody(err);
                const response = new Response(failureBody);
                response.injectTo(ctx);
                this.#finalizeRequestState(request, response, err);
                resolve({ request, response });
            }
        });
    }

    #extractResponseCode(response: any): number {
        if (!response) return 0;
        if (response.body && _.isFinite(response.body.code))
            return Number(response.body.code);
        return 0;
    }

    #shouldPenalizeManagedAccount(error: any, response: any): boolean {
        if (!error) return false;
        const errorCode = error?.errcode;
        const errorMessage = String(error?.message || "").toLowerCase();

        if (errorCode === EX.API_REQUEST_PARAMS_INVALID[0]) return false;
        if (errorCode === EX.API_CONTENT_FILTERED[0]) return false;

        if ([
            EX.API_TOKEN_EXPIRES[0],
            EX.API_REQUEST_FAILED[0],
            EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS[0],
        ].includes(errorCode)) return true;

        const responseCode = this.#extractResponseCode(response);
        if ([EX.API_TOKEN_EXPIRES[0], EX.API_REQUEST_FAILED[0], EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS[0]].includes(responseCode))
            return true;

        return [
            "timeout",
            "network",
            "proxy",
            "login",
            "token",
            "积分不足",
            "token已失效",
            "socket hang up",
            "econn",
        ].some(keyword => errorMessage.includes(keyword));
    }

    #finalizeRequestState(request: Request, response: any, error: any) {
        const statusCode = Number(response?.statusCode || 200);
        const responseCode = this.#extractResponseCode(response);
        const ok = !error && statusCode < 400 && responseCode === 0;
        const selectedAccount = request.state.selectedAccount;

        if (selectedAccount?.id && !request.state.accountStateManaged) {
            if (ok) {
                runtimeStore.markAccountSuccess(selectedAccount.id);
            } else if (this.#shouldPenalizeManagedAccount(error, response)) {
                runtimeStore.markAccountFailure(selectedAccount.id, error?.message || response?.body?.message || "unknown error");
            }
        }

        if (request.state.apiKey?.id) {
            runtimeStore.markApiKeyResult(
                request.state.apiKey.id,
                ok,
                ok ? null : (error?.message || response?.body?.message || "unknown error")
            );
        }

        if (request.path === '/ping' || request.path === '/page' || request.path.startsWith('/admin')) return;

        runtimeStore.appendRequestLog({
            method: request.method,
            path: request.path,
            statusCode,
            ok,
            durationMs: Math.max(0, Date.now() - request.time),
            source: request.state.tokenSource || "system",
            accountId: selectedAccount?.id || null,
            accountName: selectedAccount?.name || null,
            apiKeyId: request.state.apiKey?.id || null,
            apiKeyName: request.state.apiKey?.name || null,
            errorMessage: ok ? null : (error?.message || response?.body?.message || null),
        });
    }

    /**
     * 监听端口
     */
    async listen() {
        const host = config.service.host;
        const port = config.service.port;
        await Promise.all([
            new Promise((resolve, reject) => {
                if(host === "0.0.0.0" || host === "localhost" || host === "127.0.0.1")
                    return resolve(null);
                this.app.listen(port, "localhost", err => {
                    if(err) return reject(err);
                    resolve(null);
                });
            }),
            new Promise((resolve, reject) => {
                this.app.listen(port, host, err => {
                    if(err) return reject(err);
                    resolve(null);
                });
            })
        ]);
        logger.success(`Server listening on port ${port} (${host})`);
    }

}

export default new Server();
