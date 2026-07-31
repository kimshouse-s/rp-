import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Claude 구독 인증으로 응답을 생성하는 로컬 엔드포인트.
 *
 * 브라우저에서 Anthropic API를 직접 부를 수 없고(키 노출·CORS), 구독 자격은
 * Claude Agent SDK가 Claude Code와 같은 방식으로 해석한다. 그래서 Vite 개발 서버에
 * 미들웨어를 얹어 POST /api/chat 을 연다. 별도 서버 프로세스가 필요 없고,
 * 같은 네트워크의 폰에서 접속해도 PC의 인증을 그대로 쓴다.
 *
 * 주의: 이 경로는 개발 서버에서만 살아있다. `npm run preview`나 정적 배포에는 없다.
 */

interface ChatMessage {
    role: 'user' | 'assistant';
    text: string;
}

interface ChatRequestBody {
    system?: string;
    messages?: ChatMessage[];
    prompt?: string;
    model?: string;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const readJsonBody = (req: IncomingMessage): Promise<ChatRequestBody> =>
    new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('요청 본문이 너무 큽니다.'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatRequestBody);
            } catch {
                reject(new Error('요청 본문을 JSON으로 읽을 수 없습니다.'));
            }
        });
        req.on('error', reject);
    });

const sendJson = (res: ServerResponse, status: number, payload: unknown) => {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
};

/**
 * 지난 대화를 한 덩어리 사용자 입력으로 접는다.
 * Agent SDK의 query()는 assistant 턴을 직접 주입할 수 없어서, 기록은 맥락으로 넘기고
 * 이번 입력만 실제 질문으로 둔다.
 */
const composePrompt = (messages: ChatMessage[], prompt: string): string => {
    if (messages.length === 0) return prompt;

    const transcript = messages
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
        .join('\n\n');

    return `<conversation_so_far>\n${transcript}\n</conversation_so_far>\n\nUser의 새 입력:\n${prompt}`;
};

const runClaudeQuery = async (body: ChatRequestBody): Promise<string> => {
    // 패키지가 없거나 인증이 없는 환경에서도 개발 서버 자체는 떠야 하므로 지연 로딩한다.
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const prompt = composePrompt(messages, body.prompt ?? '');

    const stream = query({
        prompt,
        options: {
            systemPrompt: body.system ?? '',
            model: body.model,
            // 롤플레이 생성 전용이다. 파일·셸 등 내장 툴을 일절 주지 않는다.
            allowedTools: [],
            // CLAUDE.md와 프로젝트 설정을 읽지 않는다. 코딩 세션이 아니다.
            settingSources: [],
            maxTurns: 1,
        },
    });

    for await (const message of stream) {
        if (message.type !== 'result') continue;

        // subtype이 'success'여도 is_error가 켜질 수 있다. 미로그인 상태가 대표적인데,
        // 이때 result에는 "Not logged in · Please run /login" 같은 안내가 담긴다.
        // 이걸 그대로 돌려주면 앱이 롤플레이 응답으로 오해한다.
        if (message.subtype === 'success' && !message.is_error) return message.result;

        const detail = message.subtype === 'success'
            ? message.result
            : (message.errors?.join(', ') || message.subtype);
        throw new Error(detail || '원인 불명');
    }

    throw new Error('Claude가 응답을 반환하지 않았습니다.');
};

export function claudeBridge(): Plugin {
    return {
        name: 'claude-bridge',
        configureServer(server) {
            server.middlewares.use('/api/chat', async (req, res) => {
                if (req.method !== 'POST') {
                    sendJson(res, 405, { error: 'POST만 지원합니다.' });
                    return;
                }

                try {
                    const body = await readJsonBody(req);
                    const text = await runClaudeQuery(body);
                    sendJson(res, 200, { text });
                } catch (error: any) {
                    const detail = error?.message || String(error);
                    console.error('[claude-bridge]', error);

                    const notLoggedIn = /not logged in|please run \/login/i.test(detail);
                    sendJson(res, 500, {
                        error: `Claude 생성에 실패했습니다: ${detail}`,
                        hint: notLoggedIn
                            ? '터미널에서 claude 를 실행하고 /login 으로 한 번 로그인하세요. 로그인 정보가 디스크에 저장되면 이 기능이 동작합니다.'
                            : '@anthropic-ai/claude-agent-sdk가 설치되어 있는지, 개발 서버가 정상인지 확인하세요.',
                    });
                }
            });
        },
    };
}
