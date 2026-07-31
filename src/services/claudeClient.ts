/**
 * 개발 서버의 /api/chat 을 호출해 Claude로 응답을 생성한다.
 *
 * Claude에는 툴을 선언하지 않는다. 프롬프트가 이미 <mem-update> / <lorebook-update> /
 * <rag-update> 태그 규약을 설명하고 있고, ChatRoomView의 정규식 폴백이 그 태그를 파싱한다.
 * 덕분에 프로바이더별 툴 변환 코드가 필요 없다.
 */

export const CLAUDE_MODELS = [
    { id: 'claude-opus-5', label: 'Claude Opus 5 (가장 강력)' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (균형, 권장)' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (가장 빠름)' },
] as const;

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';

export interface ClaudeChatMessage {
    role: 'user' | 'assistant';
    text: string;
}

export interface ClaudeChatRequest {
    system: string;
    messages: ClaudeChatMessage[];
    prompt: string;
    model: string;
}

export async function generateWithClaude(request: ClaudeChatRequest): Promise<string> {
    let response: Response;
    try {
        response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
        });
    } catch (e: any) {
        throw new Error(
            'Claude 브릿지에 연결하지 못했습니다. 개발 서버(npm run dev)가 켜져 있어야 합니다. '
            + `(${e?.message || e})`
        );
    }

    let payload: any = null;
    try {
        payload = await response.json();
    } catch {
        // 본문이 JSON이 아니면 아래에서 상태 코드로 처리한다.
    }

    if (!response.ok) {
        const detail = payload?.error || `HTTP ${response.status}`;
        throw new Error(payload?.hint ? `${detail}\n${payload.hint}` : detail);
    }

    if (typeof payload?.text !== 'string') {
        throw new Error('Claude 응답 형식이 올바르지 않습니다.');
    }
    return payload.text;
}
