import { MemorySlots, LorebookEntry, isMemoryTextSlot } from '../types';

/**
 * Memory Manager
 * Handles the logic for parsing and applying memory updates from the AI.
 * Implements "Context Folding" by managing Short-term vs Long-term episodes.
 */
export class MemoryManager {
    
    /**
     * Parses the AI response for <mem-update> tags and applies them to the current memory.
     */
    public static applyUpdates(currentMemory: MemorySlots, currentLorebook: LorebookEntry[] | undefined, responseText: string, sourceMessageId?: string): { newMemory: MemorySlots, newLorebook: LorebookEntry[], updateLog: string } {
        const regex = /<mem-update\s+([^>]+)>([\s\S]*?)<\/mem-update>/gi;
        let match;
        let newMemory: MemorySlots = { persona: '', scenario: '', user_persona: '', state: '', short_term_memory: '', planning: '', ...currentMemory };
        let newLorebook = [...(currentLorebook || [])];
        let updateLog = '';

        while ((match = regex.exec(responseText)) !== null) {
            const attrString = match[1];
            const content = match[2].trim();
            
            const catMatch = attrString.match(/category="([^"]+)"/i);
            const modeMatch = attrString.match(/mode="([^"]+)"/i);
            
            if (catMatch && modeMatch) {
                const category = catMatch[1];
                const mode = modeMatch[1];
                if (isMemoryTextSlot(category) && newMemory[category] !== undefined) {
                    newMemory[category] = this.patchMemory(newMemory[category], content, mode);
                    updateLog += `[${category}] (${mode})\n${content}\n\n`;
                }
            }
        }

        const loreRegex = /<lorebook-update\s+([^>]+)>([\s\S]*?)<\/lorebook-update>/gi;
        while ((match = loreRegex.exec(responseText)) !== null) {
            const attrString = match[1];
            const content = match[2].trim();
            
            const actionMatch = attrString.match(/action="([^"]+)"/i);
            const keysMatch = attrString.match(/keys="([^"]+)"/i);
            const depthMatch = attrString.match(/depth="([^"]+)"/i);
            
            if (!actionMatch || !keysMatch) continue;
            
            const action = actionMatch[1].toLowerCase(); // 'add', 'update', or 'delete'
            const keys = keysMatch[1].split(',').map(k => k.trim()).filter(k => k.length > 0);
            
            let depth = depthMatch ? depthMatch[1].toLowerCase() as 'high' | 'mid' | 'low' : 'mid';
            if (!['high', 'mid', 'low'].includes(depth)) {
                depth = 'mid';
            }

            if (action === 'delete') {
                const initialLength = newLorebook.length;
                newLorebook = this.removeLorebookEntries(newLorebook, keys);
                if (newLorebook.length < initialLength) {
                    updateLog += `[Lorebook Deleted] Keys: ${keys.join(', ')}\n\n`;
                }
            } else if (action === 'add' || action === 'update') {
                const result = this.upsertLorebookEntry(newLorebook, { keys, content, depth, sourceMessageId });
                newLorebook = result.lorebook;
                const label = result.action === 'updated' ? 'Updated' : 'Added';
                updateLog += `[Lorebook ${label}] Keys: ${keys.join(', ')}\n${content}\n\n`;
            }
        }

        return { newMemory, newLorebook, updateLog };
    }

    /**
     * 로어북에 엔트리를 추가하거나, 키가 겹치는 기존 엔트리 하나를 갱신한다.
     *
     * 키가 하나라도 겹치는 엔트리를 전부 지우던 기존 동작은 데이터 손실이 크다.
     * 예를 들어 keys=["왕국"]인 엔트리를 새로 넣으면 "왕국"을 키로 가진 다른 엔트리가
     * 모두 사라졌다. 여기서는 첫 번째로 겹치는 엔트리만 갱신하고 나머지는 보존한다.
     */
    public static upsertLorebookEntry(
        lorebook: LorebookEntry[],
        entry: {
            keys: string[];
            content: string;
            depth: 'high' | 'mid' | 'low';
            embedding?: number[];
            sourceMessageId?: string;
        }
    ): { lorebook: LorebookEntry[]; action: 'added' | 'updated' } {
        const keySet = new Set(entry.keys.map(k => k.toLowerCase()));
        const index = lorebook.findIndex(e => e.keys.some(k => keySet.has(k.toLowerCase())));

        if (index >= 0) {
            const next = [...lorebook];
            next[index] = {
                ...next[index],
                keys: Array.from(new Set([...next[index].keys, ...entry.keys])),
                content: entry.content,
                depth: entry.depth,
                embedding: entry.embedding ?? next[index].embedding,
                sourceMessageId: entry.sourceMessageId ?? next[index].sourceMessageId,
            };
            return { lorebook: next, action: 'updated' };
        }

        return {
            lorebook: [...lorebook, {
                id: `lore_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                keys: entry.keys,
                content: entry.content,
                depth: entry.depth,
                embedding: entry.embedding,
                probability: 100,
                recursable: false,
                sourceMessageId: entry.sourceMessageId,
            }],
            action: 'added',
        };
    }

    /** 키가 겹치는 엔트리를 제거한다. delete 액션 전용. */
    public static removeLorebookEntries(lorebook: LorebookEntry[], keys: string[]): LorebookEntry[] {
        const keySet = new Set(keys.map(k => k.toLowerCase()));
        return lorebook.filter(e => !e.keys.some(k => keySet.has(k.toLowerCase())));
    }

    /**
     * Applies the specific patch logic based on the mode.
     */
    private static patchMemory(original: string, update: string, mode: string): string {
        if (mode === 'overwrite') {
            return update;
        }
        
        if (mode === 'append') {
            return original ? `${original}\n\n${update}` : update;
        }

        if (mode === 'patch') {
            // Try JSON merge first
            try {
                const cleanOrig = original.replace(/```json\n?/g, '').replace(/```/g, '').trim();
                const cleanUpdate = update.replace(/```json\n?/g, '').replace(/```/g, '').trim();
                const origJson = JSON.parse(cleanOrig);
                const updateJson = JSON.parse(cleanUpdate);
                if (typeof origJson === 'object' && origJson !== null && typeof updateJson === 'object' && updateJson !== null) {
                    return JSON.stringify({ ...origJson, ...updateJson }, null, 2);
                }
            } catch (e) {
                // Not JSON, fall through to smart patch
            }

            // Smart Patching for [[Header]] blocks
            return this.smartPatch(original, update);
        }

        return original;
    }

    /**
     * Smart Patch logic (ported and improved from original index.tsx)
     */
    private static smartPatch(original: string, update: string): string {
        const origStr = typeof original === 'string' ? original : String(original || '');
        const updateStr = typeof update === 'string' ? update : String(update || '');

        if (!updateStr.includes('[[') && !updateStr.includes('->')) {
            return origStr ? `${origStr}\n\n${updateStr}` : updateStr;
        }

        const blockRegex = /(\[\[.*?\]\])([\s\S]*?)(?=(\[\[|$))/gi;
        const originalMap = new Map<string, string>();
        
        let preText = '';
        const firstMatch = origStr.search(blockRegex);
        if (firstMatch > 0) {
            preText = origStr.substring(0, firstMatch);
        } else if (firstMatch === -1 && origStr.trim()) {
            preText = origStr;
        }

        const originalMatches = [...origStr.matchAll(blockRegex)];
        originalMatches.forEach(m => {
            originalMap.set(m[1].trim(), m[0].trim());
        });

        const updateMatches = [...updateStr.matchAll(blockRegex)];
        updateMatches.forEach(m => {
            const header = m[1].trim();
            const content = m[0].trim();
            originalMap.set(header, content);
        });

        let result = preText.trim();
        originalMap.forEach(content => {
            if (result) result += '\n\n';
            result += content;
        });

        return result;
    }

    /**
     * Parses the custom prompt to extract initial memory slots.
     * This allows users to configure the world and character by editing the custom prompt text.
     */
    public static parsePromptToMemory(prompt: string): Partial<MemorySlots> {
        const memory: Partial<MemorySlots> = {};
        
        // Helper to extract content between headers
        const extractSection = (headerRegex: RegExp): string | undefined => {
            const match = prompt.match(headerRegex);
            if (!match) return undefined;
            
            const startIndex = match.index! + match[0].length;
            // Find the next header (## number. or ---)
            // We search for the next section header or the end of the data protocol section
            const nextMatch = prompt.substring(startIndex).match(/(\n## \d+\.|---)/);
            
            const endIndex = nextMatch ? startIndex + nextMatch.index! : prompt.length;
            return prompt.substring(startIndex, endIndex).trim();
        };

        // 1. Persona
        const personaContent = extractSection(/## 1\. \[(persona|core_identity)\][^\n]*/);
        if (personaContent) memory.persona = personaContent;

        // 2. Scenario
        const scenarioContent = extractSection(/## 2\. \[(scenario|blueprint)\][^\n]*/);
        if (scenarioContent) memory.scenario = scenarioContent;

        // 3. User Persona
        const userPersonaContent = extractSection(/## 3\. \[(user_persona|user_req)\][^\n]*/);
        if (userPersonaContent) memory.user_persona = userPersonaContent;

        // 4. State
        const stateContent = extractSection(/## 4\. \[(state|current_state)\][^\n]*/);
        if (stateContent) memory.state = stateContent;

        // 5. Episode
        const episodeContent = extractSection(/## 5\. \[short_term_memory\][^\n]*/);
        if (episodeContent) memory.short_term_memory = episodeContent;

        // 6. Planning
        const planningContent = extractSection(/## 6\. \[planning\][^\n]*/);
        if (planningContent) memory.planning = planningContent;

        return memory;
    }
}
