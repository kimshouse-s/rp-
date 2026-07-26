import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Chat, Type } from '@google/genai';
import { ChatRoom, Message, MemorySlots, Snapshot, FilterSettings, FilterType, ThinkingMode, ChatMode, VectorMemoryChunk, LorebookEntry } from '../types';
import { PromptEngine } from '../services/promptEngine';
import { MemoryManager } from '../services/memoryManager';
import { LorebookService } from '../services/lorebookService';
import { RAGService } from '../services/ragService';
import { BackIcon, MemoryIcon, SettingsIcon, SendIcon } from './Icons';
import { MessageComponent } from './MessageComponent';
import { SettingsModal } from './SettingsModal';
import { MemoryViewerModal } from './MemoryViewerModal';
import { DEFAULT_ROLE_DEFINITION, DEFAULT_OUTPUT_CONTRACT, DEFAULT_THINKING_MODE_INSTRUCTIONS } from '../constants';

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

export const ChatRoomView: React.FC<ChatRoomViewProps> = ({ chatRoom, onBack, ai, setCurrentChatRoom }) => {
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
    const [isMemoryModalOpen, setIsMemoryModalOpen] = useState(false);
    const [isPlanningOpen, setIsPlanningOpen] = useState(false);
    const [isMobileView, setIsMobileView] = useState(window.innerWidth <= 768);
    
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    const [editingText, setEditingText] = useState('');
    
    const [memoryJustUpdated, setMemoryJustUpdated] = useState(false);
    const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);

    const [filterSettings, setFilterSettings] = useState<FilterSettings>({
        showThinking: false,
        showMemoryUpdates: true,
        showInnerThought: true,
        showEmotionTags: true,
        showSceneHeaders: true,
        showNarration: true,
    });

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
        if (!ai) throw new Error("AI is not initialized.");
        
        const contextTurns = currentChat.maxContextTurns || 3;

        // 1. Prepare recent context for scanning (last N messages for Lorebook)
        const recentMessages = (currentChat.messages || []).slice(-contextTurns).map(m => m.text).join('\n') + '\n' + prompt;
        const recentMessagesEmbedding = await RAGService.generateEmbedding(ai, recentMessages);
        
        // 2. Scan Lorebook
        const dynamicLorebook = LorebookService.scan(currentChat.lorebook || [], recentMessages, recentMessagesEmbedding);
        
        // 3. Query RAG Memory (Use a more focused query: short term memory + last AI message + current user prompt)
        const lastAiMessage = (currentChat.messages?.length || 0) > 0 && currentChat.messages[(currentChat.messages?.length || 0) - 1].sender === 'ai' 
            ? currentChat.messages[(currentChat.messages?.length || 0) - 1].text 
            : '';
        const ragQueryText = `[Current Context]\n${currentChat.memory?.short_term_memory || ''}\n\n[Recent Dialogue]\nAI: ${lastAiMessage}\nUser: ${prompt}`.trim();
        const { results: ragContext, updatedMemory: updatedVectorMemory } = await RAGService.queryMemory(ai, currentChat.vectorMemory || [], ragQueryText, currentChat.ragThreshold ?? 0.55);

        // 4. Build System Prompt with injected contexts
        const systemInstruction = PromptEngine.buildSystemPrompt(currentChat, dynamicLorebook, ragContext);
        
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
    
    const processAIResponse = async (text: string | undefined | null, functionCalls: any[] | undefined, currentMemory: MemorySlots, currentLorebook: LorebookEntry[] | undefined): Promise<{ thinking?: string, memoryUpdate?: string, mainText: string, newMemory: MemorySlots, newLorebook: LorebookEntry[], ragUpdates: string[], error?: string }> => {
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
                    if (category && newMemory.hasOwnProperty(category)) {
                        const targetKey = category as keyof MemorySlots;
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
                     if (args.action && args.keys && args.content) {
                          const actionStr = String(args.action).toLowerCase();
                          if (actionStr === 'add' || actionStr === 'update') {
                              const keysArray = Array.isArray(args.keys)
                                  ? args.keys.map((k: any) => String(k))
                                  : typeof args.keys === 'string'
                                      ? args.keys.split(',').map((k: string) => k.trim()).filter(Boolean)
                                      : [String(args.keys)];

                              newLorebook = newLorebook.filter(lb => !lb.keys.some(k => keysArray.includes(k)));
                              
                              let embedding: number[] | undefined = undefined;
                              if (ai) {
                                  try {
                                      embedding = await RAGService.generateEmbedding(ai, String(args.content));
                                  } catch (e) {
                                      console.error("Failed to generate embedding for lorebook entry:", e);
                                  }
                              }

                              newLorebook.push({
                                  id: `lb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                                  keys: keysArray,
                                  content: String(args.content),
                                  embedding: embedding,
                                  depth: ['high', 'mid', 'low'].includes(String(args.depth)) ? (args.depth as 'high' | 'mid' | 'low') : 'mid',
                                  probability: 100,
                                  recursable: false
                              });
                              logs.push(`[Lorebook] Updated/Added keys: ${keysArray.join(', ')}`);
                          }
                     }
                }
            }
        }

        // Keep regex fallback for safety in case model ignores tools
        const { newMemory: mem2, newLorebook: lore2, updateLog } = MemoryManager.applyUpdates(newMemory, newLorebook, responseText);
        newMemory = mem2;
        newLorebook = lore2;
        if (updateLog) logs.push(updateLog);
        
        const memUpdateRegex = /<mem[\s_-]*update[^>]*>([\s\S]*?)<\/mem[\s_-]*update>/gi;
        responseText = responseText.replace(memUpdateRegex, '').trim();

        const loreUpdateRegex = /<lorebook[\s_-]*update[^>]*>([\s\S]*?)<\/lorebook[\s_-]*update>/gi;
        responseText = responseText.replace(loreUpdateRegex, '').trim();

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

    const updateRagMemoryAsync = useCallback((ragUpdates: string[]) => {
        if (!ragUpdates || ragUpdates.length === 0) return;
        setTimeout(async () => {
            if (!ai) return;
            try {
                const newChunks: VectorMemoryChunk[] = [];
                for (const fact of ragUpdates) {
                    const embedding = await RAGService.generateEmbedding(ai, fact);
                    if (embedding.length > 0) {
                        newChunks.push({
                            id: `rag_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                            text: fact,
                            embedding,
                            timestamp: Date.now()
                        });
                    }
                }
                
                if (newChunks.length > 0) {
                    setCurrentChatRoom(prev => {
                        if (!prev) return null;
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
    }, [ai]);

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
            
            const { text: aiText, functionCalls, ragContext, dynamicLorebook, updatedVectorMemory } = await callGeminiApi(history, finalInput, chatRoom);
            const { thinking, memoryUpdate, mainText, newMemory, newLorebook, ragUpdates, error: processError } = await processAIResponse(aiText, functionCalls, chatRoom.memory, chatRoom.lorebook);

            if(processError) setError(processError);

            const aiMessage: Message = {
                id: `msg_${Date.now() + 1}`,
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
            updateRagMemoryAsync(ragUpdates);

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
            
            let newMemory: MemorySlots = { persona: '', scenario: '', user_persona: '', state: '', short_term_memory: '', planning: '' };
            const newSnapshots = (prev.snapshots || []).filter(s => newMessages.some(m => m.id === s.messageId));
            
            if (newSnapshots.length > 0) {
                 newMemory = newSnapshots[newSnapshots.length - 1].memory;
            } else if ((prev.snapshots?.length || 0) > 0) {
                 newMemory = (prev.snapshots || [])[0].memory;
            }

            setMemoryJustUpdated(true);
            return { ...prev, messages: newMessages, memory: newMemory, snapshots: newSnapshots };
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
            const userMessage = chatRoom.messages[messageIndex - 1];
            
            const messagesBefore = (chatRoom.messages || []).slice(0, messageIndex - 1);
            let memoryBefore: MemorySlots = { persona: '', scenario: '', user_persona: '', state: '', short_term_memory: '', planning: '' };
            const lastSnapshot = chatRoom.snapshots.slice().reverse().find(s => messagesBefore.some(m => m.id === s.messageId));
             if (lastSnapshot) {
                memoryBefore = lastSnapshot.memory;
            }

            const history = messagesBefore.map(msg => ({
                role: msg.sender === 'user' ? 'user' : 'model',
                parts: [{ text: msg.text }],
            }));
            
            const tempChatRoom = { ...chatRoom, memory: memoryBefore };
            
            const { text: aiText, functionCalls, ragContext, dynamicLorebook } = await callGeminiApi(history, userMessage.text, tempChatRoom);
            const { thinking, memoryUpdate, mainText, newMemory, newLorebook, ragUpdates, error: processError } = await processAIResponse(aiText, functionCalls, memoryBefore, chatRoom.lorebook);
            
            if(processError) setError(processError);
            
            const newAiMessage: Message = {
                id: `msg_${Date.now()}`,
                text: mainText,
                sender: 'ai',
                timestamp: new Date().toISOString(),
                thinking,
                memoryUpdate,
                ragContext,
                lorebookContext: dynamicLorebook
            };
            
            setCurrentChatRoom(prev => {
                if (!prev) return null;
                const newMessages = [...(prev.messages || []).slice(0, messageIndex), newAiMessage];
                const newSnapshots = [...(prev.snapshots || []).filter(s => s.messageId !== messageId), { messageId: newAiMessage.id, memory: newMemory }];
                return { ...prev, messages: newMessages, memory: newMemory, lorebook: newLorebook, snapshots: newSnapshots };
            });
            if (memoryUpdate) setMemoryJustUpdated(true);
            
            updateRagMemoryAsync(ragUpdates);
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
        
        let memoryBefore: MemorySlots = { persona: '', scenario: '', user_persona: '', state: '', short_term_memory: '', planning: '' };
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
                const tempChatRoom = { ...chatRoom, memory: memoryBefore };
                
                const { text: aiText, functionCalls, ragContext, dynamicLorebook } = await callGeminiApi(history, editingText, tempChatRoom);
                const { thinking, memoryUpdate, mainText, newMemory, newLorebook, ragUpdates, error: processError } = await processAIResponse(aiText, functionCalls, memoryBefore, chatRoom.lorebook);
                
                if (processError) setError(processError);
                
                const aiMessage: Message = { id: `msg_${Date.now() + 1}`, text: mainText, sender: 'ai', timestamp: new Date().toISOString(), thinking, memoryUpdate, ragContext, lorebookContext: dynamicLorebook };
                
                setCurrentChatRoom(prev => ({ ...prev!, messages: [...newMessagesBase, aiMessage], memory: newMemory, lorebook: newLorebook, snapshots: [...(prev!.snapshots || []).filter(s => messagesBefore.some(m => m.id === s.messageId)), { messageId: aiMessage.id, memory: newMemory }] }));
                
                updateRagMemoryAsync(ragUpdates);
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
            {isSettingsModalOpen && <SettingsModal room={chatRoom} onClose={() => setIsSettingsModalOpen(false)} onSave={setCurrentChatRoom} />}
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
