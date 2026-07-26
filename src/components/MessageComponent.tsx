import React, { useMemo } from 'react';
import { Message, FilterSettings } from '../types';
import { EditIcon, DeleteIcon, RegenerateIcon } from './Icons';

type BlockType = 'text' | 'image';
interface Block {
    type: BlockType;
    content: React.ReactNode[] | string;
}

const AIMessageContent: React.FC<{ text: string, filterSettings: FilterSettings }> = ({ text, filterSettings }) => {
    const blocks = useMemo(() => { text = text || ""; 
        const regex = /(\【[\s\S]*?\】)|(\(감정: [\s\S]*?\))|(\([^)]*?속마음: [\s\S]*?\))|(\*[\s\S]*?\*)|(\[Scene:[\s\S]*?\])|(\[서술\]|\[환경 묘사\])|(\*\*\*[\s\S]*?\*\*\*)|(\*\*[\s\S]*?\*\*)|(https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp|svg)(?:\?[^\s]*)?)/gi;
        
        const finalBlocks: Block[] = [];
        let currentTextNodes: React.ReactNode[] = [];
        let lastIndex = 0;
        let match;

        const pushTextBlock = () => {
            if (currentTextNodes.length > 0) {
                finalBlocks.push({ type: 'text', content: [...currentTextNodes] });
                currentTextNodes = [];
            }
        };

        while ((match = regex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                const plainText = text.substring(lastIndex, match.index);
                if (plainText) currentTextNodes.push(plainText);
            }

            const [fullMatch, name, emotion, innerThought, italic, scene, narrationHeader, boldItalic, bold, imageUrl] = match;
            
            if (imageUrl) {
                pushTextBlock();
                finalBlocks.push({ type: 'image', content: imageUrl });
            } else {
                if (name) currentTextNodes.push(<strong key={match.index}>{name}</strong>);
                else if (emotion) currentTextNodes.push(<span key={match.index} className={`emotion-tag ${filterSettings.showEmotionTags ? '' : 'hidden'}`}>{emotion}</span>);
                else if (innerThought) currentTextNodes.push(<em key={match.index} className={`inner-thought ${filterSettings.showInnerThought ? '' : 'hidden'}`}>{innerThought}</em>);
                else if (scene) currentTextNodes.push(<span key={match.index} className={`scene-header ${filterSettings.showSceneHeaders ? '' : 'hidden'}`}>{scene}</span>);
                else if (narrationHeader) currentTextNodes.push(<span key={match.index} className={`narration ${filterSettings.showNarration ? '' : 'hidden'}`}>{narrationHeader}</span>);
                else if (boldItalic) currentTextNodes.push(<strong key={match.index} className="bold-italic-text"><em>{boldItalic.slice(3,-3)}</em></strong>);
                else if (bold) currentTextNodes.push(<strong key={match.index}>{bold.slice(2,-2)}</strong>);
                else if (italic) currentTextNodes.push(<em key={match.index}>{italic.slice(1,-1)}</em>);
                else currentTextNodes.push(fullMatch);
            }
            
            lastIndex = regex.lastIndex;
        }

        if (lastIndex < (text?.length || 0)) {
            const remainingText = text.substring(lastIndex);
            if (remainingText) {
                 currentTextNodes.push(
                    <span key={lastIndex} className={`narration ${filterSettings.showNarration ? '' : 'hidden'}`}>
                        {remainingText}
                    </span>
                 );
            }
        }
        
        pushTextBlock();
        return finalBlocks;
    }, [text, filterSettings]);
    
    return (
        <div className="message-stack">
            {blocks.map((block, index) => {
                if (block.type === 'image') {
                    return (
                        <img 
                            key={index} 
                            src={block.content as string} 
                            alt="AI Content" 
                            className="message-image-standalone"
                            onClick={() => window.open(block.content as string, '_blank')}
                        />
                    );
                } else {
                    return (
                        <div key={index} className="message-bubble">
                            <div className="message-content">
                                {(block.content as React.ReactNode[]).map((node, i) => <React.Fragment key={i}>{node}</React.Fragment>)}
                            </div>
                        </div>
                    );
                }
            })}
        </div>
    );
};

interface MessageComponentProps {
    message: Message;
    isEditing: boolean;
    editingText: string;
    onEditingTextChange: (text: string) => void;
    onSaveEdit: (id: string) => void;
    onCancelEdit: () => void;
    onStartEdit: (message: Message) => void;
    onDelete: (id: string) => void;
    onRegenerate: (id: string) => void;
    filterSettings: FilterSettings;
}

export const MessageComponent: React.FC<MessageComponentProps> = React.memo(({ message, isEditing, editingText, onEditingTextChange, onSaveEdit, onCancelEdit, onStartEdit, onDelete, onRegenerate, filterSettings }) => {
    const [showContext, setShowContext] = React.useState(false);

    return (
        <div className={`message ${message.sender}`}>
             {isEditing ? (
                <div className="message-bubble message-editor">
                    <textarea 
                        className="message-editor-textarea"
                        value={editingText}
                        onChange={(e) => onEditingTextChange(e.target.value)}
                    />
                    <div className="message-editor-actions">
                        <button className="editor-button cancel" onClick={onCancelEdit}>취소</button>
                        <button className="editor-button save" onClick={() => onSaveEdit(message.id)}>저장</button>
                    </div>
                </div>
            ) : (
                <>
                    {message.sender === 'ai' && message.thinking && filterSettings.showThinking && (
                        <div className="thinking-block">
                            <h4>🧠 사고 과정</h4>
                            <pre>{message.thinking}</pre>
                        </div>
                    )}
                    {message.sender === 'ai' && message.memoryUpdate && filterSettings.showMemoryUpdates && (
                        <div className="storage-update-block">
                            <h4>💾 메모리 변경 내역</h4>
                            <pre>{message.memoryUpdate}</pre>
                        </div>
                    )}
                    {message.sender === 'ai' && showContext && (
                        <div className="context-block" style={{ fontSize: '0.8rem', background: 'var(--bg-secondary)', padding: '0.75rem', borderRadius: '8px', marginBottom: '0.5rem', border: '1px solid var(--border-color)' }}>
                            <h4 style={{ margin: '0 0 0.5rem 0', color: 'var(--text-secondary)' }}>🔍 주입된 컨텍스트 (디버그)</h4>
                            
                            {message.ragContext && message.ragContext.length > 0 && (
                                <div style={{ marginBottom: '0.5rem' }}>
                                    <strong style={{ color: 'var(--text-primary)' }}>🕰️ 회상된 장기 기억:</strong>
                                    <ul style={{ margin: '0.25rem 0 0 1rem', padding: 0, color: 'var(--text-tertiary)' }}>
                                        {message.ragContext.map((ctx, i) => <li key={i}>{ctx}</li>)}
                                    </ul>
                                </div>
                            )}
                            
                            {message.lorebookContext && (message.lorebookContext.high?.length > 0 || message.lorebookContext.mid?.length > 0 || message.lorebookContext.low?.length > 0) && (
                                <div>
                                    <strong style={{ color: 'var(--text-primary)' }}>📚 활성화된 로어북:</strong>
                                    <ul style={{ margin: '0.25rem 0 0 1rem', padding: 0, color: 'var(--text-tertiary)' }}>
                                        {message.lorebookContext.high?.map((ctx, i) => <li key={`high-${i}`}>[High] {ctx}</li>)}
                                        {message.lorebookContext.mid?.map((ctx, i) => <li key={`mid-${i}`}>[Mid] {ctx}</li>)}
                                        {message.lorebookContext.low?.map((ctx, i) => <li key={`low-${i}`}>[Low] {ctx}</li>)}
                                    </ul>
                                </div>
                            )}

                            {(!message.ragContext?.length && !message.lorebookContext?.high?.length && !message.lorebookContext?.mid?.length && !message.lorebookContext?.low?.length) && (
                                <div style={{ color: 'var(--text-tertiary)' }}>주입된 추가 컨텍스트가 없습니다.</div>
                            )}
                        </div>
                    )}
                    
                    <div className="message-toolbar">
                            {message.sender === 'user' && <button className="toolbar-button" onClick={() => onStartEdit(message)}><EditIcon /></button>}
                            {message.sender === 'ai' && <button className="toolbar-button" onClick={() => setShowContext(!showContext)} title="컨텍스트 보기">🔍</button>}
                            {message.sender === 'ai' && <button className="toolbar-button" onClick={() => onRegenerate(message.id)}><RegenerateIcon /></button>}
                            {message.sender === 'ai' && <button className="toolbar-button" onClick={() => onStartEdit(message)}><EditIcon /></button>}
                            <button className="toolbar-button" onClick={() => onDelete(message.id)}><DeleteIcon /></button>
                    </div>

                    {message.sender === 'ai' ? (
                        <AIMessageContent text={message.text} filterSettings={filterSettings} />
                    ) : (
                        <div className="message-bubble">
                            <div className="message-text">{message.text}</div>
                        </div>
                    )}
                </>
            )}
            <div className="message-meta">
                <span>{new Date(message.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span>
                {message.status === 'edited' && !isEditing && <span className="message-status">(수정됨)</span>}
            </div>
        </div>
    );
});
