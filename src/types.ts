/**
 * 스와이프 후보 하나. 같은 자리에서 여러 번 생성한 응답을 나란히 두고 고른다.
 * 후보마다 메모리 결과가 다르므로 스냅샷을 함께 들고 있는다.
 */
export interface MessageVariant {
    text: string;
    thinking?: string;
    memoryUpdate?: string;
    ragContext?: string[];
    lorebookContext?: { high: string[], mid: string[], low: string[] };
    memory: MemorySlots;
    timestamp: string;
}

export interface Message {
    id: string;
    text: string;
    sender: 'user' | 'ai';
    timestamp: string;
    thinking?: string;
    memoryUpdate?: string;
    status?: 'edited';
    ragContext?: string[];
    lorebookContext?: { high: string[], mid: string[], low: string[] };
    // 위의 text/thinking/... 은 항상 현재 선택된 후보의 값이다. 렌더링 코드는 그대로 두고,
    // 후보 목록만 아래에 따로 보관한다. 후보가 1개뿐이면 variants는 없을 수 있다.
    variants?: MessageVariant[];
    activeVariant?: number;
}

export type FilterType = 'showThinking' | 'showMemoryUpdates' | 'showInnerThought' | 'showEmotionTags' | 'showSceneHeaders' | 'showNarration';
export type FilterSettings = Record<FilterType, boolean>;

export interface MemorySlots {
    // 1. Core Identity & World
    persona: string;           // Character's core identity, personality, and background
    scenario: string;          // The world setting, current plot, and background context
    
    // 2. User & Relationship
    user_persona: string;      // Information about the user, their appearance, and preferences
    
    // 3. Dynamic Memory
    state: string;             // The dynamic state of the character (mood, relationship, goals)
    short_term_memory: string; // Summary of recent events (before they go to RAG)
    
    // 4. Meta & Planning (Architect)
    planning: string;          // Checklist of tasks for the Architect mode

    // 5. 구조화된 스탯. state가 자유 서술이라면 이쪽은 규칙이 강제되는 수치다.
    //    방마다 정의하며, 정의하지 않으면 스탯 기능 자체가 꺼진다.
    stats?: StatDefinition[];
}

/** 자유 텍스트로 덮어쓸 수 있는 슬롯. stats는 구조화된 배열이라 제외된다. */
export type MemoryTextSlot = Exclude<keyof MemorySlots, 'stats'>;

export const MEMORY_TEXT_SLOTS: MemoryTextSlot[] = [
    'persona', 'scenario', 'user_persona', 'state', 'short_term_memory', 'planning',
];

/** 모델이 category="stats" 같은 걸 보내도 배열 슬롯이 문자열로 덮이지 않게 막는다. */
export const isMemoryTextSlot = (key: string): key is MemoryTextSlot =>
    (MEMORY_TEXT_SLOTS as string[]).includes(key);

/**
 * 스탯 종류.
 *
 * 'persistent' — 호감도·집착도처럼 계속 남는 값. 아무 일이 없으면 기준선으로 서서히 되돌아간다.
 *                감쇠가 없으면 올리기만 하는 방향으로 흘러 결국 최대치에 붙어버린다.
 * 'gauge'      — 인내심·용기처럼 차오르다 임계를 넘으면 한 번 터지고 리셋되는 값.
 *                평소에는 안 드러나던 행동을 그 순간에만 꺼내 쓰기 위한 것이다.
 */
export type StatKind = 'persistent' | 'gauge';

export interface StatDefinition {
    id: string;        // 영문 식별자. 모델이 증감을 지정할 때 쓴다.
    label: string;     // 화면·프롬프트에 보일 이름
    kind: StatKind;
    min: number;
    max: number;
    value: number;
    /** 언제 오르고 내리는지. 프롬프트에 그대로 전달된다. */
    description?: string;

    // --- persistent 전용 ---
    /** 아무 일 없는 턴에 기준선 쪽으로 되돌아가는 양. */
    decayPerTurn?: number;
    /** 되돌아갈 목표값. 없으면 min. */
    baseline?: number;

    // --- gauge 전용 ---
    /** 이 값 이상이면 발현한다. */
    threshold?: number;
    /** 발현 후 되돌아갈 값. 없으면 min. */
    resetTo?: number;
    /** 발현했을 때 무슨 일이 일어나는지. 발현 턴의 프롬프트에 주입된다. */
    triggerEffect?: string;
}

export interface Snapshot {
    messageId: string;
    memory: MemorySlots; 
}

export type ThinkingMode = 'none' | 'simple' | 'deep';
/**
 * 'gemini'     — 브라우저에서 Gemini API를 직접 호출한다. Gemini 키가 필요하다.
 * 'claude'     — 개발 서버의 /api/chat 을 거쳐 Claude 구독 인증으로 생성한다. 키가 필요 없다.
 *                PC의 개발 서버가 있어야 하므로 배포본(폰 단독)에서는 쓸 수 없다.
 * 'openrouter' — 브라우저에서 OpenRouter를 직접 호출한다. 키 하나로 여러 모델을 쓴다.
 *                서버가 필요 없어 폰 단독 사용이 가능하다.
 *
 * 임베딩(RAG·로어북 유사도)은 프로바이더와 무관하게 항상 Gemini를 쓴다. 다른 곳에는 임베딩 API가 없다.
 */
export type ChatProvider = 'gemini' | 'claude' | 'openrouter';
export type ChatMode = 'roleplay' | 'architect'; // New: Chat Mode

export interface ThinkingModeInstructions {
    none: string;
    simple: string;
    deep: string;
}

export interface LorebookEntry {
    id: string;
    keys: string[]; // Keywords that trigger this entry
    regex?: string; // Optional regex for advanced triggering
    embedding?: number[]; // For semantic similarity matching
    content: string; // The actual lore text
    probability: number; // 0-100% chance to trigger
    depth: 'high' | 'mid' | 'low'; // Where to insert in the prompt
    recursable: boolean; // Can this entry trigger other entries?
    // 이 엔트리를 만든 AI 메시지의 id. 해당 메시지가 재생성/삭제되면 함께 사라진다.
    // 값이 없으면 수동 생성으로 간주해 롤백 대상에서 제외한다.
    sourceMessageId?: string;
}

export interface VectorMemoryChunk {
    id: string;
    text: string; // The rephrased, standalone fact
    embedding: number[]; // The vector embedding
    timestamp: number;
    accessCount?: number; // For reinforcement
    lastAccessed?: number; // For decay calculation
    // LorebookEntry.sourceMessageId 와 동일한 규칙.
    sourceMessageId?: string;
}

export interface ChatRoom {
    id:string;
    title: string;
    messages: Message[];
    customPrompt: string; // Deprecated but kept for migration
    roleDefinition?: string; // New: The <role> content
    outputContract?: string; // New: The <output_contract> content
    memory: MemorySlots;
    lorebook?: LorebookEntry[]; // New: Lorebook entries
    vectorMemory?: VectorMemoryChunk[]; // New: RAG memory chunks
    snapshots: Snapshot[];
    temperature: number;
    topP: number;
    presencePenalty?: number; // For DRY emulation
    frequencyPenalty?: number; // For DRY emulation
    xtcThreshold?: number; // Exclude Top Choices (XTC) UI setting
    xtcProbability?: number; // Exclude Top Choices (XTC) UI setting
    thinkingMode: ThinkingMode;
    thinkingModeInstructions: ThinkingModeInstructions;
    mode: ChatMode; // New field
    provider?: ChatProvider; // 없으면 'gemini'
    modelName: string;       // Gemini 모델. provider가 'claude'여도 유지된다(전환 시 복귀용).
    claudeModel?: string;      // Claude 모델. modelName의 Gemini 정규화와 섞이지 않게 분리해 둔다.
    openRouterModel?: string;  // OpenRouter 모델. 같은 이유로 분리.
    ragThreshold?: number; // New field for RAG threshold
    maxContextTurns?: number; // New field for context window limit
    // 로어북 임베딩 유사도 임계값. 0이면 시맨틱 트리거를 끄고 키워드·정규식만 쓴다.
    lorebookThreshold?: number;
    // 한 턴에 프롬프트로 주입할 로어북 엔트리 최대 개수.
    lorebookMaxEntries?: number;
}
