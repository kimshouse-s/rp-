import React, { useState } from 'react';
import { MemorySlots } from '../types';

export const MemoryViewerModal: React.FC<{ memory: MemorySlots, onClose: () => void }> = ({ memory, onClose }) => {
    const [activeTab, setActiveTab] = useState<keyof MemorySlots>('persona');

    const tabs: {id: keyof MemorySlots, label: string}[] = [
        { id: 'persona', label: '1. 페르소나 (Persona)' },
        { id: 'scenario', label: '2. 시나리오 (Scenario)' },
        { id: 'user_persona', label: '3. 유저 설정 (User Persona)' },
        { id: 'state', label: '4. 현재 상태 (Dynamic State)' },
        { id: 'short_term_memory', label: '5. 단기 기억 (Short-term)' },
        { id: 'planning', label: '6. 계획 (Planning)' },
    ];

    return (
        <div className="modal-backdrop">
            <div className="modal-content">
                <div className="modal-header">
                    <h3>🧠 현재 메모리 상태</h3>
                    <button onClick={onClose} className="close-button">&times;</button>
                </div>
                <div className="modal-body">
                    <div className="tab-buttons" style={{marginBottom: '1rem', flexWrap: 'wrap', gap: '4px'}}>
                        {tabs.map(tab => (
                            <button
                                key={tab.id}
                                className={`tab-button ${activeTab === tab.id ? 'active' : ''}`}
                                onClick={() => setActiveTab(tab.id)}
                                style={{flex: '1 0 30%'}}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>
                    <div className="memory-content">
                        {memory[activeTab] && memory[activeTab].trim().length > 0 ? (
                            <pre className="storage-update-block" style={{marginTop: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all'}}>
                                {memory[activeTab]}
                            </pre>
                        ) : (
                            <p style={{color: 'var(--text-secondary)', fontStyle: 'italic', padding: '1rem', textAlign: 'center'}}>
                                (이 구획은 아직 비어있습니다)
                            </p>
                        )}
                    </div>
                </div>
                 <div className="modal-footer">
                    <button onClick={onClose} className="modal-button primary">닫기</button>
                </div>
            </div>
        </div>
    );
};
