import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Chat, Type } from '@google/genai';
import { ChatRoom, Message, MessageVariant, MemorySlots, MemoryTextSlot, isMemoryTextSlot, Snapshot, FilterSettings, FilterType, ThinkingMode, ChatMode, VectorMemoryChunk, LorebookEntry } from '../types';
import { PromptEngine } from '../services/promptEngine';
import { MemoryManager } from '../services/memoryManager';
import { LorebookService } from '../services/lorebookService';
import { RAGService } from '../services/ragService';
import { generateWithClaude, DEFAULT_CLAUDE_MODEL } from '../services/claudeClient';
import { parseStatDeltas, applyStatTurn, formatTriggerNote, resetStatValues } from '../services/statEngine';
import { generateWithOpenRouter, DEFAULT_OPENROUTER_MODEL } from '../services/openRouterClient';
import { ApiKeys } from '../services/apiKeys';
import { BackIcon, MemoryIcon, SettingsIcon, SendIcon } from './Icons';
import { MessageComponent } from './MessageComponent';
import { SettingsModal } from './SettingsModal';
import { MemoryViewerModal } from './MemoryViewerModal';
import { DEFAULT_ROLE_DEFINITION, DEFAULT_OUTPUT_CONTRACT, DEFAULT_THINKING_MODE_INSTRUCTIONS } from '../constants';

const EMPTY_MEMORY: MemorySlots = { persona: '', scenario: '', user_persona: '', state: '', short_term_memory: '', planning: '' };

const FILTER_SETTINGS_KEY = 'filterSettings';

const DEFAULT_FILTER_SETTINGS: FilterSettings = {
    showThinking: false,
    showMemoryUpdates: true,
    showInnerThought: true,
    showEmotionTags: true,
    showSceneHeaders: true,
    showNarration: true,
};

/** 출력 필터는 방이 아니라 보기 설정이므로 전역으로 저장한다. */
const loadFilterSettings = (): FilterSettings => {
    try {
        const saved = localStorage.getItem(FILTER_SETTINGS_KEY);
        if (!saved) return { ...DEFAULT_FILTER_SETTINGS };
        // 저장된 값에 없는 필터가 나중에 추가될 수 있으므로 기본값 위에 덮어쓴다.
        return { ...DEFAULT_FILTER_SETTINGS, ...JSON.parse(saved) };
    } catch (e) {
        console.error('Failed to load filter settings', e);
        return { ...DEFAULT_FILTER_SETTINGS };
    }
};

/**
 * 산출물 출처 키. 스와이프 후보마다 만든 로어북·RAG가 다르므로 후보 번호까지 담는다.
 * 스와이프 도입 전 데이터는 '#번호'가 없는데, 그건 0번 후보로 본다.
 */
const variantKey = (messageId: string, variantIndex: number) => `${messageId}#${variantIndex}`;
const normalizeKey = (key: string) => (key.includes('#') ? key : `${key}#0`);
const messageIdOfKey = (key: string) => key.split('#')[0];

/** 지금 선택된 후보들의 키 집합. */
const activeVariantKeys = (messages: Message[]): Set<string> => {
    const keys = new Set<string>();
    for (const m of messages) {
        if (m.sender !== 'ai') continue;
        keys.add(variantKey(m.id, m.activeVariant ?? 0));
    }
    return keys;
};

/**
 * 재생성·삭제·편집으로 잘려나간 메시지가 만든 로어북/벡터 메모리 항목을 걷어낸다.
 * sourceMessageId가 없는 항목(수동 생성, 캐릭터 카드 임포트 등)은 항상 보존한다.
 */
const pruneBranchArtifacts = (
    messages: Message[],
    lorebook: LorebookEntry[] | undefined,
    vectorMemory: VectorMemoryChunk[] | undefined
): { lorebook: LorebookEntry[], vectorMemory: VectorMemoryChunk[] } => {
    const liveIds = new Set(messages.map(m => m.id));
    const keep = <T extends { sourceMessageId?: string }>(items: T[] | undefined): T[] =>
        (items || []).filter(item => !item.sourceMessageId || liveIds.has(messageIdOfKey(item.sourceMessageId)));
    return { lorebook: keep(lorebook), vectorMemory: keep(vectorMemory) };
};

/**
 * 선택되지 않은 후보가 만든 항목은 프롬프트에 넣지 않는다.
 * 삭제가 아니라 걸러내기만 하므로, 후보를 되돌리면 그 항목도 다시 살아난다.
 */
const selectActiveArtifacts = <T extends { sourceMessageId?: string }>(
    items: T[] | undefined,
    activeKeys: Set<string>
): T[] =>
    (items || []).filter(item => !item.sourceMessageId || activeKeys.has(normalizeKey(item.sourceMessageId)));

/** 후보 하나를 메시지의 표시 필드에 반영한다. 렌더링 코드는 항상 이 필드만 본다. */
const applyVariant = (message: Message, variant: MessageVariant, index: number): Message => ({
    ...message,
    text: variant.text,
    thinking: variant.thinking,
    memoryUpdate: variant.memoryUpdate,
    ragContext: variant.ragContext,
    lorebookContext: variant.lorebookContext,
    activeVariant: index,
});

/** 스와이프 이전에 만들어진 메시지를 후보 0번으로 변환한다. */
const messageToVariant = (message: Message, memory: MemorySlots): MessageVariant => ({
    text: message.text,
    thinking: message.thinking,
    memoryUpdate: message.memoryUpdate,
    ragContext: message.ragContext,
    lorebookContext: message.lorebookContext,
    memory,
    timestamp: message.timestamp,
});

/**
 * 남아있는 메시지에 대응하는 스냅샷만 남기고, 그 시점의 메모리를 돌려준다.
 * 스냅샷이 하나도 안 남으면 대화 시작 전 상태이므로 빈 메모리로 되돌린다.
 */
const rollbackSnapshots = (
    messages: Message[],
    snapshots: Snapshot[] | undefined,
    currentMemory?: MemorySlots
): { snapshots: Snapshot[], memory: MemorySlots } => {
    const liveIds = new Set(messages.map(m => m.id));
    const kept = (snapshots || []).filter(s => liveIds.has(s.messageId));
    if (kept.length > 0) {
        return { snapshots: kept, memory: kept[kept.length - 1].memory };
    }
    // 대화가 통째로 사라진 경우. 스탯 '정의'는 방 설정이므로 유지하고 값만 초기화한다.
    return {
        snapshots: kept,
        memory: { ...EMPTY_MEMORY, stats: resetStatValues(currentMemory?.stats) },
    };
};

const ModeSelector: React.FC<{ currentMode: ChatMode, onChangeMode: (mode: ChatMode) => void }> = ({ currentMode, onChangeMode }) => {
    return (
        <div className="mode-selector">
            <button
                className={`mode-button ${currentMode === 'architect' ? 'active' : ''}`}
                onClick={() => onChangeMode('architect')}
                title="설계 모드: 세계관과 캐릭터를 기획합니다."
            >
                🏗️ 설계
            </button>
            <button
                className={`mode-button ${currentMode === 'roleplay' ? 'active' : ''}`}
                onClick={() => onChangeMode('roleplay')}
                title="연기 모드: 캐릭터가 되어 대화합니다."
            >
                🎭 연기
            </button>
        </div>
    );
};

const ThinkingModeSelector: React.FC<{ currentMode: ThinkingMode, onChangeMode: (mode: ThinkingMode) => void }> = ({ currentMode, onChangeMode }) => {
    const modes: { id: ThinkingMode, label: string }[] = [
        { id: 'none', label: '사고 안함' },
        { id: 'simple', label: '간단한 사고' },
        { id: 'deep', label: '심층 사고' }
    ];

    return (
        <div className="thinking-mode-selector">
            {modes.map(mode => (
                <button
                    key={mode.id}
                    className={`mode-button ${currentMode === mode.id ? 'active' : ''}`}
                    onClick={() => onChangeMode(mode.id)}
                >
                    {mode.label}
                </button>
            ))}
        </div>
    );
};

const ConfirmDeleteModal: React.FC<{ onConfirm: () => void; onCancel: () => void; }> = ({ onConfirm, onCancel }) => (
    <div className="modal-backdrop">
        <div className="modal-content">
            <div className="modal-header">
                <h3>메시지 삭제 확인</h3>
                <button onClick={onCancel} className="close-button">&times;</button>
            </div>
            <div className="modal-body">
                <p>이 메시지와 이후의 모든 메시지를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.</p>
            </div>
            <div className="modal-footer">
                <button onClick={onCancel} className="modal-button secondary">취소</button>
                <button onClick={onConfirm} className="modal-button danger">삭제</button>
            </div>
        </div>
    </div>
);

const FilterButton: React.FC<{ filter: FilterType, isActive: boolean, onClick: (filter: FilterType) => void }> = ({ filter, isActive, onClick }) => {
    const labels: Record<FilterType, string> = {
        showThinking: '사고',
        showMemoryUpdates: '메모리',
        showInnerThought: '독백',
        showEmotionTags: '감정',
        showSceneHeaders: '장면',
        showNarration: '서술',
    };
    return <button className={`filter-button ${isActive ? 'active' : ''}`} onClick={() => onClick(filter)}>{labels[filter]}</button>;
};

interface ChatRoomViewProps {
    chatRoom: ChatRoom;
    onBack: () => void;
    ai: GoogleGenAI | null;
    apiKeys: ApiKeys;
    onApiKeysChange: (keys: ApiKeys) => void;
    setCurrentChatRoom: (updater: (prev: ChatRoom | null) => ChatRoom | null) => void;
}

const PlanningViewer: React.FC<{ memory: MemorySlots }> = ({ memory }) => {
    const hasContent = memory?.scenario || memory?.planning;
    if (!hasContent) return null;
    
    return (
        <div className="planning-viewer">
            <div className="planning-header">
                <h4>📅 서사 설계 (Narrative Design)</h4>
            </div>
            <div className="planning-content">
                {memory.scenario && (
                    <div className="planning-section">
                        <h5>🗺️ 시나리오 (Scenario)</h5>
                        <pre>{memory.scenario}</pre>
                    </div>
                )}
                {memory.planning && (
                    <div className="planning-section">
                        <h5>✅ 체크리스트 (Checklist)</h5>
                        <pre>{memory.planning}</pre>
                    </div>
                )}
            </div>
        </div>
    );
};

export const ChatRoomView: React.FC<ChatRoomViewProps> = ({ chatRoom, onBack, ai, apiKeys, onApiKeysChange, setCurrentChatRoom }) => {
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
    const [isMemoryModalOpen, setIsMemoryModalOpen] = useState(false);
    const [isPlanningOpen, setIsPlanningOpen] = useState(false);
    const [isMobileView, setIsMobileView] = useState(window.innerWidth <= 768);
    const [isFilterOpen, setIsFilterOpen] = useState(false);
    
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    const [editingText, setEditingText] = useState('');
    
    const [memoryJustUpdated, setMemoryJustUpdated] = useState(false);
    const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);

    const [filterSettings, setFilterSettings] = useState<FilterSettings>(loadFilterSettings);

    // 방을 옮기면 컴포넌트가 통째로 리마운트되므로, 필터는 localStorage에 남겨 유지한다.
    useEffect(() => {
        try {
            localStorage.setItem(FILTER_SETTINGS_KEY, JSON.stringify(filterSettings));
        } catch (e) {
            console.error('Failed to save filter settings', e);
        }
    }, [filterSettings]);

    useEffect(() => {
        if (memoryJustUpdated) {
            const timer = setTimeout(() => setMemoryJustUpdated(false), 1500);
            return () => clearTimeout(timer);
        }
    }, [memoryJustUpdated]);

    useEffect(() => {
        const handleResize = () => setIsMobileView(window.innerWidth <= 768);
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatRoom.messages, isLoading]);
    
    const callGeminiApi = useCallback(async (history: { role: string; parts: { text: string; }[]; }[], prompt: string, currentChat: ChatRoom) => {
        const provider = currentChat.provider ?? 'gemini';

        // 다른 프로바이더를 쓰더라도 임베딩은 Gemini를 쓴다. 키가 없으면 임베딩 기능만 조용히 꺼진다.
        if (provider === 'gemini' && !ai) {
            throw new Error("Gemini API 키가 없습니다. 설정 → 모델 설정 → API 키에서 넣거나, 생성 엔진을 다른 것으로 바꾸세요.");
        }

        const contextTurns = currentChat.maxContextTurns || 3;

        // 1. Prepare recent context for scanning (last N messages for Lorebook)
        // 히스토리와 같은 범위를 본다. contextTurns는 '턴' 수이고 한 턴은 유저·AI 두 메시지다.
        const recentMessages = (currentChat.messages || []).slice(-(contextTurns * 2)).map(m => m.text).join('\n') + '\n' + prompt;

        // 로어북 시맨틱 트리거를 켠 방에서만 문맥 임베딩을 만든다. 매 턴 임베딩 호출 한 번을 아낀다.
        const lorebookThreshold = currentChat.lorebookThreshold ?? 0;
        const recentMessagesEmbedding = (ai && lorebookThreshold > 0)
            ? await RAGService.generateEmbedding(ai, recentMessages)
            : undefined;

        // 선택되지 않은 스와이프 후보가 만든 로어북·RAG는 프롬프트에서 제외한다.
        const activeKeys = activeVariantKeys(currentChat.messages || []);
        const visibleLorebook = selectActiveArtifacts(currentChat.lorebook, activeKeys);
        const visibleVectorMemory = selectActiveArtifacts(currentChat.vectorMemory, activeKeys);

        // 2. Scan Lorebook
        const dynamicLorebook = LorebookService.scan(visibleLorebook, recentMessages, recentMessagesEmbedding, {
            semanticThreshold: lorebookThreshold,
            maxEntries: currentChat.lorebookMaxEntries ?? 10,
        });
        
        // 3. Query RAG Memory (Use a more focused query: short term memory + last AI message + current user prompt)
        const lastAiMessage = (currentChat.messages?.length || 0) > 0 && currentChat.messages[(currentChat.messages?.length || 0) - 1].sender === 'ai' 
            ? currentChat.messages[(currentChat.messages?.length || 0) - 1].text 
            : '';
        const ragQueryText = `[Current Context]\n${currentChat.memory?.short_term_memory || ''}\n\n[Recent Dialogue]\nAI: ${lastAiMessage}\nUser: ${prompt}`.trim();
        const { results: ragContext, updatedMemory: touchedChunks } = await RAGService.queryMemory(ai, visibleVectorMemory, ragQueryText, currentChat.ragThreshold ?? 0.55);

        // queryMemory는 넘긴 목록만 돌려준다. 그대로 저장하면 걸러낸 청크가 삭제되므로,
        // 접근 횟수 갱신분만 원본에 덮어쓴다.
        const touchedById = new Map(touchedChunks.map(c => [c.id, c]));
        const updatedVectorMemory = (currentChat.vectorMemory || []).map(c => touchedById.get(c.id) ?? c);

        // 4. Build System Prompt with injected contexts
        const systemInstruction = PromptEngine.buildSystemPrompt(currentChat, dynamicLorebook, ragContext);

        // 4-a. Claude 경로. 툴을 선언하지 않고 태그 규약으로 받는다.
        // processAIResponse의 정규식 폴백이 <mem-update> 등을 그대로 파싱한다.
        if (provider === 'claude') {
            const text = await generateWithClaude({
                system: systemInstruction,
                messages: history.slice(-(contextTurns * 2)).map(h => ({
                    role: h.role === 'user' ? 'user' as const : 'assistant' as const,
                    text: h.parts.map(p => p.text).join('\n'),
                })),
                prompt,
                model: currentChat.claudeModel || DEFAULT_CLAUDE_MODEL,
            });

            return { text, functionCalls: [], ragContext, dynamicLorebook, updatedVectorMemory };
        }

        // 4-b. OpenRouter 경로. 브라우저에서 직접 호출하므로 서버가 필요 없다.
        if (provider === 'openrouter') {
            const text = await generateWithOpenRouter({
                system: systemInstruction,
                messages: history.slice(-(contextTurns * 2)).map(h => ({
                    role: h.role === 'user' ? 'user' as const : 'assistant' as const,
                    text: h.parts.map(p => p.text).join('\n'),
                })),
                prompt,
                model: currentChat.openRouterModel || DEFAULT_OPENROUTER_MODEL,
                temperature: currentChat.temperature,
                topP: currentChat.topP,
                presencePenalty: currentChat.presencePenalty,
                frequencyPenalty: currentChat.frequencyPenalty,
            });

            return { text, functionCalls: [], ragContext, dynamicLorebook, updatedVectorMemory };
        }

        if (!ai) throw new Error("Gemini 클라이언트가 초기화되지 않았습니다.");

        // Runtime validation for model name
        const validModels = ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash-image'];
        let modelToUse = currentChat.modelName;
        if (!validModels.includes(modelToUse)) {
            console.warn(`Invalid model name: ${modelToUse}. Falling back to gemini-3.1-pro-preview.`);
            modelToUse = 'gemini-3.1-pro-preview';
        }

        const chat: Chat = ai.chats.create({
            model: modelToUse,
            history: history.slice(-(contextTurns * 2)), // Dynamic context window based on settings
            config: {
                systemInstruction: systemInstruction,
                temperature: currentChat.temperature,
                topP: currentChat.topP,
                presencePenalty: currentChat.presencePenalty ?? undefined,
                frequencyPenalty: currentChat.frequencyPenalty ?? undefined,
                tools: [{
                    functionDeclarations: [
                        {
                            name: "update_memory",
                            description: "Updates memory slots for state, scenario, tracking, persona etc. when changes happen.",
                            parameters: {
                                type: Type.OBJECT,
                                properties: {
                                    category: { type: Type.STRING, description: "The slot name, e.g. state, short_term_memory, persona, planning, scenario" },
                                    mode: { type: Type.STRING, description: "patch (merge JSON), append (add text), overwrite (replace all)" },
                                    content: { type: Type.STRING, description: "The JSON string or text content for the memory slot" }
                                },
                                required: ["category", "mode", "content"]
                            }
                        },
                        {
                            name: "archive_rag",
                            description: "Archives a completed episodic event or conversation into long-term memory (RAG).",
                            parameters: {
                                type: Type.OBJECT,
                                properties: {
                                    content: { type: Type.STRING, description: "A highly detailed, nuanced record of the concluded event." }
                                },
                                required: ["content"]
                            }
                        },
                        {
                            name: "add_lorebook",
                            description: "Record new named characters, npcs, items or places into the lorebook.",
                            parameters: {
                                type: Type.OBJECT,
                                properties: {
                                    action: { type: Type.STRING, description: "add, update, or delete" },
                                    keys: { type: Type.STRING, description: "comma separated keywords that tag this lore" },
                                    depth: { type: Type.STRING, description: "high, mid, or low importance" },
                                    content: { type: Type.STRING, description: "The detailed textual lore description" }
                                },
                                required: ["action", "keys", "depth", "content"]
                            }
                        }
                    ]
                }]
            },
        });

        let response = await chat.sendMessage({ message: prompt });
        
        let loops = 0;
        let allFunctionCalls: any[] = [];
        let combinedText = response.text || '';
        
        while (response.functionCalls && response.functionCalls.length > 0 && loops < 3) {
            allFunctionCalls = [...allFunctionCalls, ...response.functionCalls];
            const parts = response.functionCalls.map(call => ({
                functionResponse: {
                    name: call.name,
                    response: { result: "Success." }
                }
            }));
            
            response = await chat.sendMessage({ message: parts });
            if (response.text) {
                combinedText += (combinedText ? '\n\n' : '') + response.text;
            }
            loops++;
        }

        return {
            text: combinedText || response.text,
            functionCalls: allFunctionCalls,
            ragContext,
            dynamicLorebook,
            updatedVectorMemory
        };
    }, [ai]);
    
    const processAIResponse = async (text: string | undefined | null, functionCalls: any[] | undefined, currentMemory: MemorySlots, currentLorebook: LorebookEntry[] | undefined, sourceMessageId: string): Promise<{ thinking?: string, memoryUpdate?: string, mainText: string, newMemory: MemorySlots, newLorebook: LorebookEntry[], ragUpdates: string[], error?: string }> => {
        if (!text && (!functionCalls || functionCalls.length === 0)) return { mainText: '', newMemory: currentMemory, newLorebook: currentLorebook || [], ragUpdates: [], error: 'AI 응답이 생성되지 않았습니다.' };

        let responseText = text || '';
        if (typeof responseText !== 'string') {
            responseText = String(responseText);
        }
        let thinking = '';
        
        const thinkingRegex = /<thinking[^>]*>([\s\S]*?)<\/thinking>/gi;
        const thinkingMatches = [...responseText.matchAll(thinkingRegex)];
        if (thinkingMatches.length > 0) {
            thinking = thinkingMatches.map(m => m[1].trim()).join('\n\n---\n\n');
            responseText = responseText.replace(thinkingRegex, '').trim();
        }

        const ragUpdates: string[] = [];
        const ragRegex = /<rag[\s_-]*update[^>]*>([\s\S]*?)<\/rag[\s_-]*update>/gi;
        const ragMatches = [...responseText.matchAll(ragRegex)];
        if (ragMatches.length > 0) {
            ragMatches.forEach(m => ragUpdates.push(m[1].trim()));
            responseText = responseText.replace(ragRegex, '').trim();
        }

        let newMemory: MemorySlots = { persona: '', scenario: '', user_persona: '', state: '', short_term_memory: '', planning: '', ...currentMemory };
        let newLorebook = [...(currentLorebook || [])];
        let logs: string[] = [];

        let currentFunctionCalls = functionCalls ? [...functionCalls] : [];

        // Fallback for models that output tool calls as text tags
        const updateMemoryRegex = /[\[\(]\s*update_memory:\s*category="([^"]+)",\s*mode="([^"]+)",\s*content=({[\s\S]*?}|"[\s\S]*?")\s*[\]\)]/g;
        let updateMatch;
        while ((updateMatch = updateMemoryRegex.exec(responseText)) !== null) {
            let content: any = updateMatch[3];
            if (typeof content === 'string' && content.startsWith('"') && content.endsWith('"')) {
                content = content.slice(1, -1).replace(/\\"/g, '"');
            } else if (typeof content === 'string' && content.startsWith('{') && content.endsWith('}')) {
                try {
                    content = JSON.parse(content);
                } catch (e) {}
            }
            currentFunctionCalls.push({
                name: 'update_memory',
                args: { category: updateMatch[1], mode: updateMatch[2], content: content }
            });
        }
        responseText = responseText.replace(updateMemoryRegex, '').trim();

        // 스탯 증감은 태그로만 받는다. 최종값 계산은 statEngine이 하고 모델은 증감만 제안한다.
        const { deltas: statDeltas, cleanedText: textWithoutStats } = parseStatDeltas(responseText);
        responseText = textWithoutStats;

        const archiveRagRegex = /[\[\(]\s*archive_rag:\s*content=({[\s\S]*?}|"[\s\S]*?")\s*[\]\)]/g;
        let archiveMatch;
        while ((archiveMatch = archiveRagRegex.exec(responseText)) !== null) {
            let content = archiveMatch[1];
            if (typeof content === 'string' && content.startsWith('"') && content.endsWith('"')) {
                content = content.slice(1, -1).replace(/\\"/g, '"');
            }
            currentFunctionCalls.push({
                name: 'archive_rag',
                args: { content: content }
            });
        }
        responseText = responseText.replace(archiveRagRegex, '').trim();

        const addLorebookRegex = /[\[\(]\s*add_lorebook:\s*action="([^"]+)",\s*keys="([^"]+)",\s*content=({[\s\S]*?}|"[\s\S]*?")\s*[\]\)]/g;
        let loreMatch;
        while ((loreMatch = addLorebookRegex.exec(responseText)) !== null) {
            let content = loreMatch[3];
            if (typeof content === 'string' && content.startsWith('"') && content.endsWith('"')) {
                content = content.slice(1, -1).replace(/\\"/g, '"');
            }
            currentFunctionCalls.push({
                name: 'add_lorebook',
                args: { action: loreMatch[1], keys: loreMatch[2], content: content }
            });
        }
        responseText = responseText.replace(addLorebookRegex, '').trim();

        // Apply tool calls
        if (currentFunctionCalls.length > 0) {
            for (const call of currentFunctionCalls) {
                if (call.name === 'update_memory') {
                    const args = call.args || {};
                    const { category, mode, content } = args;
                    // stats는 구조화된 배열이라 자유 텍스트로 덮으면 안 된다. 증감은 <stat-update>로만 받는다.
                    if (category && isMemoryTextSlot(String(category))) {
                        const targetKey = String(category) as MemoryTextSlot;
                        if (mode === 'patch' && (targetKey === 'state' || targetKey === 'persona')) {
                            try {
                                const existingData = newMemory[targetKey] ? JSON.parse(newMemory[targetKey]) : {};
                                const newData = typeof content === 'string' ? JSON.parse(content) : content;
                                newMemory[targetKey] = JSON.stringify({ ...existingData, ...newData }, null, 2);
                                logs.push(`[${category}] Patch updated.`);
                            } catch (e) {
                                newMemory[targetKey] = String(content);
                                logs.push(`[${category}] Raw patched.`);
                            }
                        } else if (mode === 'append') {
                            newMemory[targetKey] = `${newMemory[targetKey]}\n${content}`.trim();
                            logs.push(`[${category}] Appended.`);
                        } else {
                            newMemory[targetKey] = String(content);
                            logs.push(`[${category}] Overwritten.`);
                        }
                    }
                } else if (call.name === 'archive_rag') {
                     const args = call.args || {};
                     if (args.content) ragUpdates.push(String(args.content));
                } else if (call.name === 'add_lorebook') {
                     const args = call.args || {};
                     if (args.action && args.keys) {
                          const actionStr = String(args.action).toLowerCase();
                          const keysArray = Array.isArray(args.keys)
                              ? args.keys.map((k: any) => String(k))
                              : typeof args.keys === 'string'
                                  ? args.keys.split(',').map((k: string) => k.trim()).filter(Boolean)
                                  : [String(args.keys)];

                          if (actionStr === 'delete') {
                              const before = newLorebook.length;
                              newLorebook = MemoryManager.removeLorebookEntries(newLorebook, keysArray);
                              if (newLorebook.length < before) {
                                  logs.push(`[Lorebook] Deleted keys: ${keysArray.join(', ')}`);
                              }
                          } else if ((actionStr === 'add' || actionStr === 'update') && args.content) {
                              // 시맨틱 트리거를 켠 방에서만 임베딩을 만든다. 꺼져 있으면 API 호출을 아낀다.
                              let embedding: number[] | undefined = undefined;
                              if (ai && (chatRoom.lorebookThreshold ?? 0) > 0) {
                                  try {
                                      embedding = await RAGService.generateEmbedding(ai, String(args.content));
                                  } catch (e) {
                                      console.error("Failed to generate embedding for lorebook entry:", e);
                                  }
                              }

                              const result = MemoryManager.upsertLorebookEntry(newLorebook, {
                                  keys: keysArray,
                                  content: String(args.content),
                                  depth: ['high', 'mid', 'low'].includes(String(args.depth)) ? (args.depth as 'high' | 'mid' | 'low') : 'mid',
                                  embedding,
                                  sourceMessageId,
                              });
                              newLorebook = result.lorebook;
                              logs.push(`[Lorebook] ${result.action === 'updated' ? 'Updated' : 'Added'} keys: ${keysArray.join(', ')}`);
                          }
                     }
                }
            }
        }

        // Keep regex fallback for safety in case model ignores tools
        const { newMemory: mem2, newLorebook: lore2, updateLog } = MemoryManager.applyUpdates(newMemory, newLorebook, responseText, sourceMessageId);
        newMemory = mem2;
        newLorebook = lore2;
        if (updateLog) logs.push(updateLog);
        
        const memUpdateRegex = /<mem[\s_-]*update[^>]*>([\s\S]*?)<\/mem[\s_-]*update>/gi;
        responseText = responseText.replace(memUpdateRegex, '').trim();

        const loreUpdateRegex = /<lorebook[\s_-]*update[^>]*>([\s\S]*?)<\/lorebook[\s_-]*update>/gi;
        responseText = responseText.replace(loreUpdateRegex, '').trim();

        // 스탯 적용. 감쇠·상한·발현은 전부 여기서 강제되므로 모델이 규칙을 무시해도 값이 흐르지 않는다.
        if (newMemory.stats?.length) {
            const statResult = applyStatTurn(newMemory.stats, statDeltas);
            newMemory = { ...newMemory, stats: statResult.stats };
            if (statResult.log.length) logs.push(statResult.log.join('\n'));

            // 게이지 발현은 다음 턴 프롬프트가 보도록 단기 기억에 남긴다.
            // 별도 상태 필드를 두지 않아도 스냅샷·롤백에 자동으로 따라간다.
            if (statResult.triggers.length) {
                const notes = statResult.triggers.map(formatTriggerNote).join('\n');
                newMemory = {
                    ...newMemory,
                    short_term_memory: [newMemory.short_term_memory, notes].filter(Boolean).join('\n'),
                };
            }
        }

        // Clean up any empty markdown blocks left behind by tag extraction
        responseText = responseText.replace(/```xml\s*```/gi, '').trim();
        responseText = responseText.replace(/```\s*```/gi, '').trim();

        return { 
            thinking: thinking || undefined, 
            memoryUpdate: logs.length > 0 ? logs.join('\n') : undefined, 
            mainText: responseText,
            newMemory: newMemory,
            newLorebook: newLorebook,
            ragUpdates
        };
    };

    const updateRagMemoryAsync = useCallback((ragUpdates: string[], sourceKey: string) => {
        if (!ragUpdates || ragUpdates.length === 0) return;

        // 임베딩은 유사도 검색을 켠 방에서만 필요하다. 기본값(0)은 최근 것부터 그냥 가져오는
        // 방식이라 임베딩을 쓰지 않는데, 예전에는 그때도 만들어 저장했다.
        // 청크 하나당 숫자 수백 개라 브라우저 저장 용량(약 5MB)을 빠르게 잡아먹었다.
        const needsEmbedding = (chatRoom.ragThreshold ?? 0) > 0;

        setTimeout(async () => {
            try {
                const newChunks: VectorMemoryChunk[] = [];
                for (const fact of ragUpdates) {
                    // 임베딩 생성이 실패해도 기록 자체는 남긴다.
                    // 예전에는 여기서 청크를 통째로 버려서, Gemini 키가 없으면
                    // 장기 기억이 조용히 사라졌다.
                    const embedding = needsEmbedding ? await RAGService.generateEmbedding(ai, fact) : [];
                    newChunks.push({
                        id: `rag_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        text: fact,
                        embedding,
                        timestamp: Date.now(),
                        sourceMessageId: sourceKey
                    });
                }

                if (newChunks.length > 0) {
                    setCurrentChatRoom(prev => {
                        if (!prev) return null;
                        // 임베딩을 만드는 동안 출처 메시지가 삭제됐다면 버린다.
                        if (!prev.messages.some(m => m.id === messageIdOfKey(sourceKey))) return prev;
                        return {
                            ...prev,
                            vectorMemory: [...(prev.vectorMemory || []), ...newChunks]
                        };
                    });
                }
            } catch (e) {
                console.error("Failed to update RAG memory:", e);
            }
        }, 1000);
    }, [ai, chatRoom.ragThreshold]);

    const handleSendMessage = async (e: React.FormEvent) => {
        e.preventDefault();
        const finalInput = input.trim();
        if (!finalInput || isLoading) return;

        setError(null);
        const userMessage: Message = {
            id: `msg_${Date.now()}`,
            text: finalInput,
            sender: 'user',
            timestamp: new Date().toISOString(),
        };

        const updatedMessages = [...chatRoom.messages, userMessage];
        setCurrentChatRoom(prev => ({ ...prev!, messages: updatedMessages }));
        setInput('');
        setIsLoading(true);

        try {
            const contextTurns = chatRoom.maxContextTurns || 3;
            const history = (chatRoom.messages || []).slice(-(contextTurns * 2)).map(msg => ({
                role: msg.sender === 'user' ? 'user' : 'model',
                parts: [{ text: msg.text }],
            }));
            
            // 로어북·RAG 항목에 출처를 남기려면 응답 메시지 id를 먼저 확정해야 한다.
            const aiMessageId = `msg_${Date.now() + 1}`;
            const { text: aiText, functionCalls, ragContext, dynamicLorebook, updatedVectorMemory } = await callGeminiApi(history, finalInput, chatRoom);
            const { thinking, memoryUpdate, mainText, newMemory, newLorebook, ragUpdates, error: processError } = await processAIResponse(aiText, functionCalls, chatRoom.memory, chatRoom.lorebook, variantKey(aiMessageId, 0));

            if(processError) setError(processError);

            const aiMessage: Message = {
                id: aiMessageId,
                text: mainText,
                sender: 'ai',
                timestamp: new Date().toISOString(),
                thinking: thinking,
                memoryUpdate: memoryUpdate,
                ragContext,
                lorebookContext: dynamicLorebook
            };

            setCurrentChatRoom(prev => {
                if (!prev) return null;
                const newSnapshot: Snapshot = { messageId: aiMessage.id, memory: newMemory };
                return {
                    ...prev,
                    messages: [...prev.messages, aiMessage],
                    memory: newMemory,
                    lorebook: newLorebook,
                    snapshots: [...(prev.snapshots || []), newSnapshot],
                    vectorMemory: updatedVectorMemory
                };
            });
            if (memoryUpdate) setMemoryJustUpdated(true);

            // Asynchronously update RAG Memory
            updateRagMemoryAsync(ragUpdates, variantKey(aiMessageId, 0));

        } catch (err: any) {
            let errorMsg = err.message || 'AI 응답을 가져오는 데 실패했습니다.';
            if (errorMsg.includes('429') || errorMsg.includes('quota') || errorMsg.toLowerCase().includes('resource_exhausted')) {
                errorMsg = 'Gemini API 할당량(Quota)을 초과했습니다. 잠시 후 다시 시도하시거나, 상단의 설정(⚙️)에서 모델을 gemini-3-flash-preview 로 변경해 보세요.';
            }
            setError(errorMsg);
        } finally {
            setIsLoading(false);
        }
    };
    
    const handleDeleteMessage = (messageId: string) => setDeletingMessageId(messageId);

    const handleDeleteMessageConfirmed = (messageId: string) => {
        setCurrentChatRoom(prev => {
            if (!prev) return null;
            const messageIndex = prev.messages.findIndex(m => m.id === messageId);
            if (messageIndex === -1) return prev;
            const newMessages = (prev.messages || []).slice(0, messageIndex);
            
            const { snapshots, memory } = rollbackSnapshots(newMessages, prev.snapshots, prev.memory);
            const { lorebook, vectorMemory } = pruneBranchArtifacts(newMessages, prev.lorebook, prev.vectorMemory);

            setMemoryJustUpdated(true);
            return { ...prev, messages: newMessages, memory, snapshots, lorebook, vectorMemory };
        });
        setDeletingMessageId(null);
    };

    const handleRegenerateAIMessage = async (messageId: string) => {
        if (isLoading) return;
        setError(null);
        setIsLoading(true);
        try {
            const messageIndex = chatRoom.messages.findIndex(m => m.id === messageId);
            if (messageIndex < 1 || chatRoom.messages[messageIndex].sender !== 'ai') throw new Error("Cannot regenerate this message.");
            const targetMessage = chatRoom.messages[messageIndex];
            const userMessage = chatRoom.messages[messageIndex - 1];

            const messagesBefore = (chatRoom.messages || []).slice(0, messageIndex - 1);
            let memoryBefore: MemorySlots = { ...EMPTY_MEMORY };
            const lastSnapshot = chatRoom.snapshots.slice().reverse().find(s => messagesBefore.some(m => m.id === s.messageId));
             if (lastSnapshot) {
                memoryBefore = lastSnapshot.memory;
            }

            const history = messagesBefore.map(msg => ({
                role: msg.sender === 'user' ? 'user' : 'model',
                parts: [{ text: msg.text }],
            }));

            // 재생성은 메시지를 갈아치우지 않고 후보를 하나 더 만든다. 메시지 id는 그대로 두고
            // 후보 번호만 늘린다. 기존 메시지에 후보 목록이 없으면 지금 값을 0번 후보로 승격한다.
            const currentMemoryForTarget = chatRoom.snapshots.find(s => s.messageId === messageId)?.memory ?? chatRoom.memory;
            const existingVariants = targetMessage.variants?.length
                ? targetMessage.variants
                : [messageToVariant(targetMessage, currentMemoryForTarget)];
            const newVariantIndex = existingVariants.length;
            const sourceKey = variantKey(messageId, newVariantIndex);

            // 이 메시지 뒤의 대화가 만든 로어북·RAG는 걷어낸다.
            // 이 메시지의 기존 후보가 만든 항목은 지우지 않고, messages를 앞부분만 넘겨
            // selectActiveArtifacts가 프롬프트에서 제외하도록 한다.
            const survivingMessages = (chatRoom.messages || []).slice(0, messageIndex);
            const pruned = pruneBranchArtifacts(survivingMessages, chatRoom.lorebook, chatRoom.vectorMemory);
            const tempChatRoom = {
                ...chatRoom,
                messages: messagesBefore,
                memory: memoryBefore,
                lorebook: pruned.lorebook,
                vectorMemory: pruned.vectorMemory,
            };

            const { text: aiText, functionCalls, ragContext, dynamicLorebook } = await callGeminiApi(history, userMessage.text, tempChatRoom);
            const { thinking, memoryUpdate, mainText, newMemory, newLorebook, ragUpdates, error: processError } = await processAIResponse(aiText, functionCalls, memoryBefore, pruned.lorebook, sourceKey);

            if(processError) setError(processError);

            const newVariant: MessageVariant = {
                text: mainText,
                thinking,
                memoryUpdate,
                ragContext,
                lorebookContext: dynamicLorebook,
                memory: newMemory,
                timestamp: new Date().toISOString(),
            };

            setCurrentChatRoom(prev => {
                if (!prev) return null;
                const variants = [...existingVariants, newVariant];
                const updatedMessage = applyVariant(
                    { ...targetMessage, variants },
                    newVariant,
                    newVariantIndex
                );
                const newMessages = [...(prev.messages || []).slice(0, messageIndex), updatedMessage];
                // 잘려나간 메시지들의 고아 스냅샷과 벡터 메모리를 정리한다.
                const { snapshots } = rollbackSnapshots(newMessages, prev.snapshots, prev.memory);
                const { vectorMemory } = pruneBranchArtifacts(newMessages, prev.lorebook, prev.vectorMemory);
                return {
                    ...prev,
                    messages: newMessages,
                    memory: newMemory,
                    lorebook: newLorebook,
                    vectorMemory,
                    // 같은 메시지의 스냅샷은 자리를 유지한 채 새 후보의 메모리로 바꾼다.
                    snapshots: snapshots.some(s => s.messageId === messageId)
                        ? snapshots.map(s => (s.messageId === messageId ? { messageId, memory: newMemory } : s))
                        : [...snapshots, { messageId, memory: newMemory }],
                };
            });
            if (memoryUpdate) setMemoryJustUpdated(true);

            updateRagMemoryAsync(ragUpdates, sourceKey);
        } catch (err: any) {
            let errorMsg = err.message || 'AI 응답을 다시 생성하는 데 실패했습니다.';
            if (errorMsg.includes('429') || errorMsg.includes('quota') || errorMsg.toLowerCase().includes('resource_exhausted')) {
                errorMsg = 'Gemini API 할당량(Quota)을 초과했습니다. 좀 더 가벼운 gemini-3-flash-preview 모델로 설정을 변경해 보세요.';
            }
            setError(errorMsg);
        } finally {
            setIsLoading(false);
        }
    };
    
    /**
     * 스와이프 후보를 바꾼다. 텍스트와 메모리 스냅샷을 함께 되돌린다.
     * 로어북·RAG는 지우지 않고 selectActiveArtifacts가 걸러내므로 앞뒤로 오가도 복원된다.
     */
    const handleSelectVariant = (messageId: string, index: number) => {
        if (isLoading) return;
        setCurrentChatRoom(prev => {
            if (!prev) return null;
            const msgIndex = prev.messages.findIndex(m => m.id === messageId);
            if (msgIndex === -1) return prev;

            const target = prev.messages[msgIndex];
            const variant = target.variants?.[index];
            if (!variant || index === (target.activeVariant ?? 0)) return prev;

            const newMessages = [...prev.messages];
            newMessages[msgIndex] = applyVariant(target, variant, index);

            return {
                ...prev,
                messages: newMessages,
                memory: variant.memory,
                snapshots: (prev.snapshots || []).map(s =>
                    s.messageId === messageId ? { messageId, memory: variant.memory } : s
                ),
            };
        });
        setMemoryJustUpdated(true);
    };

    const handleStartEditMessage = (message: Message) => {
        setEditingMessageId(message.id);
        setEditingText(message.text);
    };

    const handleSaveEdit = async (messageId: string) => {
        if (isLoading) return;
        const originalMessage = chatRoom.messages.find(m => m.id === messageId);
        if (!originalMessage) return;
        const messageIndex = chatRoom.messages.findIndex(m => m.id === messageId);
        const messagesBefore = (chatRoom.messages || []).slice(0, messageIndex);
        
        let memoryBefore: MemorySlots = { ...EMPTY_MEMORY };
        const prevSnapshot = (chatRoom.snapshots || []).filter(s => messagesBefore.some(m => m.id === s.messageId)).pop();
        if (prevSnapshot) memoryBefore = prevSnapshot.memory;

        handleCancelEdit();
        setError(null);
        setIsLoading(true);
        try {
            if (originalMessage.sender === 'user') {
                const updatedUserMessage: Message = { ...originalMessage, text: editingText, status: 'edited' };
                const newMessagesBase = [...messagesBefore, updatedUserMessage];
                setCurrentChatRoom(prev => ({ ...prev!, messages: newMessagesBase }));
                
                const history = messagesBefore.map(msg => ({ role: msg.sender === 'user' ? 'user' : 'model', parts: [{ text: msg.text }] }));

                // 편집으로 잘려나간 뒷부분이 만든 로어북·RAG를 먼저 걷어낸다.
                const pruned = pruneBranchArtifacts(newMessagesBase, chatRoom.lorebook, chatRoom.vectorMemory);
                const tempChatRoom = { ...chatRoom, memory: memoryBefore, lorebook: pruned.lorebook, vectorMemory: pruned.vectorMemory };

                const aiMessageId = `msg_${Date.now() + 1}`;
                const { text: aiText, functionCalls, ragContext, dynamicLorebook } = await callGeminiApi(history, editingText, tempChatRoom);
                const { thinking, memoryUpdate, mainText, newMemory, newLorebook, ragUpdates, error: processError } = await processAIResponse(aiText, functionCalls, memoryBefore, pruned.lorebook, variantKey(aiMessageId, 0));

                if (processError) setError(processError);

                const aiMessage: Message = { id: aiMessageId, text: mainText, sender: 'ai', timestamp: new Date().toISOString(), thinking, memoryUpdate, ragContext, lorebookContext: dynamicLorebook };

                setCurrentChatRoom(prev => {
                    if (!prev) return null;
                    const newMessages = [...newMessagesBase, aiMessage];
                    const { snapshots } = rollbackSnapshots(newMessages, prev.snapshots, prev.memory);
                    const { vectorMemory } = pruneBranchArtifacts(newMessages, prev.lorebook, prev.vectorMemory);
                    return {
                        ...prev,
                        messages: newMessages,
                        memory: newMemory,
                        lorebook: newLorebook,
                        vectorMemory,
                        snapshots: [...snapshots, { messageId: aiMessage.id, memory: newMemory }],
                    };
                });

                updateRagMemoryAsync(ragUpdates, variantKey(aiMessageId, 0));
            } else {
                 setCurrentChatRoom(prev => {
                    const finalMessages = (prev!.messages || []).map(m => m.id === messageId ? { ...m, text: editingText, status: 'edited' } : m);
                    return { ...prev!, messages: finalMessages };
                });
            }
        } catch (err: any) {
            let errorMsg = err.message || '메시지 수정에 실패했습니다.';
             if (errorMsg.includes('429') || errorMsg.includes('quota') || errorMsg.toLowerCase().includes('resource_exhausted')) {
                errorMsg = 'Gemini API 할당량(Quota)을 초과했습니다. 좀 더 가벼운 gemini-3-flash-preview 모델로 설정을 변경해 보세요.';
            }
            setError(errorMsg);
        } finally {
            setIsLoading(false);
        }
    };
    
    const handleCancelEdit = () => { setEditingMessageId(null); setEditingText(''); };
    const toggleFilter = (filter: FilterType) => setFilterSettings(prev => ({ ...prev, [filter]: !prev[filter] }));
    const applyFilterPreset = (preset: 'all' | 'rp' | 'text') => {
        if (preset === 'all') setFilterSettings({ showThinking: true, showMemoryUpdates: true, showInnerThought: true, showEmotionTags: true, showSceneHeaders: true, showNarration: true });
        else if (preset === 'rp') setFilterSettings({ showThinking: false, showMemoryUpdates: false, showInnerThought: true, showEmotionTags: true, showSceneHeaders: true, showNarration: true });
        else setFilterSettings({ showThinking: false, showMemoryUpdates: false, showInnerThought: false, showEmotionTags: false, showSceneHeaders: false, showNarration: true });
    };

    return (
        <div className="chat-room-view">
             {deletingMessageId && <ConfirmDeleteModal onConfirm={() => handleDeleteMessageConfirmed(deletingMessageId)} onCancel={() => setDeletingMessageId(null)} />}
            {isSettingsModalOpen && <SettingsModal room={chatRoom} onClose={() => setIsSettingsModalOpen(false)} onSave={setCurrentChatRoom} apiKeys={apiKeys} onApiKeysChange={onApiKeysChange} />}
            {isMemoryModalOpen && <MemoryViewerModal memory={chatRoom.memory} onClose={() => setIsMemoryModalOpen(false)} />}
            
            <div className="chat-room-header">
                {isMobileView && <button className="action-button back-button" onClick={onBack}><BackIcon /></button>}
                <div className="header-title-group">
                    <h2 className="chat-room-title">{chatRoom.title}</h2>
                    <ModeSelector currentMode={chatRoom.mode || 'roleplay'} onChangeMode={(mode) => setCurrentChatRoom(prev => prev ? { ...prev, mode } : null)} />
                </div>
                <div className="chat-room-header-actions">
                    <ThinkingModeSelector currentMode={chatRoom.thinkingMode} onChangeMode={(mode) => setCurrentChatRoom(prev => prev ? { ...prev, thinkingMode: mode } : null)} />
                    <div className="header-action-group">
                        <button 
                            className="header-icon-button" 
                            onClick={() => {
                                setCurrentChatRoom(prev => prev ? {
                                    ...prev,
                                    roleDefinition: DEFAULT_ROLE_DEFINITION,
                                    outputContract: DEFAULT_OUTPUT_CONTRACT,
                                    thinkingModeInstructions: DEFAULT_THINKING_MODE_INSTRUCTIONS
                                } : null);
                            }}
                            title="최신 시스템 설정으로 초기화"
                        >
                            🔄
                        </button>
                        <button 
                            className={`header-icon-button ${chatRoom.memory?.planning || chatRoom.memory?.scenario ? 'active' : ''}`} 
                            onClick={() => setIsPlanningOpen(!isPlanningOpen)}
                            title="서사 계획 보기"
                        >
                            📅
                        </button>
                        <button className={`header-icon-button ${memoryJustUpdated ? 'memory-updated-glow' : ''}`} onClick={() => setIsMemoryModalOpen(true)}><MemoryIcon /></button>
                        <button className="header-icon-button" onClick={() => setIsSettingsModalOpen(true)}><SettingsIcon /></button>
                    </div>
                </div>
                {/* 필터는 검수용이라 좁은 화면에서는 접어둔다. 헤더가 화면의 1/4을 먹는 걸 막는다. */}
                {isMobileView && (
                    <button
                        className="filter-disclosure"
                        onClick={() => setIsFilterOpen(v => !v)}
                        aria-expanded={isFilterOpen}
                    >
                        {isFilterOpen ? '▲ 출력 필터 접기' : '▼ 출력 필터'}
                    </button>
                )}
                {(!isMobileView || isFilterOpen) && (
                    <div className="filter-controls">
                         <div className="filter-toggle-group">
                             {(Object.keys(filterSettings) as FilterType[]).map((key) => <FilterButton key={key} filter={key} isActive={filterSettings[key]} onClick={toggleFilter} />)}
                        </div>
                        <div className="preset-buttons">
                            <button className="preset-button" onClick={() => applyFilterPreset('all')}>모두</button>
                            <button className="preset-button" onClick={() => applyFilterPreset('rp')}>역할극</button>
                            <button className="preset-button" onClick={() => applyFilterPreset('text')}>텍스트</button>
                        </div>
                    </div>
                )}
            </div>

            {isPlanningOpen && (chatRoom.memory?.planning || chatRoom.memory?.scenario) && (
                <div className="planning-panel-container">
                    <PlanningViewer memory={chatRoom.memory} />
                </div>
            )}

            <div className="message-list">
                {(chatRoom.messages?.length || 0) === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-center p-8 text-gray-400">
                        <div className="w-16 h-16 bg-gray-800 rounded-full flex items-center justify-center mb-4">
                            <span className="text-2xl">✨</span>
                        </div>
                        <h3 className="text-xl font-medium text-gray-200 mb-2">첫 메시지를 입력해 주세요</h3>
                        <p className="text-sm max-w-md bg-gray-800 p-4 rounded-lg border border-gray-700 shadow-sm">
                            <strong className="text-emerald-400 block mb-1">💡 팁: 첫 메시지의 지배력 (First Message Anchoring)</strong>
                            AI는 '첫 메시지'의 형식, 시제, 인칭, 서술 길이를 강력한 템플릿으로 삼아 이후 대답을 복제합니다. 
                            원하는 답변의 길이와 3인칭/과거형 등의 시제를 완벽히 준수하여 첫 메시지를 작성하세요.
                        </p>
                    </div>
                )}
                {(chatRoom.messages || []).map((msg) => (
                    <MessageComponent 
                        key={msg.id} 
                        message={msg}
                        isEditing={editingMessageId === msg.id}
                        editingText={editingText}
                        onEditingTextChange={setEditingText}
                        onSaveEdit={handleSaveEdit}
                        onCancelEdit={handleCancelEdit}
                        onStartEdit={handleStartEditMessage}
                        onDelete={handleDeleteMessage}
                        onRegenerate={handleRegenerateAIMessage}
                        onSelectVariant={handleSelectVariant}
                        filterSettings={filterSettings}
                    />
                ))}
                <div ref={messagesEndRef} />
                {isLoading && <div className="loading-indicator"><div className="loading-dots"><span className="dot1"></span><span className="dot2"></span><span className="dot3"></span></div>AI가 응답을 생성하고 있습니다...</div>}
                {error && <div className="error-message"><span>오류: {error}</span><button onClick={() => setError(null)} className="action-button">×</button></div>}
            </div>
            
            <div className="message-input-container">
                <form onSubmit={handleSendMessage} className="message-input-form">
                    <textarea 
                        className="message-input" 
                        value={input} 
                        onChange={(e) => setInput(e.target.value)} 
                        onKeyDown={(e) => { if (!isMobileView && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(e); } }} 
                        placeholder={chatRoom.mode === 'architect' ? "세계관, 캐릭터 설정, 스토리 방향을 지시하세요..." : "캐릭터에게 말을 걸거나 행동을 묘사하세요..."} 
                        rows={1} 
                        disabled={isLoading} 
                    />
                    <button type="submit" className="send-button" disabled={!input.trim() || isLoading}><SendIcon /></button>
                </form>
            </div>
        </div>
    );
};
