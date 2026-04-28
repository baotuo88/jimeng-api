import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import { getTokenLiveStatus, getCredit, receiveCredit, tokenSplit } from '@/api/controllers/core.ts';
import logger from '@/lib/logger.ts';
import runtimeStore from '@/lib/runtime-store.ts';
import { resolveExplicitRequestTokenList, resolveManagedTokenList } from '@/lib/auth.ts';

export default {

    prefix: '/token',

    post: {

        '/check': async (request: Request) => {
            request
                .validate('body.token', _.isString)
            const live = await getTokenLiveStatus(request.body.token);
            return {
                live
            }
        },

        '/points': async (request: Request) => {
            const explicitTokens = resolveExplicitRequestTokenList(request);
            const tokens = explicitTokens.length > 0 ? explicitTokens : resolveManagedTokenList();
            const points = await Promise.all(tokens.map(async (token) => {
                return {
                    token,
                    points: await getCredit(token)
                }
            }))
            return points;
        },

        '/receive': async (request: Request) => {
            const explicitTokens = resolveExplicitRequestTokenList(request);
            const tokens = explicitTokens.length > 0 ? explicitTokens : resolveManagedTokenList();
            const credits = await Promise.all(tokens.map(async (token) => {
                const currentCredit = await getCredit(token);
                if (currentCredit.totalCredit <= 0) {
                    try {
                        await receiveCredit(token);
                        const updatedCredit = await getCredit(token);
                        return {
                            token,
                            credits: updatedCredit,
                            received: true
                        }
                    } catch (err) {
                        logger.warn('收取积分失败:', err);
                        return {
                            token,
                            credits: currentCredit,
                            received: false,
                            error: err.message
                        }
                    }
                }
                return {
                    token,
                    credits: currentCredit,
                    received: false
                }
            }))
            return credits;
        }

    }

}
