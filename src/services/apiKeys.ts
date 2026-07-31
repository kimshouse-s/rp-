/**
 * API 키 보관.
 *
 * 빌드할 때 코드에 박아 넣는 방식(.env.local)은 로컬에서만 안전하다.
 * 웹사이트로 배포하면 번들에 키가 그대로 들어가 누구나 볼 수 있다.
 * 그래서 앱에서 입력받아 사용자 브라우저에만 저장한다. 서버로는 보내지 않는다.
 *
 * 로컬 개발 편의를 위해 .env.local 값도 계속 지원한다. 앱에 입력한 값이 우선이다.
 */

export interface ApiKeys {
    gemini: string;
    openrouter: string;
}

const STORAGE_KEY = 'apiKeys';
const EMPTY: ApiKeys = { gemini: '', openrouter: '' };

export function loadApiKeys(): ApiKeys {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return { ...EMPTY };
        return { ...EMPTY, ...JSON.parse(saved) };
    } catch (e) {
        console.error('Failed to load API keys', e);
        return { ...EMPTY };
    }
}

export function saveApiKeys(keys: ApiKeys): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            gemini: (keys.gemini ?? '').trim(),
            openrouter: (keys.openrouter ?? '').trim(),
        }));
    } catch (e) {
        console.error('Failed to save API keys', e);
    }
}

/** 빌드 시 주입된 환경변수. 배포본에는 보통 비어 있다. */
const envGeminiKey = (): string => {
    try {
        return process.env.GEMINI_API_KEY || '';
    } catch {
        return '';
    }
};

export function resolveGeminiKey(keys?: ApiKeys): string {
    const stored = (keys ?? loadApiKeys()).gemini.trim();
    return stored || envGeminiKey();
}

export function resolveOpenRouterKey(keys?: ApiKeys): string {
    return (keys ?? loadApiKeys()).openrouter.trim();
}
