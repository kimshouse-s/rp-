import React, { useRef, useEffect } from 'react';
import { ChatRoom } from '../types';
import { ImportIcon, EmptyChatIcon, EditIcon, DeleteIcon } from './Icons';

interface ChatListViewProps {
    chatRooms: ChatRoom[];
    activeChatId: string | null;
    onSelectChat: (id: string) => void;
    onNewChat: () => void;
    onDeleteChat: (id: string) => void;
    onEditTitle: (id: string, title: string) => void;
    isEditingTitle: string | null;
    editingTitleText: string;
    onSaveTitle: (id: string) => void;
    onTitleInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onTitleInputKeyDown: (e: React.KeyboardEvent<HTMLInputElement>, id: string) => void;
    isDarkMode: boolean;
    toggleTheme: () => void;
    onImportChat: (event: React.ChangeEvent<HTMLInputElement>) => void;
    onImportCharacterCard: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

export const ChatListView: React.FC<ChatListViewProps> = (props) => {
    const { chatRooms, activeChatId, onSelectChat, onNewChat, onDeleteChat, onEditTitle, isEditingTitle, editingTitleText, onSaveTitle, onTitleInputChange, onTitleInputKeyDown, isDarkMode, toggleTheme, onImportChat, onImportCharacterCard } = props;
    const editInputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const cardInputRef = useRef<HTMLInputElement>(null);
    
    useEffect(() => {
        if (isEditingTitle && editInputRef.current) {
            editInputRef.current.focus();
            editInputRef.current.select();
        }
    }, [isEditingTitle]);

    return (
        <div className="chat-list-view">
            <div className="chat-list-header">
                <h1 className="chat-list-title">채팅 목록</h1>
                <div className="header-buttons">
                    <button className="import-button" onClick={() => fileInputRef.current?.click()}>
                        <ImportIcon size={14}/> 가져오기
                    </button>
                    <input type="file" ref={fileInputRef} onChange={onImportChat} style={{ display: 'none' }} accept=".json" />
                    <button className="import-button" onClick={() => cardInputRef.current?.click()} title="캐릭터 카드 PNG(V2/V3)를 불러옵니다">
                        <ImportIcon size={14}/> 캐릭터 카드
                    </button>
                    <input type="file" ref={cardInputRef} onChange={onImportCharacterCard} style={{ display: 'none' }} accept=".png" />
                    <button className="new-chat-button" onClick={onNewChat}>+ 새 채팅</button>
                </div>
            </div>
            <div className="chat-list">
                {(chatRooms?.length || 0) === 0 ? (
                    <div className="empty-chat-list">
                        <EmptyChatIcon />
                        <h3>채팅방이 없습니다</h3>
                        <p>'새 채팅'을 눌러 대화를 시작하세요.</p>
                        <div className="card-sources">
                            <p><strong>또는 캐릭터 카드를 받아서 '캐릭터 카드' 버튼으로 불러오세요.</strong></p>
                            <p>PNG 파일을 그대로 넣으면 됩니다. 설정·첫 인사말·로어북까지 같이 들어옵니다.</p>
                            <ul>
                                <li><a href="https://chub.ai" target="_blank" rel="noopener noreferrer">chub.ai</a> — 가장 큼. 태그·필터가 잘 되어 있음</li>
                                <li><a href="https://www.characterhub.org" target="_blank" rel="noopener noreferrer">characterhub.org</a> — chub의 다른 주소</li>
                                <li><a href="https://janitorai.com" target="_blank" rel="noopener noreferrer">janitorai.com</a> — 카드 내려받기를 지원하는 항목만 가능</li>
                                <li><a href="https://risuai.net" target="_blank" rel="noopener noreferrer">risuai.net</a> — RisuAI 공유 카드</li>
                            </ul>
                            <p className="card-sources-note">
                                각 사이트에서 <strong>Download</strong> 또는 <strong>카드 내려받기</strong>로 받은 PNG를 쓰세요.
                                이미지만 저장하면 설정이 안 들어 있어 불러오지 못합니다.
                            </p>
                        </div>
                    </div>
                ) : (
                    (chatRooms || []).map(room => (
                        <div key={room.id} className={`chat-item ${room.id === activeChatId ? 'active' : ''}`} onClick={() => onSelectChat(room.id)}>
                            {isEditingTitle === room.id ? (
                                <input
                                    ref={editInputRef}
                                    type="text"
                                    className="chat-title-input"
                                    value={editingTitleText}
                                    onChange={onTitleInputChange}
                                    onKeyDown={(e) => onTitleInputKeyDown(e, room.id)}
                                    onBlur={() => onSaveTitle(room.id)}
                                    onClick={(e) => e.stopPropagation()}
                                />
                            ) : (
                                <>
                                    <span className="chat-item-title">{room.title}</span>
                                    <div className="chat-item-actions">
                                        <button className="action-button" onClick={(e) => { e.stopPropagation(); onEditTitle(room.id, room.title); }}><EditIcon size={14} /></button>
                                        <button className="action-button" onClick={(e) => { e.stopPropagation(); onDeleteChat(room.id); }}><DeleteIcon size={14} /></button>
                                    </div>
                                </>
                            )}
                        </div>
                    ))
                )}
            </div>
            <div className="chat-list-footer">
                <div className="theme-switcher">
                    <span className="icon">☀️</span>
                    <label className="switch">
                        <input type="checkbox" checked={isDarkMode} onChange={toggleTheme} />
                        <span className="slider round"></span>
                    </label>
                    <span className="icon">🌙</span>
                </div>
            </div>
        </div>
    );
};
