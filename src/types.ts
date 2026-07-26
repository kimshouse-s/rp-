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
}

export interface Snapshot {
    messageId: string;
    memory: MemorySlots; 
}

export type ThinkingMode = 'none' | 'simple' | 'deep';
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
}

export interface VectorMemoryChunk {
    id: string;
    text: string; // The rephrased, standalone fact
    embedding: number[]; // The vector embedding
    timestamp: number;
    accessCount?: number; // For reinforcement
    lastAccessed?: number; // For decay calculation
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
    modelName: string;
    ragThreshold?: number; // New field for RAG threshold
    maxContextTurns?: number; // New field for context window limit
}
