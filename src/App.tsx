import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { GoogleGenAI } from '@google/genai';
import { ChatRoom, MemorySlots } from './types';
import { DEFAULT_CUSTOM_PROMPT, DEFAULT_THINKING_MODE_INSTRUCTIONS, DEFAULT_ROLE_DEFINITION, DEFAULT_OUTPUT_CONTRACT } from './constants';
import { DEFAULT_CLAUDE_MODEL } from './services/claudeClient';
import { parseCharacterCardPng, cardToChatRoom } from './services/characterCard';
import { ApiKeys, loadApiKeys, saveApiKeys, resolveGeminiKey } from './services/apiKeys';
import { DEFAULT_OPENROUTER_MODEL } from './services/openRouterClient';
import { ChatListView } from './components/ChatListView';
import { ChatRoomView } from './components/ChatRoomView';

export const App: React.FC = () => {
    const [ai, setAi] = useState<GoogleGenAI | null>(null);
    const [apiKeys, setApiKeys] = useState<ApiKeys>(loadApiKeys);
    const [chatRooms, setChatRooms] = useState<ChatRoom[]>([]);
    const [currentChatRoomId, setCurrentChatRoomId] = useState<string | null>(null);
    const [isDarkMode, setIsDarkMode] = useState(false);
    const [isEditingTitle, setIsEditingTitle] = useState<string | null>(null);
    const [editingTitleText, setEditingTitleText] = useState('');

    // Load initial data from localStorage
    useEffect(() => {
        const savedTheme = localStorage.getItem('theme');
        const darkMode = savedTheme === 'dark';
        setIsDarkMode(darkMode);
        document.body.classList.toggle('dark-mode', darkMode);
        
        const savedRooms = localStorage.getItem('chatRooms');
        if (savedRooms) {
            const parsedRooms: any[] = JSON.parse(savedRooms);
            const migratedRooms: ChatRoom[] = (Array.isArray(parsedRooms) ? parsedRooms : []).map(room => {
                // Migration logic for memory structure
                let migratedMemory: MemorySlots = {
                    persona: '',
                    scenario: '',
                    user_persona: '',
                    state: '',
                    short_term_memory: '',
                    planning: ''
                };

                // Helper to map old object/string to new structure
                const mapOldMemory = (oldMem: any): MemorySlots => {
                    const newMem: MemorySlots = { ...migratedMemory };
                    
                    if (typeof oldMem === 'string') {
                        newMem.state = oldMem;
                    } else if (typeof oldMem === 'object' && oldMem !== null) {
                        newMem.persona = oldMem.persona || oldMem.core_identity || oldMem.character_core || '';
                        
                        const oldScenarioParts = [oldMem.scenario, oldMem.blueprint, oldMem.context_note].filter(Boolean);
                        newMem.scenario = oldScenarioParts.join('\n\n');
                        
                        newMem.user_persona = oldMem.user_persona || oldMem.user_req || '';
                        
                        const oldStateParts = [oldMem.state, oldMem.current_state, oldMem.character_state, oldMem.character, oldMem.relationship, oldMem.active_goals].filter(Boolean);
                        newMem.state = oldStateParts.join('\n\n');
                        
                        newMem.short_term_memory = oldMem.short_term_memory || oldMem.episode || oldMem.summary || '';
                        newMem.planning = oldMem.planning || '';
                        // 스탯 정의를 옮기지 않으면 로드할 때마다 방 설정이 통째로 사라진다.
                        if (Array.isArray(oldMem.stats)) newMem.stats = oldMem.stats;
                    }
                    return newMem;
                };

                migratedMemory = mapOldMemory(room.memory);

                // Migrate snapshots as well
                const migratedSnapshots = (room.snapshots || []).map((snap: any) => ({
                    ...snap,
                    memory: mapOldMemory(snap.memory)
                }));

                return {
                    ...room,
                    customPrompt: room.customPrompt ?? DEFAULT_CUSTOM_PROMPT,
                    roleDefinition: room.roleDefinition ?? DEFAULT_ROLE_DEFINITION,
                    outputContract: room.outputContract ?? DEFAULT_OUTPUT_CONTRACT,
                    memory: migratedMemory,
                    snapshots: migratedSnapshots,
                    temperature: room.temperature ?? 0.8,
                    topP: room.topP ?? 0.95,
                    thinkingMode: room.thinkingMode ?? 'simple',
                    thinkingModeInstructions: room.thinkingModeInstructions ?? DEFAULT_THINKING_MODE_INSTRUCTIONS,
                    mode: room.mode || 'roleplay', // Migration
                    modelName: (() => {
                        const validModels = ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash-image'];
                        let m = room.modelName;
                        if (!m || !validModels.includes(m)) {
                            if (m === 'gemini-3-pro-preview') return 'gemini-3.1-pro-preview';
                            if (m === 'gemini-pro') return 'gemini-3.1-pro-preview';
                            if (m === 'gemini-1.5-pro') return 'gemini-3.1-pro-preview';
                            if (m === 'gemini-1.5-flash') return 'gemini-3-flash-preview';
                            return 'gemini-3.1-pro-preview';
                        }
                        return m;
                    })(),
                    ragThreshold: room.ragThreshold === 0.75 || room.ragThreshold === 0.65 || room.ragThreshold === 0.55 ? 0.0 : (room.ragThreshold ?? 0.0),
                    maxContextTurns: room.maxContextTurns ?? 3,
                    // 기존 방은 임베딩 유사도 0.55로 거의 모든 엔트리가 걸려 들어왔다.
                    // 시맨틱 트리거를 꺼진 상태로 시작하고, 필요하면 설정에서 켜도록 한다.
                    lorebookThreshold: room.lorebookThreshold ?? 0,
                    lorebookMaxEntries: room.lorebookMaxEntries ?? 10,
                    provider: ['claude', 'openrouter'].includes(room.provider) ? room.provider : 'gemini',
                    claudeModel: room.claudeModel ?? DEFAULT_CLAUDE_MODEL,
                    openRouterModel: room.openRouterModel ?? DEFAULT_OPENROUTER_MODEL,
                };
            });
            setChatRooms(migratedRooms);
        }

        const lastRoomId = localStorage.getItem('lastChatRoomId');
        if (lastRoomId) {
            setCurrentChatRoomId(lastRoomId);
        }
    }, []);

    // Gemini 클라이언트 초기화.
    // 앱에 입력한 키를 우선하고, 없으면 .env.local 값을 쓴다(로컬 개발용).
    // 키가 바뀌면 클라이언트를 다시 만든다.
    useEffect(() => {
        const key = resolveGeminiKey(apiKeys);
        setAi(key ? new GoogleGenAI({ apiKey: key }) : null);
    }, [apiKeys]);

    const handleApiKeysChange = useCallback((keys: ApiKeys) => {
        saveApiKeys(keys);
        setApiKeys(keys);
    }, []);

    // Save chat rooms to localStorage whenever they change
    useEffect(() => {
        try {
            localStorage.setItem('chatRooms', JSON.stringify(chatRooms));
        } catch (e) {
            console.error("Failed to save chats to localStorage", e);
        }
    }, [chatRooms]);
    
    useEffect(() => {
        try {
            if(currentChatRoomId) {
                localStorage.setItem('lastChatRoomId', currentChatRoomId);
            } else {
                localStorage.removeItem('lastChatRoomId');
            }
        } catch (e) {
            console.error("Failed to save lastChatRoomId to localStorage", e);
        }
    }, [currentChatRoomId]);

    const handleNewChat = () => {
        const newRoom: ChatRoom = {
            id: `chat_${Date.now()}`,
            title: '새로운 채팅',
            messages: [],
            customPrompt: DEFAULT_CUSTOM_PROMPT,
            roleDefinition: DEFAULT_ROLE_DEFINITION,
            outputContract: DEFAULT_OUTPUT_CONTRACT,
            memory: { persona: '', scenario: '', user_persona: '', state: '', short_term_memory: '', planning: '' },
            snapshots: [],
            temperature: 0.8,
            topP: 0.95,
            presencePenalty: 0.0,
            frequencyPenalty: 0.0,
            thinkingMode: 'simple',
            thinkingModeInstructions: DEFAULT_THINKING_MODE_INSTRUCTIONS,
            mode: 'roleplay', // Default mode
            modelName: 'gemini-3.1-pro-preview',
            ragThreshold: 0.0,
            maxContextTurns: 3,
            lorebookThreshold: 0,
            lorebookMaxEntries: 10,
            provider: 'gemini',
            claudeModel: DEFAULT_CLAUDE_MODEL,
            openRouterModel: DEFAULT_OPENROUTER_MODEL,
        };
        setChatRooms(prev => [newRoom, ...prev]);
        setCurrentChatRoomId(newRoom.id);
    };

    const handleImportChat = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
    
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const text = e.target?.result;
                if (typeof text !== 'string') throw new Error('파일 내용을 읽을 수 없습니다.');
                const importedRoom = JSON.parse(text);
    
                if (!importedRoom.id || !importedRoom.title || !Array.isArray(importedRoom.messages)) {
                    throw new Error('유효하지 않은 채팅 파일 형식입니다.');
                }
                
                 // Migration logic for import
                let migratedMemory: MemorySlots = {
                    persona: '', scenario: '', user_persona: '', state: '', short_term_memory: '', planning: ''
                };
                
                 const mapOldMemory = (oldMem: any): MemorySlots => {
                    const newMem: MemorySlots = { ...migratedMemory };
                    if (typeof oldMem === 'string') {
                        newMem.state = oldMem;
                    } else if (typeof oldMem === 'object' && oldMem !== null) {
                        newMem.persona = oldMem.persona || oldMem.core_identity || oldMem.character_core || '';
                        
                        const oldScenarioParts = [oldMem.scenario, oldMem.blueprint, oldMem.context_note].filter(Boolean);
                        newMem.scenario = oldScenarioParts.join('\n\n');
                        
                        newMem.user_persona = oldMem.user_persona || oldMem.user_req || '';
                        
                        const oldStateParts = [oldMem.state, oldMem.current_state, oldMem.character_state, oldMem.character, oldMem.relationship, oldMem.active_goals].filter(Boolean);
                        newMem.state = oldStateParts.join('\n\n');
                        
                        newMem.short_term_memory = oldMem.short_term_memory || oldMem.episode || oldMem.summary || '';
                        newMem.planning = oldMem.planning || '';
                        // 스탯 정의를 옮기지 않으면 로드할 때마다 방 설정이 통째로 사라진다.
                        if (Array.isArray(oldMem.stats)) newMem.stats = oldMem.stats;
                    }
                    return newMem;
                };

                migratedMemory = mapOldMemory(importedRoom.memory);

                const migratedSnapshots = (importedRoom.snapshots || []).map((snap: any) => ({
                    ...snap,
                    memory: mapOldMemory(snap.memory)
                }));
    
                let newRoom: ChatRoom = {
                    ...importedRoom,
                    customPrompt: importedRoom.customPrompt ?? DEFAULT_CUSTOM_PROMPT,
                    roleDefinition: importedRoom.roleDefinition ?? DEFAULT_ROLE_DEFINITION,
                    outputContract: importedRoom.outputContract ?? DEFAULT_OUTPUT_CONTRACT,
                    memory: migratedMemory,
                    snapshots: migratedSnapshots,
                    temperature: importedRoom.temperature ?? 0.8,
                    topP: importedRoom.topP ?? 0.95,
                    thinkingMode: importedRoom.thinkingMode ?? 'simple',
                    thinkingModeInstructions: importedRoom.thinkingModeInstructions ?? DEFAULT_THINKING_MODE_INSTRUCTIONS,
                    modelName: importedRoom.modelName === 'gemini-3-pro-preview' ? 'gemini-3.1-pro-preview' : (importedRoom.modelName ?? 'gemini-3.1-pro-preview'),
                    ragThreshold: importedRoom.ragThreshold === 0.75 || importedRoom.ragThreshold === 0.65 || importedRoom.ragThreshold === 0.55 ? 0.0 : (importedRoom.ragThreshold ?? 0.0),
                    maxContextTurns: importedRoom.maxContextTurns ?? 3,
                    lorebookThreshold: importedRoom.lorebookThreshold ?? 0,
                    lorebookMaxEntries: importedRoom.lorebookMaxEntries ?? 10,
                    provider: ['claude', 'openrouter'].includes(importedRoom.provider) ? importedRoom.provider : 'gemini',
                    claudeModel: importedRoom.claudeModel ?? DEFAULT_CLAUDE_MODEL,
                    openRouterModel: importedRoom.openRouterModel ?? DEFAULT_OPENROUTER_MODEL,
                };
    
                if (chatRooms.some(room => room.id === newRoom.id)) {
                    newRoom.id = `chat_${Date.now()}`;
                    newRoom.title = `${newRoom.title} (가져옴)`;
                }
    
                setChatRooms(prev => [newRoom, ...prev]);
                setCurrentChatRoomId(newRoom.id);
    
            } catch (error: any) {
                console.error('Failed to import chat:', error);
                // 콘솔에만 남기면 실패해도 화면상 아무 일도 일어나지 않는다.
                alert(`채팅을 가져오는 데 실패했습니다: ${error.message}`);
            }
            if (event.target) {
                event.target.value = '';
            }
        };
        reader.readAsText(file);
    };
    
    const handleImportCharacterCard = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const buffer = e.target?.result;
                if (!(buffer instanceof ArrayBuffer)) throw new Error('파일을 읽을 수 없습니다.');

                const card = parseCharacterCardPng(buffer);
                const { room, warnings } = cardToChatRoom(card);

                setChatRooms(prev => [room, ...prev]);
                setCurrentChatRoomId(room.id);

                const summary = [
                    `'${room.title}' 캐릭터를 불러왔습니다. (${card.spec.toUpperCase()})`,
                    `로어북 ${room.lorebook?.length ?? 0}개, 첫 메시지 ${room.messages.length}개`,
                    ...warnings.map(w => `· ${w}`),
                ].join('\n');
                alert(summary);
            } catch (error: any) {
                console.error('Failed to import character card:', error);
                alert(`캐릭터 카드를 불러오지 못했습니다: ${error.message}`);
            }
            if (event.target) event.target.value = '';
        };
        reader.onerror = () => alert('파일을 읽는 중 오류가 발생했습니다.');
        reader.readAsArrayBuffer(file);
    };

    const handleSelectChat = (id: string) => {
        setCurrentChatRoomId(id);
    };

    const handleDeleteChat = (id: string) => {
        setChatRooms(prev => prev.filter(room => room.id !== id));
        if (currentChatRoomId === id) {
            setCurrentChatRoomId((chatRooms?.length || 0) > 1 ? chatRooms.find(r => r.id !== id)!.id : null);
        }
    };
    
    const handleEditTitle = (id: string, currentTitle: string) => {
        setIsEditingTitle(id);
        setEditingTitleText(currentTitle);
    };

    const handleSaveTitle = (id: string) => {
        setChatRooms(prev => prev.map(room => 
            room.id === id ? { ...room, title: editingTitleText.trim() || 'Untitled Chat' } : room
        ));
        setIsEditingTitle(null);
    };

    const handleTitleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setEditingTitleText(e.target.value);
    };
    
    const handleTitleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, id: string) => {
        if (e.key === 'Enter') {
            handleSaveTitle(id);
        } else if (e.key === 'Escape') {
            setIsEditingTitle(null);
        }
    };

    const toggleTheme = () => {
        const newIsDarkMode = !isDarkMode;
        setIsDarkMode(newIsDarkMode);
        document.body.classList.toggle('dark-mode', newIsDarkMode);
        try {
            localStorage.setItem('theme', newIsDarkMode ? 'dark' : 'light');
        } catch (e) {
            console.error("Failed to save theme to localStorage", e);
        }
    };
    
    const currentChatRoom = useMemo(() => {
        return chatRooms.find(room => room.id === currentChatRoomId);
    }, [chatRooms, currentChatRoomId]);
    
    const setCurrentChatRoom = useCallback((updater: (prev: ChatRoom | null) => ChatRoom | null) => {
        setChatRooms(prevRooms => {
            return prevRooms.map(room => {
                if (room.id === currentChatRoomId) {
                    return updater(room) as ChatRoom;
                }
                return room;
            });
        });
    }, [currentChatRoomId]);

    if (!currentChatRoom) {
        return (
            <div className="app-container">
                <ChatListView 
                    chatRooms={chatRooms}
                    activeChatId={currentChatRoomId}
                    onSelectChat={handleSelectChat}
                    onNewChat={handleNewChat}
                    onDeleteChat={handleDeleteChat}
                    onEditTitle={handleEditTitle}
                    isEditingTitle={isEditingTitle}
                    editingTitleText={editingTitleText}
                    onSaveTitle={handleSaveTitle}
                    onTitleInputChange={handleTitleInputChange}
                    onTitleInputKeyDown={handleTitleInputKeyDown}
                    isDarkMode={isDarkMode}
                    toggleTheme={toggleTheme}
                    onImportChat={handleImportChat}
                    onImportCharacterCard={handleImportCharacterCard}
                />
            </div>
        );
    }

    return (
        <div className="app-container">
            <ChatRoomView
                key={currentChatRoom.id}
                chatRoom={currentChatRoom}
                onBack={() => setCurrentChatRoomId(null)}
                ai={ai}
                apiKeys={apiKeys}
                onApiKeysChange={handleApiKeysChange}
                setCurrentChatRoom={setCurrentChatRoom}
            />
        </div>
    );
};
