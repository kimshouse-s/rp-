import { resolveOpenRouterKey } from './apiKeys';

/**
 * OpenRouter 호출.
 *
 * 브라우저에서 직접 부를 수 있어서 PC 서버가 필요 없다. 폰에서 단독으로 쓰려면 이 경로여야 한다.
 * (Claude 구독 경로는 PC의 개발 서버를 거치므로 배포본에서는 동작하지 않는다.)
 *
 * Claude와 마찬가지로 툴을 선언하지 않는다. 프롬프트가 이미 <mem-update> / <lorebook-update> /
 * <rag-update> / <stat-update> 태그 규약을 설명하고, ChatRoomView의 정규식 폴백이 파싱한다.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export const OPENROUTER_MODELS = [
    { id: 'anthropic/claude-opus-4.5', label: 'Claude Opus 4.5 (가장 강력, 비쌈)' },
    { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5 (균형, 권장)' },
    { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (빠르고 저렴)' },
    { id: 'openai/gpt-4o', label: 'GPT-4o' },
    { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat (매우 저렴)' },
] as const;

export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5';

export interface OpenRouterMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface OpenRouterRequest {
    system: string;
    messages: { role: 'user' | 'assistant'; text: string }[];
    prompt: string;
    model: string;
    temperature?: number;
    topP?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
}

export async function generateWithOpenRouter(request: OpenRouterRequest): Promise<string> {
    const key = resolveOpenRouterKey();
    if (!key) {
        throw new Error('OpenRouter 키가 없습니다. 설정 → 모델 설정 → API 키에서 입력하세요.');
    }

    // 시스템 프롬프트는 매 턴 동일하므로 캐싱 대상이다.
    // Gemini·GPT·DeepSeek 등은 알아서 캐싱하지만, Anthropic 계열은 cache_control 표시가 있어야 한다.
    // 캐시 읽기는 원가의 0.1배라, 이 표시 하나로 반복 요청 비용이 크게 줄어든다.
    // 최소 길이(대략 1024토큰) 미만이면 캐시가 안 잡히지만 그때도 그냥 무시될 뿐 손해는 없다.
    const useCacheControl = request.model.startsWith('anthropic/');
    const systemContent: any = useCacheControl
        ? [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }]
        : request.system;

    const messages: any[] = [
        { role: 'system', content: systemContent },
        ...request.messages.map(m => ({ role: m.role, content: m.text })),
        { role: 'user', content: request.prompt },
    ];

    // OpenRouter는 지원하지 않는 파라미터를 조용히 무시하므로 그대로 넘겨도 안전하다.
    const body: Record<string, unknown> = {
        model: request.model,
        messages,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.presencePenalty) body.presence_penalty = request.presencePenalty;
    if (request.frequencyPenalty) body.frequency_penalty = request.frequencyPenalty;

    let response: Response;
    try {
        response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
                // OpenRouter 순위표에 표시되는 선택 항목. 없어도 동작한다.
                'X-Title': 'RP Messenger',
            },
            body: JSON.stringify(body),
        });
    } catch (e: any) {
        throw new Error(`OpenRouter에 연결하지 못했습니다. 인터넷 연결을 확인하세요. (${e?.message || e})`);
    }

    let payload: any = null;
    try {
        payload = await response.json();
    } catch {
        // 아래에서 상태 코드로 처리한다.
    }

    if (!response.ok) {
        const detail = payload?.error?.message || `HTTP ${response.status}`;
        if (response.status === 401) {
            throw new Error(`OpenRouter 키가 올바르지 않습니다. 설정에서 다시 확인하세요. (${detail})`);
        }
        if (response.status === 402) {
            throw new Error(`OpenRouter 잔액이 부족합니다. (${detail})`);
        }
        if (response.status === 429) {
            throw new Error(`OpenRouter 요청이 너무 잦습니다. 잠시 후 다시 시도하세요. (${detail})`);
        }
        throw new Error(`OpenRouter 오류: ${detail}`);
    }

    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
        throw new Error('OpenRouter 응답 형식이 올바르지 않습니다.');
    }
    return text;
}
