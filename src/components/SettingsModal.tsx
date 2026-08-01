import React, { useState } from 'react';
import { ChatRoom, ThinkingMode, LorebookEntry, MemorySlots, ChatProvider, StatDefinition, StatKind, ResponseLength } from '../types';
import { DEFAULT_CUSTOM_PROMPT, DEFAULT_THINKING_MODE_INSTRUCTIONS, DEFAULT_ROLE_DEFINITION, DEFAULT_OUTPUT_CONTRACT } from '../constants';
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } from '../services/claudeClient';
import { OPENROUTER_MODELS, DEFAULT_OPENROUTER_MODEL } from '../services/openRouterClient';
import { ApiKeys } from '../services/apiKeys';
import { ExportIcon } from './Icons';
import { PromptEngine } from '../services/promptEngine';
import { MemoryManager } from '../services/memoryManager';

interface SettingsModalProps {
    room: ChatRoom;
    onClose: () => void;
    onSave: (updater: (prev: ChatRoom | null) => ChatRoom | null) => void;
    apiKeys: ApiKeys;
    onApiKeysChange: (keys: ApiKeys) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ room, onClose, onSave, apiKeys, onApiKeysChange }) => {
    // API 키는 방이 아니라 브라우저 전체에 공유되므로 별도로 관리한다.
    const [draftKeys, setDraftKeys] = useState<ApiKeys>(apiKeys);
    const [currentSettings, setCurrentSettings] = useState({
        customPrompt: room.customPrompt,
        roleDefinition: room.roleDefinition,
        outputContract: room.outputContract,
        memory: { persona: '', scenario: '', user_persona: '', state: '', short_term_memory: '', planning: '', ...room.memory },
        temperature: room.temperature,
        topP: room.topP,
        presencePenalty: room.presencePenalty ?? 0,
        frequencyPenalty: room.frequencyPenalty ?? 0,
        thinkingModeInstructions: room.thinkingModeInstructions,
        responseLength: room.responseLength ?? 'normal',
        provider: room.provider ?? 'gemini',
        modelName: room.modelName,
        claudeModel: room.claudeModel ?? DEFAULT_CLAUDE_MODEL,
        openRouterModel: room.openRouterModel ?? DEFAULT_OPENROUTER_MODEL,
        maxContextTurns: room.maxContextTurns || 3,
        ragThreshold: room.ragThreshold ?? 0.0,
        lorebookThreshold: room.lorebookThreshold ?? 0,
        lorebookMaxEntries: room.lorebookMaxEntries ?? 10,
    });
    const [activeTab, setActiveTab] = useState<'memory' | 'stats' | 'system' | 'model' | 'lorebook' | 'rag'>('memory');
    const [stats, setStats] = useState<StatDefinition[]>(room.memory?.stats ?? []);
    const [activeMemorySlot, setActiveMemorySlot] = useState<keyof MemorySlots>('persona');
    const [activeInstructionTab, setActiveInstructionTab] = useState<ThinkingMode>('simple');
    
    // Lorebook state
    const [lorebookEntries, setLorebookEntries] = useState<LorebookEntry[]>(room.lorebook || []);
    const [editingLorebookId, setEditingLorebookId] = useState<string | null>(null);

    // RAG Memory state
    const [vectorMemory, setVectorMemory] = useState(room.vectorMemory || []);

    const handleSave = () => {
        onApiKeysChange(draftKeys);
        onSave(prev => prev ? {
            ...prev,
            ...currentSettings,
            memory: { ...currentSettings.memory, stats: stats.length ? stats : undefined },
            lorebook: lorebookEntries,
            vectorMemory,
        } : null);
        onClose();
    };

    const handleDeleteVectorMemory = (id: string) => {
        setVectorMemory(prev => prev.filter(chunk => chunk.id !== id));
    };

    const handleClearAllVectorMemory = () => {
        setVectorMemory([]);
    };

    const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setCurrentSettings(prev => ({ ...prev, [name]: parseFloat(value) }));
    };

    const handleInstructionChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setCurrentSettings(prev => ({
            ...prev,
            thinkingModeInstructions: {
                ...prev.thinkingModeInstructions,
                [activeInstructionTab]: e.target.value,
            }
        }));
    };

    const handleResetInstructions = () => {
        setCurrentSettings(prev => ({
            ...prev,
            thinkingModeInstructions: {
                ...prev.thinkingModeInstructions,
                [activeInstructionTab]: DEFAULT_THINKING_MODE_INSTRUCTIONS[activeInstructionTab],
            }
        }));
    };

    const handleExportChat = () => {
        try {
            const fileName = `${room.title.replace(/[^a-z0-9ㄱ-힣]/gi, '_').toLowerCase() || 'chat_export'}.json`;
            const dataToExport = JSON.stringify(room, null, 2);
            const blob = new Blob([dataToExport], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error("Export failed:", error);
            alert("채팅 내보내기에 실패했습니다.");
        }
    };

    const instructionTabLabels: Record<ThinkingMode, string> = {
        none: '사고 안함',
        simple: '간단한 사고',
        deep: '심층 사고'
    };

    const memorySlots: {id: keyof MemorySlots, label: string, desc: string}[] = [
        { id: 'persona', label: '1. Persona', desc: '캐릭터의 본질, 성격, 배경 (Core Identity)' },
        { id: 'scenario', label: '2. Scenario', desc: '현재 세계관, 배경 설정 및 전체 스토리 계획' },
        { id: 'user_persona', label: '3. User Persona', desc: '사용자의 설정, 외모, 취향 및 특별 요청' },
        { id: 'state', label: '4. Dynamic State', desc: '캐릭터의 현재 기분, 상태, 관계도 및 당면 목표' },
        { id: 'short_term_memory', label: '5. Short-term Memory', desc: '장기 기억(RAG)으로 넘어가기 전의 최근 사건 요약' },
        { id: 'planning', label: '6. Planning (Architect)', desc: '체크리스트 및 공정표 (Architect 모드 전용)' },
    ];

    return (
        <div className="modal-backdrop">
            <div className="modal-content large">
                <div className="modal-header">
                    <h3>⚙️ 채팅방 설정</h3>
                    <button onClick={onClose} className="close-button">&times;</button>
                </div>
                <div className="modal-body">
                    <div className="tab-buttons main-tabs">
                        <button className={`tab-button ${activeTab === 'memory' ? 'active' : ''}`} onClick={() => setActiveTab('memory')}>🧠 메모리 (Data)</button>
                        <button className={`tab-button ${activeTab === 'stats' ? 'active' : ''}`} onClick={() => setActiveTab('stats')}>📊 스탯</button>
                        <button className={`tab-button ${activeTab === 'lorebook' ? 'active' : ''}`} onClick={() => setActiveTab('lorebook')}>📚 로어북 (Lore)</button>
                        <button className={`tab-button ${activeTab === 'rag' ? 'active' : ''}`} onClick={() => setActiveTab('rag')}>🕰️ 장기 기억 (RAG)</button>
                        <button className={`tab-button ${activeTab === 'system' ? 'active' : ''}`} onClick={() => setActiveTab('system')}>🛠️ 시스템 (Rules)</button>
                        <button className={`tab-button ${activeTab === 'model' ? 'active' : ''}`} onClick={() => setActiveTab('model')}>🤖 모델 설정</button>
                    </div>

                    {activeTab === 'memory' && (
                        <div className="settings-section">
                            <div className="memory-editor-container">
                                <div className="memory-sidebar">
                                    {memorySlots.map(slot => (
                                        <button 
                                            key={slot.id} 
                                            className={`memory-slot-button ${activeMemorySlot === slot.id ? 'active' : ''}`}
                                            onClick={() => setActiveMemorySlot(slot.id)}
                                        >
                                            <div className="slot-label">{slot.label}</div>
                                            <div className="slot-desc">{slot.desc}</div>
                                        </button>
                                    ))}
                                </div>
                                <div className="memory-input-area">
                                    <h4>{memorySlots.find(s => s.id === activeMemorySlot)?.label}</h4>
                                    <p className="description">{memorySlots.find(s => s.id === activeMemorySlot)?.desc}</p>
                                    <textarea 
                                        className="memory-textarea"
                                        value={currentSettings.memory[activeMemorySlot]}
                                        onChange={(e) => setCurrentSettings(prev => ({
                                            ...prev,
                                            memory: { ...prev.memory, [activeMemorySlot]: e.target.value }
                                        }))}
                                        placeholder={`${activeMemorySlot} 내용을 입력하세요...`}
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'stats' && (
                        <div className="settings-section">
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                                <h4>📊 스탯</h4>
                                <button className="action-button" onClick={() => setStats([...stats, {
                                    id: `stat${stats.length + 1}`, label: '새 스탯', kind: 'persistent',
                                    min: 0, max: 100, value: 0, baseline: 0, decayPerTurn: 1,
                                }])}>+ 직접 추가</button>
                            </div>

                            <div className="lorebook-help" style={{ background: 'var(--bg-color)', padding: '1rem', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.85rem' }}>
                                <p style={{ margin: '0 0 0.5rem 0', fontWeight: 'bold' }}>💡 스탯은 코드가 규칙을 강제합니다</p>
                                <ul style={{ margin: 0, paddingLeft: '1.5rem', color: 'var(--text-secondary)' }}>
                                    <li>AI는 <strong>증감만</strong> 제안하고, 상한·감쇠·발현은 앱이 계산합니다. AI가 규칙을 무시해도 값이 한쪽으로 흐르지 않습니다.</li>
                                    <li><strong>지속형</strong>: 호감도·집착도처럼 남는 값. 아무 일 없으면 기준선으로 조금씩 돌아갑니다.</li>
                                    <li><strong>게이지형</strong>: 인내심처럼 차오르다 임계를 넘으면 한 번 터지고 리셋됩니다.</li>
                                    <li>스탯을 하나도 두지 않으면 이 기능은 프롬프트에서 완전히 빠집니다.</li>
                                </ul>
                                <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                    <button className="preset-button" onClick={() => setStats([...stats, { id: 'affection', label: '호감도', kind: 'persistent', min: 0, max: 100, value: 0, baseline: 10, decayPerTurn: 1, description: '진심 어린 교류에만 오른다. 형식적인 호의로는 움직이지 않는다.' }])}>+ 호감도</button>
                                    <button className="preset-button" onClick={() => setStats([...stats, { id: 'jealousy', label: '질투', kind: 'persistent', min: 0, max: 100, value: 0, baseline: 0, decayPerTurn: 2, description: '유저가 다른 대상에게 관심을 보이거나 자신이 뒷전이 될 때 오른다. 관심을 되돌려주면 가라앉는다. 이 값이 높아도 인내심이 남아 있는 한 겉으로는 삼킨다.' }])}>+ 질투</button>
                                    <button className="preset-button" onClick={() => setStats([...stats, { id: 'obsession', label: '집착도', kind: 'persistent', min: 0, max: 100, value: 0, baseline: 0, decayPerTurn: 2, description: '불안이 자극될 때만 오른다. 안심하면 빠르게 가라앉는다. 인내심이 터진 뒤에 특히 오르기 쉽다.' }])}>+ 집착도</button>
                                    <button className="preset-button" onClick={() => setStats([...stats, { id: 'patience', label: '인내심', kind: 'gauge', min: 0, max: 100, value: 0, threshold: 100, resetTo: 0, triggerEffect: '그동안 삼켜온 바로 그것이 터져 나온다. 참은 게 고백이면 고백이, 질투면 질투가, 욕망이면 욕망이 드러난다. 터진 뒤에는 다시 평소의 자제로 돌아가지만 이미 드러난 사실은 없던 일이 되지 않는다.', description: '하고 싶은 말이나 행동을 삼킬 때마다 쌓인다. 화를 참을 때만이 아니라 좋아한다고 말하지 못했을 때, 질투를 숨겼을 때, 욕망을 눌렀을 때도 오른다. 소심하거나 자존심이 셀수록 잘 쌓인다.' }])}>+ 인내심 (게이지)</button>
                                </div>
                            </div>

                            {stats.length === 0 ? (
                                <p className="description">정의된 스탯이 없습니다. 위 버튼으로 추가하세요.</p>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                    {stats.map((stat, i) => {
                                        const patch = (changes: Partial<StatDefinition>) =>
                                            setStats(stats.map((s, j) => (j === i ? { ...s, ...changes } : s)));
                                        const num = (v: string) => (v === '' ? 0 : parseFloat(v));
                                        return (
                                            <div key={i} style={{ background: 'var(--bg-secondary)', padding: '0.75rem', borderRadius: '8px' }}>
                                                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                                    <input className="chat-title-input" style={{ flex: 2 }} placeholder="표시 이름" value={stat.label} onChange={e => patch({ label: e.target.value })} />
                                                    <input className="chat-title-input" style={{ flex: 2 }} placeholder="영문 id" value={stat.id} onChange={e => patch({ id: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} />
                                                    <select className="chat-title-input" style={{ flex: 2 }} value={stat.kind} onChange={e => patch({ kind: e.target.value as StatKind })}>
                                                        <option value="persistent">지속형</option>
                                                        <option value="gauge">게이지형</option>
                                                    </select>
                                                    <button className="action-button danger" onClick={() => setStats(stats.filter((_, j) => j !== i))}>삭제</button>
                                                </div>

                                                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                                                    <label style={{ flex: 1, fontSize: '0.8rem' }}>최소<input className="chat-title-input" type="number" value={stat.min} onChange={e => patch({ min: num(e.target.value) })} /></label>
                                                    <label style={{ flex: 1, fontSize: '0.8rem' }}>최대<input className="chat-title-input" type="number" value={stat.max} onChange={e => patch({ max: num(e.target.value) })} /></label>
                                                    <label style={{ flex: 1, fontSize: '0.8rem' }}>현재값<input className="chat-title-input" type="number" value={stat.value} onChange={e => patch({ value: num(e.target.value) })} /></label>
                                                    {stat.kind === 'persistent' ? (
                                                        <>
                                                            <label style={{ flex: 1, fontSize: '0.8rem' }}>기준선<input className="chat-title-input" type="number" value={stat.baseline ?? 0} onChange={e => patch({ baseline: num(e.target.value) })} /></label>
                                                            <label style={{ flex: 1, fontSize: '0.8rem' }}>턴당 감쇠<input className="chat-title-input" type="number" value={stat.decayPerTurn ?? 0} onChange={e => patch({ decayPerTurn: num(e.target.value) })} /></label>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <label style={{ flex: 1, fontSize: '0.8rem' }}>발현 임계<input className="chat-title-input" type="number" value={stat.threshold ?? stat.max} onChange={e => patch({ threshold: num(e.target.value) })} /></label>
                                                            <label style={{ flex: 1, fontSize: '0.8rem' }}>리셋값<input className="chat-title-input" type="number" value={stat.resetTo ?? stat.min} onChange={e => patch({ resetTo: num(e.target.value) })} /></label>
                                                        </>
                                                    )}
                                                </div>

                                                {stat.kind === 'gauge' && (
                                                    <textarea rows={2} style={{ width: '100%', marginBottom: '0.5rem' }} placeholder="발현했을 때 무슨 일이 일어나는지" value={stat.triggerEffect ?? ''} onChange={e => patch({ triggerEffect: e.target.value })} />
                                                )}
                                                <textarea rows={2} style={{ width: '100%' }} placeholder="언제 오르고 내리는지 (AI에게 그대로 전달됩니다)" value={stat.description ?? ''} onChange={e => patch({ description: e.target.value })} />
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === 'lorebook' && (
                        <div className="settings-section">
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                                <h4>📚 동적 세계관 (Lorebook)</h4>
                                <button 
                                    className="action-button" 
                                    onClick={() => {
                                        const newEntry: LorebookEntry = {
                                            id: `lore_${Date.now()}`,
                                            keys: [],
                                            content: '',
                                            probability: 100,
                                            depth: 'mid',
                                            recursable: false
                                        };
                                        setLorebookEntries([...lorebookEntries, newEntry]);
                                        setEditingLorebookId(newEntry.id);
                                    }}
                                >
                                    + 새 항목 추가
                                </button>
                            </div>

                            <div className="setting-group" style={{ marginBottom: '1.5rem', background: 'var(--bg-secondary)', padding: '1rem', borderRadius: '8px' }}>
                                <div className="slider-group">
                                    <label htmlFor="lorebookMaxEntries">
                                        <span>한 턴 최대 주입 개수</span>
                                        <span>{currentSettings.lorebookMaxEntries ?? 10}개</span>
                                    </label>
                                    <input
                                        type="range" id="lorebookMaxEntries" name="lorebookMaxEntries"
                                        min="1" max="30" step="1"
                                        value={currentSettings.lorebookMaxEntries ?? 10}
                                        onChange={handleSliderChange}
                                    />
                                    <p className="description" style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}>
                                        조건에 걸린 항목이 많아도 이 개수까지만 주입합니다.
                                        중요도(High &gt; Mid &gt; Low)와 트리거 방식(정규식 &gt; 키워드 &gt; 유사도) 순으로 뽑습니다.
                                    </p>
                                </div>

                                <div className="slider-group" style={{ marginTop: '1rem' }}>
                                    <label htmlFor="lorebookThreshold">
                                        <span>임베딩 유사도 트리거</span>
                                        <span>{(currentSettings.lorebookThreshold ?? 0) === 0 ? '꺼짐' : (currentSettings.lorebookThreshold ?? 0).toFixed(2)}</span>
                                    </label>
                                    <input
                                        type="range" id="lorebookThreshold" name="lorebookThreshold"
                                        min="0" max="0.95" step="0.05"
                                        value={currentSettings.lorebookThreshold ?? 0}
                                        onChange={handleSliderChange}
                                    />
                                    <p className="description" style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}>
                                        <strong>0 (권장)</strong>: 키워드와 정규식으로만 트리거합니다.<br/>
                                        0보다 크면 키워드가 없어도 의미가 비슷하면 주입합니다.
                                        값이 낮으면 거의 모든 항목이 걸리므로 켤 거라면 0.8 이상을 권합니다.
                                    </p>
                                </div>
                            </div>

                            <div className="lorebook-help" style={{ background: 'var(--bg-color)', padding: '1rem', borderRadius: '8px', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
                                <p style={{ margin: '0 0 0.5rem 0', fontWeight: 'bold' }}>💡 로어북(Lorebook) 사용법</p>
                                <ul style={{ margin: 0, paddingLeft: '1.5rem', color: 'var(--text-secondary)' }}>
                                    <li><strong>자동 추출:</strong> Architect(설계자) 모드에서 세계관이나 설정을 논의하면 AI가 알아서 로어북 항목을 생성합니다.</li>
                                    <li><strong>키워드 트리거:</strong> 유저나 AI의 대화에 <code>키워드</code>가 등장할 때만 해당 내용이 AI의 뇌(프롬프트)에 주입됩니다.</li>
                                    <li><strong>삽입 위치 (Depth):</strong>
                                        <ul style={{ margin: '0.25rem 0 0 0', paddingLeft: '1.2rem' }}>
                                            <li><span style={{color: 'var(--accent-color)'}}>High</span>: 절대적인 세계관 규칙, 마법 시스템 (프롬프트 최상단)</li>
                                            <li><span style={{color: 'var(--accent-color)'}}>Mid</span>: 장소, 세력, 조연 캐릭터, 역사 (프롬프트 중간)</li>
                                            <li><span style={{color: 'var(--accent-color)'}}>Low</span>: 소문, 가벼운 설정, 작가의 노트 (프롬프트 최하단)</li>
                                        </ul>
                                    </li>
                                </ul>
                            </div>
                            
                            <div className="lorebook-list" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                {lorebookEntries.map(entry => (
                                    <div key={entry.id} className="lorebook-entry" style={{ border: '1px solid var(--border-color)', padding: '1rem', borderRadius: '8px' }}>
                                        {editingLorebookId === entry.id ? (
                                            <div className="lorebook-edit-form" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                                <input 
                                                    type="text" 
                                                    placeholder="키워드 (쉼표로 구분)" 
                                                    value={entry.keys.join(', ')}
                                                    onChange={(e) => {
                                                        const keys = e.target.value.split(',').map(k => k.trim()).filter(k => k);
                                                        setLorebookEntries(prev => prev.map(p => p.id === entry.id ? { ...p, keys } : p));
                                                    }}
                                                    className="chat-title-input"
                                                />
                                                <input 
                                                    type="text" 
                                                    placeholder="정규식 (선택사항, 예: /비가 오는/i)" 
                                                    value={entry.regex || ''}
                                                    onChange={(e) => setLorebookEntries(prev => prev.map(p => p.id === entry.id ? { ...p, regex: e.target.value } : p))}
                                                    className="chat-title-input"
                                                />
                                                <textarea 
                                                    placeholder="주입될 설정 내용" 
                                                    value={entry.content}
                                                    onChange={(e) => setLorebookEntries(prev => prev.map(p => p.id === entry.id ? { ...p, content: e.target.value } : p))}
                                                    rows={3}
                                                />
                                                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                                                    <label>
                                                        삽입 위치: 
                                                        <select 
                                                            value={entry.depth} 
                                                            onChange={(e) => setLorebookEntries(prev => prev.map(p => p.id === entry.id ? { ...p, depth: e.target.value as any } : p))}
                                                            style={{ marginLeft: '0.5rem', padding: '4px' }}
                                                        >
                                                            <option value="high">High (배경지식)</option>
                                                            <option value="mid">Mid (과거사/특징)</option>
                                                            <option value="low">Low (즉각적 상황/상태)</option>
                                                        </select>
                                                    </label>
                                                    <label>
                                                        <input 
                                                            type="checkbox" 
                                                            checked={entry.recursable}
                                                            onChange={(e) => setLorebookEntries(prev => prev.map(p => p.id === entry.id ? { ...p, recursable: e.target.checked } : p))}
                                                        /> 재귀 스캔 허용
                                                    </label>
                                                </div>
                                                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
                                                    <button className="action-button danger" onClick={() => setLorebookEntries(prev => prev.filter(p => p.id !== entry.id))}>삭제</button>
                                                    <button className="action-button" onClick={() => setEditingLorebookId(null)}>완료</button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="lorebook-view" onClick={() => setEditingLorebookId(entry.id)} style={{ cursor: 'pointer' }}>
                                                <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>
                                                    키워드: {entry.keys.join(', ') || '(정규식 전용)'}
                                                </div>
                                                <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', whiteSpace: 'pre-wrap' }}>
                                                    {entry.content?.length > 100 ? entry.content.substring(0, 100) + '...' : entry.content}
                                                </div>
                                                <div style={{ fontSize: '0.8rem', display: 'flex', gap: '1rem', color: 'var(--text-tertiary)' }}>
                                                    <span>위치: {entry.depth}</span>
                                                    <span>재귀: {entry.recursable ? 'O' : 'X'}</span>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ))}
                                {(lorebookEntries?.length || 0) === 0 && (
                                    <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                                        등록된 로어북 항목이 없습니다.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'rag' && (
                        <div className="settings-section">
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                                <h4>🕰️ 장기 기억 (Vector Memory)</h4>
                                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                                    <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                                        총 {(vectorMemory?.length || 0)}개의 기억 조각
                                    </span>
                                    {(vectorMemory?.length || 0) > 0 && (
                                        <button 
                                            className="action-button" 
                                            onClick={handleClearAllVectorMemory}
                                            style={{ color: '#ef4444', borderColor: '#ef4444' }}
                                        >
                                            전체 삭제
                                        </button>
                                    )}
                                </div>
                            </div>
                            <p className="description" style={{marginBottom: '1rem'}}>
                                대화 중 중요한 사건들이 자동으로 요약되어 벡터 데이터베이스에 저장됩니다. 
                                AI는 현재 대화와 유사도가 높은 과거의 기억을 자동으로 회상합니다.
                            </p>
                            
                            <div className="setting-group" style={{ marginBottom: '1.5rem', background: 'var(--bg-secondary)', padding: '1rem', borderRadius: '8px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                                    <label>회상 민감도 (RAG Threshold)</label>
                                    <span>{currentSettings.ragThreshold === 0 ? "0.0 (무조건 모두 회상)" : (currentSettings.ragThreshold ?? 0.0)}</span>
                                </div>
                                <input 
                                    type="range" 
                                    min="0.0" 
                                    max="0.95" 
                                    step="0.05" 
                                    value={currentSettings.ragThreshold ?? 0.0} 
                                    onChange={(e) => setCurrentSettings(prev => ({ ...prev, ragThreshold: parseFloat(e.target.value) }))} 
                                    style={{ width: '100%' }}
                                />
                                <p className="description" style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                                    <strong>0.0</strong>: 무조건 최근 장기 기억을 모두 가져옵니다 (권장).<br/>
                                    <strong>0.5 이상</strong>: 현재 상황과 유사성이 높은 기억만 선별하여 가져옵니다.
                                </p>
                            </div>

                            <div className="rag-list" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '400px', overflowY: 'auto' }}>
                                {(vectorMemory?.length || 0) > 0 ? (
                                    [...vectorMemory].sort((a, b) => b.timestamp - a.timestamp).map(chunk => (
                                        <div key={chunk.id} style={{ border: '1px solid var(--border-color)', padding: '0.75rem', borderRadius: '6px', fontSize: '0.9rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                            <div style={{ flex: 1, marginRight: '1rem' }}>
                                                <div style={{ color: 'var(--text-tertiary)', fontSize: '0.8rem', marginBottom: '0.25rem' }}>
                                                    {new Date(chunk.timestamp).toLocaleString()}
                                                </div>
                                                <div>{chunk.text}</div>
                                            </div>
                                            <button 
                                                onClick={() => handleDeleteVectorMemory(chunk.id)}
                                                style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '4px' }}
                                                title="삭제"
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    ))
                                ) : (
                                    <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                                        아직 저장된 장기 기억이 없습니다. 대화를 진행하면 자동으로 생성됩니다.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'system' && (
                        <div className="settings-section">
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                                <h4>🎭 역할 정의 (Role Definition)</h4>
                                <button 
                                    className="action-button" 
                                    onClick={() => {
                                        setCurrentSettings(prev => ({
                                            ...prev,
                                            roleDefinition: DEFAULT_ROLE_DEFINITION,
                                            outputContract: DEFAULT_OUTPUT_CONTRACT,
                                            thinkingModeInstructions: DEFAULT_THINKING_MODE_INSTRUCTIONS
                                        }));
                                    }}
                                    style={{ fontSize: '0.8rem', padding: '4px 8px' }}
                                >
                                    🔄 최신 버전으로 초기화
                                </button>
                            </div>
                            <textarea 
                                rows={4}
                                value={currentSettings.roleDefinition || ''}
                                onChange={(e) => setCurrentSettings(prev => ({ ...prev, roleDefinition: e.target.value }))}
                                placeholder="AI의 역할과 목적을 정의합니다."
                            />
                            
                            <h4 style={{marginTop: '1rem'}}>📜 출력 계약 (Output Contract)</h4>
                            <textarea 
                                rows={6}
                                value={currentSettings.outputContract || ''}
                                onChange={(e) => setCurrentSettings(prev => ({ ...prev, outputContract: e.target.value }))}
                                placeholder="응답 형식, 대화 규칙 등을 정의합니다."
                            />

                            <h4 style={{marginTop: '1rem'}}>🕹️ 사고 모드 규칙 (Thinking Protocol)</h4>
                            <div className="tab-buttons">
                                {(Object.keys(DEFAULT_THINKING_MODE_INSTRUCTIONS) as ThinkingMode[]).map(mode => (
                                    <button key={mode} className={`tab-button ${activeInstructionTab === mode ? 'active' : ''}`} onClick={() => setActiveInstructionTab(mode)}>
                                        {instructionTabLabels[mode]}
                                    </button>
                                ))}
                            </div>
                            <textarea
                                rows={6}
                                value={currentSettings.thinkingModeInstructions[activeInstructionTab]}
                                onChange={handleInstructionChange}
                                style={{marginTop: '0.5rem'}}
                            />
                        </div>
                    )}

                    {activeTab === 'model' && (
                        <div className="settings-section">
                            <div className="slider-group">
                                <label htmlFor="provider">생성 엔진</label>
                                <select
                                    id="provider"
                                    value={currentSettings.provider}
                                    onChange={(e) => setCurrentSettings(prev => ({ ...prev, provider: e.target.value as ChatProvider }))}
                                    className="chat-title-input"
                                    style={{padding: '8px'}}
                                >
                                    <option value="gemini">Gemini (키 필요)</option>
                                    <option value="openrouter">OpenRouter (키 하나로 여러 모델)</option>
                                    <option value="claude">Claude 구독 (PC 전용, 키 불필요)</option>
                                </select>
                                <p className="description" style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                                    {currentSettings.provider === 'claude'
                                        ? 'PC에서 실행 중인 개발 서버를 거쳐 Claude 로그인 자격으로 생성합니다. 서버가 필요해 폰 단독으로는 쓸 수 없습니다.'
                                        : currentSettings.provider === 'openrouter'
                                            ? '브라우저에서 OpenRouter를 직접 호출합니다. 서버가 필요 없어 폰에서도 그대로 동작합니다.'
                                            : '브라우저에서 Gemini API를 직접 호출합니다.'}
                                </p>
                            </div>

                            <div className="setting-group" style={{ marginBottom: '1.5rem', background: 'var(--bg-secondary)', padding: '1rem', borderRadius: '8px' }}>
                                <h4 style={{ marginTop: 0 }}>🔑 API 키</h4>
                                <p className="description" style={{ fontSize: '0.8rem', marginBottom: '0.75rem' }}>
                                    이 브라우저에만 저장되며 서버로 전송되지 않습니다. 모든 채팅방이 함께 씁니다.
                                </p>

                                <label htmlFor="geminiKey" style={{ fontSize: '0.85rem' }}>
                                    Gemini 키 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">발급받기</a>
                                </label>
                                <input
                                    id="geminiKey" type="password" className="chat-title-input" autoComplete="off"
                                    placeholder="AIza..." value={draftKeys.gemini}
                                    onChange={e => setDraftKeys(prev => ({ ...prev, gemini: e.target.value }))}
                                    style={{ width: '100%', marginBottom: '0.75rem' }}
                                />

                                <label htmlFor="openRouterKey" style={{ fontSize: '0.85rem' }}>
                                    OpenRouter 키 <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">발급받기</a>
                                </label>
                                <input
                                    id="openRouterKey" type="password" className="chat-title-input" autoComplete="off"
                                    placeholder="sk-or-..." value={draftKeys.openrouter}
                                    onChange={e => setDraftKeys(prev => ({ ...prev, openrouter: e.target.value }))}
                                    style={{ width: '100%' }}
                                />
                                <p className="description" style={{ fontSize: '0.78rem', marginTop: '0.5rem' }}>
                                    Gemini 키는 장기 기억·로어북의 유사도 검색에도 쓰입니다. 다른 엔진을 쓰더라도
                                    그 기능을 켜려면 필요합니다 (기본 설정에서는 꺼져 있어 없어도 됩니다).
                                </p>
                            </div>

                            {currentSettings.provider === 'openrouter' ? (
                                <div className="slider-group">
                                    <label htmlFor="openRouterModel">OpenRouter 모델</label>
                                    <select
                                        id="openRouterModel"
                                        value={currentSettings.openRouterModel}
                                        onChange={(e) => setCurrentSettings(prev => ({ ...prev, openRouterModel: e.target.value }))}
                                        className="chat-title-input"
                                        style={{padding: '8px'}}
                                    >
                                        {OPENROUTER_MODELS.map(m => (
                                            <option key={m.id} value={m.id}>{m.label}</option>
                                        ))}
                                    </select>
                                    <p className="description" style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                                        모델별 가격은 <a href="https://openrouter.ai/models" target="_blank" rel="noopener noreferrer">openrouter.ai/models</a> 에서 확인하세요.
                                    </p>
                                </div>
                            ) : currentSettings.provider === 'claude' ? (
                                <div className="slider-group">
                                    <label htmlFor="claudeModel">Claude 모델</label>
                                    <select
                                        id="claudeModel"
                                        value={currentSettings.claudeModel}
                                        onChange={(e) => setCurrentSettings(prev => ({ ...prev, claudeModel: e.target.value }))}
                                        className="chat-title-input"
                                        style={{padding: '8px'}}
                                    >
                                        {CLAUDE_MODELS.map(m => (
                                            <option key={m.id} value={m.id}>{m.label}</option>
                                        ))}
                                    </select>
                                </div>
                            ) : (
                                <div className="slider-group">
                                    <label htmlFor="modelName">Gemini 모델</label>
                                    <select
                                        id="modelName"
                                        value={currentSettings.modelName}
                                        onChange={(e) => setCurrentSettings(prev => ({ ...prev, modelName: e.target.value }))}
                                        className="chat-title-input"
                                        style={{padding: '8px'}}
                                    >
                                        <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro (권장)</option>
                                        <option value="gemini-3-flash-preview">Gemini 3 Flash (빠름)</option>
                                        <option value="gemini-2.5-flash-image">Gemini 2.5 Flash Image</option>
                                    </select>
                                </div>
                            )}

                            {currentSettings.provider === 'claude' && (
                                <p className="description" style={{ marginBottom: '1rem', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                                    Claude에는 temperature·Top-P·페널티가 적용되지 않습니다. 아래 슬라이더는 Gemini 전용입니다.
                                </p>
                            )}
                            <div className="slider-group">
                                <label htmlFor="responseLength">응답 길이</label>
                                <select
                                    id="responseLength"
                                    value={currentSettings.responseLength}
                                    onChange={(e) => setCurrentSettings(prev => ({ ...prev, responseLength: e.target.value as ResponseLength }))}
                                    className="chat-title-input"
                                    style={{padding: '8px'}}
                                >
                                    <option value="short">짧게 (대사 위주, 절정에도 4문단까지)</option>
                                    <option value="normal">보통 (기본 2~4문단, 절정에 6~8문단)</option>
                                    <option value="long">길게 (기본 4~6문단, 절정에 10문단까지)</option>
                                </select>
                                <p className="description" style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                                    상황에 따라 길이를 조절하는 규칙은 출력 계약에 들어 있고, 이 설정은 그 기조를 위아래로 밉니다.
                                    출력 토큰이 입력보다 비싸므로 비용에 가장 크게 영향을 줍니다.
                                </p>
                            </div>
                            <div className="slider-group">
                                <label htmlFor="temperature"><span>온도 (창의성)</span> <span>{currentSettings.temperature.toFixed(2)}</span></label>
                                <input type="range" id="temperature" name="temperature" min="0" max="1" step="0.05" value={currentSettings.temperature} onChange={handleSliderChange} />
                            </div>
                            <div className="slider-group">
                                <label htmlFor="topP"><span>Top-P (단어 다양성)</span> <span>{currentSettings.topP.toFixed(2)}</span></label>
                                <input type="range" id="topP" name="topP" min="0" max="1" step="0.05" value={currentSettings.topP} onChange={handleSliderChange} />
                            </div>
                            <div className="slider-group">
                                <label htmlFor="presencePenalty"><span>Presence Penalty (XTC 에뮬레이션)</span> <span>{currentSettings.presencePenalty?.toFixed(2) || '0.00'}</span></label>
                                <input type="range" id="presencePenalty" name="presencePenalty" min="-2" max="2" step="0.1" value={currentSettings.presencePenalty || 0} onChange={handleSliderChange} />
                            </div>
                            <div className="slider-group">
                                <label htmlFor="frequencyPenalty"><span>Frequency Penalty (DRY 에뮬레이션)</span> <span>{currentSettings.frequencyPenalty?.toFixed(2) || '0.00'}</span></label>
                                <input type="range" id="frequencyPenalty" name="frequencyPenalty" min="-2" max="2" step="0.1" value={currentSettings.frequencyPenalty || 0} onChange={handleSliderChange} />
                            </div>
                            <div className="slider-group">
                                <label htmlFor="maxContextTurns"><span>최대 대화 기억 수 (Context Window)</span> <span>{currentSettings.maxContextTurns || 3}</span></label>
                                <input type="range" id="maxContextTurns" name="maxContextTurns" min="3" max="20" step="1" value={currentSettings.maxContextTurns || 3} onChange={handleSliderChange} />
                            </div>
                            <div className="slider-group">
                                <label htmlFor="ragThreshold"><span>장기 기억(RAG) 불러오기 민감도 (낮을수록 잘 불러옴, 0=무조건)</span> <span>{currentSettings.ragThreshold === 0 ? "0.00" : (currentSettings.ragThreshold?.toFixed(2) || 0.00)}</span></label>
                                <input type="range" id="ragThreshold" name="ragThreshold" min="0.0" max="0.9" step="0.05" value={currentSettings.ragThreshold ?? 0.0} onChange={handleSliderChange} />
                            </div>
                            
                            <div className="settings-section" style={{marginTop: '2rem'}}>
                                <h4>📋 시스템 프롬프트 미리보기</h4>
                                <details className="readonly-prompt-details">
                                    <summary>▼ 펼쳐보기</summary>
                                    <div className="readonly-prompt-content">
                                        {PromptEngine.buildSystemPrompt({ ...room, ...currentSettings } as ChatRoom)}
                                    </div>
                                </details>
                            </div>
                             <div className="settings-section">
                                <h4>🗂️ 데이터 관리</h4>
                                <button onClick={handleExportChat} className="modal-button secondary" style={{display: 'flex', alignItems: 'center', gap: '0.5rem'}}>
                                    <ExportIcon size={16} />
                                    현재 대화 내보내기
                                </button>
                            </div>
                        </div>
                    )}
                </div>
                <div className="modal-footer">
                    <button onClick={onClose} className="modal-button secondary">취소</button>
                    <button onClick={handleSave} className="modal-button primary">저장</button>
                </div>
            </div>
        </div>
    );
};
